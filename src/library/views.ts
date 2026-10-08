import { ensure_env_loaded, read_env } from "./env.js"
import { from_base64url, to_base64url } from "./encoding.js"
import { PostboiError } from "./errors.js"

/**
 * Web versions of emails, hosted by Postboi: publish an email's HTML once, then link
 * readers to it from any email, whoever sends it.
 *
 * ```ts
 * import { views } from "postboi"
 *
 * await views.publish({ slug: "welcome", html })
 * const link = await views.url("welcome", { first_name: "Ada" }, { expires: 60 * 60 * 24 * 30 })
 * ```
 *
 * Reader data travels in a sealed token (`?s=`): AES-GCM under the team's view key, bound
 * to the slug, so a link can't be edited or replayed against another view. With
 * `POSTBOI_VIEW_KEY` in the environment (`postboi sync` writes it) the token is minted
 * here, with no request, which is what a send loop wants. Without it, Postboi mints it.
 */

/** A public, typed query param on a view. Never free text: anyone can edit a URL. */
export type ParamSpec =
	| { path: string; type: "integer"; min?: number; max?: number }
	| { path: string; type: "date" }
	| { path: string; type: "enum"; values: Array<string> }

/** A published view, as the API answers it. */
export interface View {
	slug: string
	/** The page on Postboi's view host, `https://view.postboi.app/<account>/<slug>`. */
	url: string
	/** The same page on the team's own `view.<domain>`, when it has one. */
	custom_url?: string
	version: number
	versions?: Array<{ version: number; created_at: string }>
	/** The template paths found in the HTML. */
	variables: Array<string>
	params: Record<string, ParamSpec>
	/** Which fields a feed call may carry, and the template path each one fills. */
	feed?: { fields: Record<string, string> }
	syntax: "liquid" | "none"
	created_at: string
	updated_at: string
	disabled?: boolean
}

export interface PublishOptions {
	/** `[a-z0-9-]`, up to 64 characters, unique in the team. */
	slug: string
	html: string
	/** Static data the template reads, merged under each reader's data. */
	context?: Record<string, unknown>
	params?: Record<string, ParamSpec>
	feed?: { fields: Record<string, string> }
	syntax?: "liquid" | "none"
}

/** Where the views API is and who is asking. Every field defaults from the environment. */
export interface ViewClientOptions {
	/** API token. Defaults to `POSTBOI_TOKEN`. */
	token?: string
	/** API base. Defaults to `POSTBOI_API_URL` or `https://postboi.app`. */
	api?: string
	/** The fetch to use. Defaults to the platform's. */
	fetch?: typeof globalThis.fetch
}

export interface SealOptions extends ViewClientOptions {
	/**
	 * When the link stops carrying the reader's data: a `Date`, or seconds from now. After
	 * it the page still opens, as the generic version.
	 */
	expires?: Date | number
	/** The view key. Defaults to `POSTBOI_VIEW_KEY`, and to asking Postboi when there is none. */
	key?: string
}

export interface UrlOptions extends SealOptions {
	/**
	 * Where the team's views live: `https://view.example.com` or
	 * `https://view.postboi.app/<account>`. Defaults to `POSTBOI_VIEW_URL`, else the view's
	 * own `custom_url` or `url`, asked of the API once per slug.
	 */
	base?: string
}

const encoder = new TextEncoder()

/**
 * Split a view key into its id and its 32 secret bytes. The format is
 * `pbv_<id>_<base64url secret>`; during a rotation the variable may hold two keys
 * separated by whitespace, and the first one seals.
 */
export function parse_view_key(value: string): { id: string; secret: Uint8Array<ArrayBuffer> } {
	const first = value.trim().split(/\s+/)[0]
	const match = /^pbv_([A-Za-z0-9]+)_([A-Za-z0-9_-]+)$/.exec(first)
	let secret: Uint8Array<ArrayBuffer> | undefined
	try {
		secret = match ? from_base64url(match[2]) : undefined
	} catch {
		// Not base64url: refused below like any other malformed key.
	}
	if (!match || secret?.length !== 32) {
		throw new PostboiError({
			provider: "postboi",
			code: "invalid_view_key",
			message:
				"POSTBOI_VIEW_KEY isn't a view key (pbv_<id>_<secret>). Run `postboi sync` to pull the team's key.",
		})
	}
	return { id: match[1], secret }
}

/** Unix seconds for an expiry given as a Date or as seconds from now. */
function expiry_seconds(expires: Date | number | undefined): number | undefined {
	if (expires === undefined) return undefined
	return typeof expires === "number"
		? Math.floor(Date.now() / 1000) + Math.round(expires)
		: Math.floor(expires.getTime() / 1000)
}

/**
 * Seal reader data for one view, locally. The token is
 * `v1.<key_id>.<base64url iv>.<base64url ciphertext>`: AES-256-GCM with a random 12-byte
 * iv, the slug as additional data, and the UTF-8 JSON `{ "d": data, "e": unix seconds }`
 * as plaintext (`e` left out when it never expires). The ciphertext carries the 16-byte tag
 * on its end, as WebCrypto writes it.
 */
