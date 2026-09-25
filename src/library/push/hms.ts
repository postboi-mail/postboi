import { PushProvider, type PreparedPush, type PushProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"
import { cached_token, forget_token } from "./oauth.js"

/** Options for the HMS provider constructor. */
type Options = PushProviderOptions & {
	/** App ID from AppGallery Connect — also the OAuth2 client ID. */
	app_id: string
	/** App secret from AppGallery Connect — also the OAuth2 client secret. */
	app_secret: string
}

type SendResponse = { request_id: string }

/** Huawei answers every send with HTTP 200; this is the code that means it worked. */
const SUCCESS = "80000000"

/**
 * Result codes that mean the device token is dead. `80300007` is Huawei's "all tokens
 * invalid" and `80100000` its "some tokens invalid" — with one token per send those say
 * the same thing, so both normalize to the expiry the caller already handles.
 */
const DEAD_TOKEN = new Set(["80300007", "80100000"])

/** The access token has lapsed. Evicted from the cache so the next send re-mints it. */
const TOKEN_EXPIRED = "80200003"

/** Huawei's documented ceiling for the message body, token excluded. */
const MAX_PAYLOAD_BYTES = 4096

/** Huawei caps how long it will hold a message. Clamped rather than rejected on our side. */
const MAX_TTL_SECONDS = 1296000 // 15 days

/**
 * Huawei Mobile Services Push Kit —
 * https://developer.huawei.com/consumer/en/doc/HMSCore-References/https-send-api-0000001050986197
 *
 * The reason this exists: Huawei phones sold since 2020 ship without Google Play Services,
 * so FCM cannot reach them at all. It isn't a preference, it's the only route to those
 * devices — the same way FCM is the only route to Play Android.
 *
 * Two things to know. The app secret is exchanged for a short-lived OAuth2 token, cached
 * like FCM's. And **Huawei answers HTTP 200 even when the send failed** — the real outcome
 * is the `code` field in the body, which is why `parse_error` reads it rather than
 * trusting the status.
 *
 * @example
 * ```ts
 * import HMS from "postboi/hms"
 *
 * const notify = new HMS({
 *   app_id: process.env.HMS_APP_ID,
 *   app_secret: process.env.HMS_APP_SECRET,
 * })
 * await notify.send({ to: device_token, title: "Order shipped", message: "On its way" })
 * ```
 */
export default class HMS extends PushProvider<SendResponse> {
	protected readonly provider = "hms"
	#app_id: string
	#app_secret: string

	constructor({ app_id, app_secret, ...options }: Options) {
		super(options)
		this.#app_id = app_id
		this.#app_secret = app_secret
	}

	/** Mint (or reuse) the OAuth2 token, keyed by app so every instance shares one. */
	async #access_token(): Promise<string> {
		const now = Date.now()
		return cached_token(`hms:${this.#app_id}`, now, () => this.#exchange())
	}

	/** The client-credentials exchange. Only reached on a cold or expiring cache. */
	async #exchange(): Promise<{ value: string; expires_in: number }> {
		const response = await this.request({
			url: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "client_credentials",
				client_id: this.#app_id,
				client_secret: this.#app_secret,
			}).toString(),
		})
		const data = (await this.read_json(response)) as {
			access_token?: string
			expires_in?: number
			error_description?: string
		} | null
		if (!response.ok || !data?.access_token) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				status: response.status,
				code: "oauth_failed",
				message: `HMS token exchange failed: ${data?.error_description ?? response.status}`,
				raw: data,
			})
		}
		return { value: data.access_token, expires_in: data.expires_in ?? 3600 }
	}

	protected async build_request(message: PreparedPush): Promise<RequestSpec> {
		if (typeof message.to !== "string") {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "invalid_target",
				message:
					"HMS needs a device token, not a Web Push subscription object. A subscription belongs to postboi/webpush.",
			})
		}

		const data = { ...message.data, ...(message.url ? { url: message.url } : {}) }
		const body = JSON.stringify({
			validate_only: false,
			message: {
				token: [message.to],
				notification: { title: message.title, body: message.message },
				android: {
					ttl: `${Math.min(message.ttl, MAX_TTL_SECONDS)}s`,
					urgency: message.urgency === "high" ? "HIGH" : "NORMAL",
					// Huawei takes the custom payload as a JSON *string*, not an object.
					...(Object.keys(data).length ? { data: JSON.stringify(data) } : {}),
					// `android.notification` is only legal with a click_action, so it's set
					// solely to route the tap — without a url, tapping opens the app, which is
					// the default anyway.
					...(message.url ? { notification: { click_action: { type: 2, url: message.url } } } : {}),
				},
			},
		})

		this.check_payload(body, MAX_PAYLOAD_BYTES, "HMS accepts")

		return {
			url: `https://push-api.cloud.huawei.com/v1/${encodeURIComponent(this.#app_id)}/messages:send`,
			headers: {
				Authorization: `Bearer ${await this.#access_token()}`,
				"Content-Type": "application/json;charset=utf-8",
			},
			body,
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return { request_id: (data as { requestId?: string } | null)?.requestId ?? "" }
	}

	protected parse_error(response: Response, data: unknown): ProviderError | undefined {
		const body = data as { code?: string; msg?: string } | null
		// The status is not the answer here: a rejected notification still comes back 200,
		// so a provider that only checked `response.ok` would report every failure as a
		// success. Only the code says what happened.
		if (body?.code === SUCCESS) return undefined
		if (body?.code === TOKEN_EXPIRED) forget_token(`hms:${this.#app_id}`)
		if (body?.code && DEAD_TOKEN.has(body.code)) {
			return {
				message: `HMS rejected the device token (${body.code}). Delete your stored copy. See PushProvider.is_expired().`,
				code: "expired_subscription",
			}
		}
		if (body?.code) {
			return { message: `HMS rejected the notification: ${body.msg ?? body.code}`, code: body.code }
		}
		// No code at all means we never reached Push Kit — let the status speak.
		return response.ok
			? { message: "HMS returned no result code, so the response was not from Push Kit." }
			: undefined
	}
}
