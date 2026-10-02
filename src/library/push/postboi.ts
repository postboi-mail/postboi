/**
 * Managed push: Web Push where Postboi keeps the subscriptions.
 *
 * With every other push provider the app keeps a table of subscriptions, deletes rows when
 * a send answers 404/410, and serves an endpoint for the service worker to re-file rotated
 * subscriptions to. Here that state lives on the Postboi provider, next to contacts, so a
 * send can name a person (`{ user }`) or a public list (`{ list }`) instead of a device:
 *
 * ```ts
 * await push({ to: { user: "123" }, title: "Order shipped", message: "On its way" })
 * ```
 *
 * Opt-in, and named rather than inferred: `POSTBOI_PUSH_PROVIDER=postboi`. A `POSTBOI_TOKEN`
 * alone never selects it, or every account with email configured would stop inferring Web
 * Push from its VAPID trio. `bunx postboi init --push` writes the line.
 */
import { PushProvider } from "./provider.js"
import type { PreparedPush, PushProviderOptions, WebPushSubscription } from "./types.js"
import { is_audience } from "./types.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"
import { read_env } from "../env.js"

/** What a managed send answers: per-device counts, never a throw for an empty audience. */
export interface ManagedPushResult {
	/** Browsers the push service accepted. */
	sent: number
	/** Browsers the push service said are gone. Postboi has already cleaned them up. */
	expired: number
	/** Browsers that failed for any other reason. */
	failed: Array<{ endpoint: string; message: string; status?: number }>
}

/** A browser as Postboi holds it. */
export interface ManagedSubscription {
	endpoint: string
	keys: { p256dh: string; auth: string }
	/** Your id for the person it belongs to, or null for one that only follows lists. */
	user: string | null
	/** The lists it follows, by name. */
	lists: Array<string>
	created_at: string
}

/** Options for {@link PostboiPush}. */
export type PostboiPushOptions = PushProviderOptions & {
	/** The Postboi API key. Defaults to `POSTBOI_TOKEN`. */
	token?: string
	/** Override the API base URL. Defaults to `POSTBOI_API_URL` or `https://postboi.app`. */
	base_url?: string
}

/** The JSON a subscription is filed as: the browser's subscription, and who it belongs to. */
export interface FileOptions {
	/** Your own id for the signed-in person. Sends to `{ user }` reach every browser filed under it. */
	user?: string | number
	/** Lists this browser follows, by name or id. They must exist on the account. */
	lists?: string | Array<string>
}

/**
 * Web Push through Postboi, which holds the VAPID key and the subscriptions.
 *
 * Reach for `push()` with `POSTBOI_PUSH_PROVIDER=postboi` rather than this class; it exists
 * for code holding a provider instance, and for `push.subscriptions`.
 *
 * @example
 * ```ts
 * import PostboiPush from "postboi/push/postboi"
 *
 * const managed = new PostboiPush()
 * const { sent } = await managed.send({ to: { user: "123" }, message: "On its way" })
 * ```
 */
export default class PostboiPush extends PushProvider<ManagedPushResult> {
	protected readonly provider = "postboi"
	protected override readonly audiences = true
	#token: string | undefined
	#host: string

	constructor({ token, base_url, ...options }: PostboiPushOptions = {}) {
		super(options)
		this.#token = token ?? read_env("POSTBOI_TOKEN")
		const host = base_url ?? read_env("POSTBOI_API_URL") ?? "https://postboi.app"
		this.#host = host.replace(/\/$/, "")
	}