export async function seal_token(
	key: string,
	slug: string,
	data: unknown,
	expires?: Date | number
): Promise<string> {
	const { id, secret } = parse_view_key(key)
	const crypto_key = await crypto.subtle.importKey("raw", secret, "AES-GCM", false, ["encrypt"])
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const e = expiry_seconds(expires)
	const plaintext = encoder.encode(JSON.stringify(e === undefined ? { d: data } : { d: data, e }))
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: encoder.encode(slug) },
		crypto_key,
		plaintext
	)
	return `v1.${id}.${to_base64url(iv)}.${to_base64url(new Uint8Array(sealed))}`
}

/**
 * A call to `/v1/views…`. A bare 404 (no JSON code) means the server predates views, and
 * says so rather than "not found".
 */
async function call<T>(
	path: string,
	init: { method?: string; body?: unknown },
	options: ViewClientOptions
): Promise<T> {
	await ensure_env_loaded()
	const token = options.token ?? read_env("POSTBOI_TOKEN")
	if (!token) {
		throw new PostboiError({
			provider: "postboi",
			code: "no_token",
			message:
				"Views need a Postboi token. Run `bunx postboi init`, set POSTBOI_TOKEN, or pass { token }.",
		})
	}
	const api = (options.api ?? read_env("POSTBOI_API_URL") ?? "https://postboi.app").replace(
		/\/$/,
		""
	)
	const response = await (options.fetch ?? fetch)(`${api}/v1/views${path}`, {
		method: init.method ?? "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
	})
	const data = (await response.json().catch(() => undefined)) as
		| (T & { message?: string; code?: string })
		| undefined
	if (!response.ok) {
		const missing = response.status === 404 && !data?.code
		throw new PostboiError({
			provider: "postboi",
			status: response.status,
			code: missing ? "views_unavailable" : (data?.code ?? `http_${response.status}`),
			message: missing
				? "This Postboi server doesn't host views yet. Try again after the next deploy."
				: (data?.message ?? `The views API answered ${response.status}.`),
			raw: data,
		})
	}
	return data as T
}

const bases = new Map<string, string>()

/** The view's page with no reader data: the base from options or env, else the API's answer. */
async function page_url(slug: string, options: UrlOptions): Promise<string> {
	const base = options.base ?? read_env("POSTBOI_VIEW_URL")
	if (base) return `${base.replace(/\/$/, "")}/${encodeURIComponent(slug)}`
	let url = bases.get(slug)
	if (!url) {
		const view = await call<View>(`/${encodeURIComponent(slug)}`, {}, options)
		url = view.custom_url ?? view.url
		bases.set(slug, url)
	}
	return url
}

/** Seconds until an expiry, for the API's `expires_in`. */
function expires_in(expires: Date | number | undefined): number | undefined {
	const e = expiry_seconds(expires)
	return e === undefined ? undefined : e - Math.floor(Date.now() / 1000)
}

export const views = {
	/** Publish (or re-publish, as a new version) an email's HTML as a hosted view. */
	publish(options: PublishOptions & ViewClientOptions): Promise<View> {
		const { token, api, fetch, ...body } = options
		return call<View>("", { method: "POST", body }, { token, api, fetch })
	},

	/**
	 * A sealed token carrying `data` for the view `slug`, to put on its URL as `?s=`. Minted
	 * locally with the view key, or by Postboi when there's no key here.
	 */
	async seal(slug: string, data: unknown, options: SealOptions = {}): Promise<string> {
		await ensure_env_loaded()
		const key = options.key ?? read_env("POSTBOI_VIEW_KEY")
		if (key) return seal_token(key, slug, data, options.expires)
		const sealed = await call<{ token: string }>(
			`/${encodeURIComponent(slug)}/seal`,
			{ method: "POST", body: { data, expires_in: expires_in(options.expires) } },
			options
		)
		return sealed.token
	},

	/**
	 * The link to a view, carrying `data` for this reader when given. Data never goes on the
	 * URL in the clear: it is sealed (see {@link views.seal}).
	 */
	async url(slug: string, data?: unknown, options: UrlOptions = {}): Promise<string> {
		await ensure_env_loaded()
		const key = options.key ?? read_env("POSTBOI_VIEW_KEY")
		if (data !== undefined && !key) {
			const sealed = await call<{ token: string; url: string }>(
				`/${encodeURIComponent(slug)}/seal`,
				{ method: "POST", body: { data, expires_in: expires_in(options.expires) } },
				options
			)
			return sealed.url
		}
		const url = await page_url(slug, options)
		if (data === undefined || !key) return url
		return `${url}?s=${await seal_token(key, slug, data, options.expires)}`
	},
}

/** The placeholders a web-version link replaces, in Liquid-ish and percent forms. */
const WEB_URL = /\{\{\s*postboi\.web_url\s*\}\}|%postboi_web_url%/g

/** Put `url` wherever the body asks for its web version. */
export function replace_web_url(body: string, url: string): string {
	return body.replace(WEB_URL, () => url)
}
