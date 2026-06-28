import type {
	SendOptions,
	PreparedMessage,
	CommonProviderOptions,
	Defaults,
	ProviderError,
	RequestSpec,
	BatchResult,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"
import { find_provider } from "./registry.js"
import { load_settings } from "./settings.js"

// Re-export the core so `import { PostboiError, SkipSendError, ... } from "postboi"` keeps working
// from the package root.
export * from "./index.js"

/** Options for the Postboi Cloud provider. */
export type CloudOptions = CommonProviderOptions & {
	/** Postboi Cloud token. Defaults to the `POSTBOI_TOKEN` environment variable. */
	token?: string
	/** Override the API base URL. Defaults to `POSTBOI_API_URL` or `https://api.postboi.dev`. */
	base_url?: string
}

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	filename: string
	type: string
}

export interface SendParams {
	from: EmailName
	to: Array<EmailName>
	cc?: Array<EmailName>
	bcc?: Array<EmailName>
	reply_to?: EmailName
	subject: string
	html?: string
	text?: string
	headers?: Record<string, string>
	tags?: Array<string>
	attachments?: Array<Attachment>
}

type SendResponse = { id: string }

/**
 * Read an environment variable across runtimes. Works in Node, Bun, Vercel/Netlify
 * functions and Deno. Cloudflare Workers pass env via bindings rather than the ambient
 * environment, so this returns undefined there — pass `{ token }` explicitly in Workers.
 */
function read_env(name: string): string | undefined {
	if (typeof process !== "undefined" && process.env) {
		const value = process.env[name]
		if (value) return value
	}
	const deno = (globalThis as { Deno?: { env?: { get?(key: string): string | undefined } } }).Deno
	try {
		return deno?.env?.get?.(name) || undefined
	} catch {
		return undefined
	}
}

/**
 * Read the default field values shared by every provider from the environment. Only defined
 * values are included, so an unset env var never clobbers a default from postboi.settings.ts.
 */
function env_defaults(): Defaults {
	const env: Record<keyof Defaults, string> = {
		from: "POSTBOI_FROM",
		to: "POSTBOI_TO",
		cc: "POSTBOI_CC",
		bcc: "POSTBOI_BCC",
		reply_to: "POSTBOI_REPLY_TO",
	}
	const out: Defaults = {}
	for (const [key, name] of Object.entries(env) as Array<[keyof Defaults, string]>) {
		const value = read_env(name)
		if (value !== undefined) out[key] = value
	}
	return out
}

/**
 * Postboi Cloud — the zero-config provider, and the package's default export.
 *
 * Run `bunx postboi init` to authenticate and write `POSTBOI_TOKEN` to your environment,
 * then just construct it with no arguments:
 *
 * @example
 * ```ts
 * import Postboi from "postboi"
 *
 * const mail = new Postboi() // reads POSTBOI_TOKEN
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hi</p>" })
 * ```
 *
 * The token can still be passed explicitly (`new Postboi({ token })`), which is required
 * in runtimes that don't expose ambient env vars (e.g. Cloudflare Workers).
 */
export default class Postboi extends ProviderBase<SendResponse> {
	protected readonly provider = "postboi"
	#token: string | undefined
	#url: string