	#require_token(): string {
		// Re-read late as well as at construction: on Workers the bindings only reach the env
		// cache once `ensure_env_loaded()` has run, which the send path awaits.
		this.#token ??= read_env("POSTBOI_TOKEN")
		if (!this.#token) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "no_token",
				message:
					"Managed push needs a Postboi token. Run `bunx postboi init --push`, set POSTBOI_TOKEN, or pass { token }.",
			})
		}
		return this.#token
	}

	/** Call a `/v1/push` path with bearer auth and normalized errors. */
	async #api<T>(path: string, method: string, body?: unknown): Promise<T> {
		const token = this.#require_token()
		const data = await this.call(
			{
				url: `${this.#host}/v1/push${path}`,
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					...(body !== undefined && { "Content-Type": "application/json" }),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
			},
			path
		)
		return data as T
	}

	protected build_request(message: PreparedPush): RequestSpec {
		const to = is_audience(message.to)
			? "user" in message.to
				? { user: String(message.to.user) }
				: { list: message.to.list }
			: message.to
		if (typeof to === "string") {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "invalid_target",
				message:
					"Managed push sends to { user }, { list } or a Web Push subscription. A bare token is an FCM/APNs target.",
			})
		}
		return {
			url: `${this.#host}/v1/push/send`,
			headers: {
				Authorization: `Bearer ${this.#require_token()}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				to,
				title: message.title,
				message: message.message,
				icon: message.icon,
				url: message.url,
				data: message.data,
				ttl: message.ttl,
				urgency: message.urgency,
			}),
		}
	}

	protected parse_response(_response: Response, data: unknown): ManagedPushResult {
		const result = (data ?? {}) as Partial<ManagedPushResult>
		return {
			sent: result.sent ?? 0,
			expired: result.expired ?? 0,
			failed: result.failed ?? [],
		}
	}

	protected parse_error(response: Response, data: unknown): ProviderError | undefined {
		if (response.ok) return undefined
		const body = data as { message?: string; code?: string } | undefined
		if (body?.message) return { message: body.message, code: body.code }
		return undefined
	}

	/**
	 * The subscriptions Postboi holds for this account. `push.handler` is these calls behind
	 * a route; reach for them directly from a framework whose handlers aren't
	 * `Request`-shaped (Express), or from a script moving an existing table across.
	 */
	readonly subscriptions = {
		/** File a browser under a person and/or lists. Filing it again re-points it. */
		add: (subscription: WebPushSubscription, options: FileOptions = {}) =>
			this.#api<{ endpoint: string; user: string | null }>("/subscriptions", "POST", {
				subscription,
				...(options.user !== undefined && { user: String(options.user) }),
				...(options.lists !== undefined && { lists: options.lists }),
			}),

		/**
		 * Forget a browser by its endpoint. With `user`, only when it is that person's — what
		 * `push.handler`'s DELETE passes, so one signed-in person can't unfile another's.
		 */
		remove: (endpoint: string, options: { user?: string | number } = {}) =>
			this.#api<{ endpoint: string; deleted: true }>("/subscriptions", "DELETE", {
				endpoint,
				...(options.user !== undefined && { user: String(options.user) }),
			}),

		/** A page of live browsers, one person's or one list's. Pass `cursor` back for the next. */
		list: (
			options: { user?: string | number; list?: string; cursor?: string; limit?: number } = {}
		) => {
			const query = new URLSearchParams()
			if (options.user !== undefined) query.set("user", String(options.user))
			if (options.list) query.set("list", options.list)
			if (options.cursor) query.set("cursor", options.cursor)
			if (options.limit) query.set("limit", String(options.limit))
			const qs = query.toString()
			return this.#api<{ subscriptions: Array<ManagedSubscription>; cursor: string | null }>(
				`/subscriptions${qs ? `?${qs}` : ""}`,
				"GET"
			)
		},

		/**
		 * Move an existing table across, up to 1000 rows a call, all or nothing. The rows only
		 * work under the key they were made with, so import that pair first
		 * (`bunx postboi init --push` offers to).
		 */
		import: (rows: Array<{ subscription: WebPushSubscription } & FileOptions>) =>
			this.#api<{ imported: number }>("/subscriptions/import", "POST", {
				rows: rows.map((row) => ({
					subscription: row.subscription,
					...(row.user !== undefined && { user: String(row.user) }),
					...(row.lists !== undefined && { lists: row.lists }),
				})),
			}),
	}
}