	constructor({ token, base_url, ...options }: CloudOptions = {}) {
		// Defaults can come from the environment (POSTBOI_FROM, …); anything passed
		// explicitly via `default` wins.
		super({ ...options, default: { ...env_defaults(), ...options.default } })
		this.#token = token ?? read_env("POSTBOI_TOKEN")
		const host = base_url ?? read_env("POSTBOI_API_URL") ?? "https://api.postboi.dev"
		this.#url = `${host.replace(/\/$/, "")}/v1/send`
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		if (!this.#token) {
			throw new PostboiError({
				provider: this.provider,
				message:
					"No Postboi token found. Run `bunx postboi init`, set POSTBOI_TOKEN, or pass { token }.",
				code: "no_token",
			})
		}

		const params: SendParams = {
			from: this.email_name(this.parse_email_address(message.from)),
			to: this.email_name_list(message.to),
			cc: message.cc ? this.email_name_list(message.cc) : undefined,
			bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
			reply_to: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: message.headers,
			tags: message.tags,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						filename: a.name,
						type: a.mime_type,
					}))
				: undefined,
		}

		return {
			url: this.#url,
			headers: {
				Authorization: `Bearer ${this.#token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.message === "string" && !("id" in e)) {
			return { message: e.message, code: typeof e.code === "string" ? e.code : undefined }
		}
		return undefined
	}
}

type ProviderConstructor = new (options: Record<string, unknown>) => ProviderBase<unknown>

/**
 * Lazy loaders for every configurable provider, keyed by `POSTBOI_PROVIDER`. Using explicit
 * dynamic imports keeps each provider in its own chunk — `send()` only loads the one in use.
 */
const LOADERS: Record<string, () => Promise<ProviderConstructor>> = {
	resend: () => import("./resend.js").then((m) => m.default as unknown as ProviderConstructor),
	postmark: () => import("./postmark.js").then((m) => m.default as unknown as ProviderConstructor),
	sendgrid: () => import("./sendgrid.js").then((m) => m.default as unknown as ProviderConstructor),
	mailgun: () => import("./mailgun.js").then((m) => m.default as unknown as ProviderConstructor),
	brevo: () => import("./brevo.js").then((m) => m.default as unknown as ProviderConstructor),
	cloudflare: () =>
		import("./cloudflare.js").then((m) => m.default as unknown as ProviderConstructor),
	mailersend: () =>
		import("./mailersend.js").then((m) => m.default as unknown as ProviderConstructor),
	sparkpost: () =>
		import("./sparkpost.js").then((m) => m.default as unknown as ProviderConstructor),
	mandrill: () => import("./mandrill.js").then((m) => m.default as unknown as ProviderConstructor),
	plunk: () => import("./plunk.js").then((m) => m.default as unknown as ProviderConstructor),
	mailtrap: () => import("./mailtrap.js").then((m) => m.default as unknown as ProviderConstructor),
	mailpace: () => import("./mailpace.js").then((m) => m.default as unknown as ProviderConstructor),
	scaleway: () => import("./scaleway.js").then((m) => m.default as unknown as ProviderConstructor),
	zepto: () => import("./zepto.js").then((m) => m.default as unknown as ProviderConstructor),
}

/** Construct the provider named by `POSTBOI_PROVIDER` from environment variables. */
async function resolve_provider(): Promise<ProviderBase<unknown>> {
	// Load global settings (postboi.settings.ts / package.json) first, so hooks and the
	// `provider` fallback are available; ProviderBase merges the rest at construction.
	const settings = await load_settings()
	const key = read_env("POSTBOI_PROVIDER") ?? settings.provider
	if (!key) {
		throw new PostboiError({
			provider: "postboi",
			code: "no_provider",
			message:
				'No provider configured. Run `bunx postboi init` (it sets POSTBOI_PROVIDER), set `provider` in postboi.settings.ts, or import one directly, e.g. `import Resend from "postboi/resend"`.',
		})
	}

	const meta = find_provider(key)
	const load = LOADERS[key]
	if (!meta || !load) {
		throw new PostboiError({
			provider: "postboi",
			code: "unknown_provider",
			message: `Unknown POSTBOI_PROVIDER "${key}".`,
		})
	}

	const options: Record<string, unknown> = { default: env_defaults() }
	for (const field of meta.fields) {
		const value = read_env(field.env) ?? field.default
		if (value === undefined) {
			throw new PostboiError({
				provider: key,
				code: "missing_env",
				message: `POSTBOI_PROVIDER is "${key}" but ${field.env} is not set. Run \`bunx postboi init\`.`,
			})
		}
		options[field.arg] = value
	}

	const Provider = await load()
	return new Provider(options)
}

/**
 * Send without constructing anything. The provider is whichever `POSTBOI_PROVIDER` names
 * (set by `bunx postboi init`); its credentials and the `POSTBOI_*` defaults are read from
 * the environment on each call. Pass an array to send many.
 *
 * @example
 * ```ts
 * import { send } from "postboi"
 * await send({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
 * ```
 */
export function send(options: SendOptions): Promise<unknown>
export function send(
	options: Array<SendOptions>,
	batch?: { concurrency?: number }
): Promise<Array<BatchResult<unknown>>>
export async function send(
	options: SendOptions | Array<SendOptions>,
	batch: { concurrency?: number } = {}
): Promise<unknown> {
	const mail = await resolve_provider()
	return Array.isArray(options) ? mail.send(options, batch) : mail.send(options)
}
