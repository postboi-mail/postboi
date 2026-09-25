import { PushProvider, type PreparedPush, type PushProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"
import { pem_to_der, to_base64url } from "../encoding.js"
import { http2_fetch } from "./http2.js"

/** Options for the APNs provider constructor. */
type Options = PushProviderOptions & {
	/** Key ID of the `.p8` auth key, from the Apple Developer portal (10 characters). */
	key_id: string
	/** Your Apple Developer team ID (10 characters). */
	team_id: string
	/** Contents of the `.p8` file — an EC P-256 private key, PEM. */
	private_key: string
	/** The app's bundle ID, sent as `apns-topic`. */
	topic: string
	/**
	 * Which APNs to talk to. A token from a development build is only valid against
	 * `sandbox` and vice versa — mismatch them and every send comes back `BadDeviceToken`.
	 */
	environment?: "production" | "sandbox"
}

type SendResponse = { id: string }

/** Apple's documented limit for an alert notification's payload. */
const MAX_PAYLOAD_BYTES = 4096

const encoder = new TextEncoder()

/**
 * Provider tokens per auth key, shared across instances — same reasoning as FCM's OAuth
 * cache, plus a rule of Apple's own: a provider token is valid for an hour, and APNs
 * answers `TooManyProviderTokenUpdates` if you mint a new one more than once every 20
 * minutes. Signing per send would trip that under any real load.
 */
const token_cache = new Map<string, { value: string; signed_at: number }>()

/** Forget every cached provider token — for tests, which share the module-level cache. */
export function clear_apns_tokens(): void {
	token_cache.clear()
}

/** APNs device tokens are hex. Anything else is a different channel's target. */
const HEX_TOKEN = /^[0-9a-fA-F]+$/

/**
 * Apple Push Notification service, over the token-based (`.p8`) HTTP/2 provider API —
 * https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
 *
 * The direct route to iOS, without Firebase in the middle. Two things make it unlike every
 * other provider here. The credential is a signed ES256 JWT you mint yourself rather than
 * a key you send, cached because Apple rate-limits how often you may re-sign it. And APNs
 * refuses HTTP/1.1, which Node's global `fetch` is — so requests go out through
 * {@link http2_fetch}, which uses `node:http2` where it exists and the global `fetch`
 * (already HTTP/2) on Workers and Deno.
 *
 * @example
 * ```ts
 * import APNs from "postboi/apns"
 *
 * const notify = new APNs({
 *   key_id: process.env.APNS_KEY_ID,
 *   team_id: process.env.APNS_TEAM_ID,
 *   private_key: process.env.APNS_PRIVATE_KEY,
 *   topic: "com.example.app",
 * })
 * await notify.send({ to: device_token, title: "Order shipped", message: "On its way" })
 * ```
 */
export default class APNs extends PushProvider<SendResponse> {
	protected readonly provider = "apns"
	#key_id: string
	#team_id: string
	#private_key: string
	#topic: string
	#host: string

	constructor({ key_id, team_id, private_key, topic, environment, ...options }: Options) {
		super(options)
		this.#key_id = key_id
		this.#team_id = team_id
		this.#private_key = private_key
		this.#topic = topic
		this.#host =
			environment === "sandbox"
				? "https://api.sandbox.push.apple.com"
				: "https://api.push.apple.com"
	}

	/** APNs speaks HTTP/2 only, so this is the one provider that can't use the global fetch. */
	protected async send_request(url: string, init: RequestInit): Promise<Response> {
		return http2_fetch(url, init)
	}

	/**
	 * The cached provider token, re-signed at 50 minutes. Apple's window is narrow at both
	 * ends: a token lapses at 60 minutes, and re-signing more often than every 20 is itself
	 * an error, so 50 is the only comfortable place to sit.
	 */
	async #token(): Promise<string> {
		const now = Date.now()
		const cached = token_cache.get(this.#key_id)
		if (cached && now - cached.signed_at < 50 * 60 * 1000) return cached.value

		const header = to_base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: this.#key_id })))
		const payload = to_base64url(
			encoder.encode(JSON.stringify({ iss: this.#team_id, iat: Math.floor(now / 1000) }))
		)
		const signing_input = `${header}.${payload}`

		let key: CryptoKey
		try {
			key = await crypto.subtle.importKey(
				"pkcs8",
				pem_to_der(this.#private_key),
				{ name: "ECDSA", namedCurve: "P-256" },
				false,
				["sign"]
			)
		} catch (cause) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "invalid_key",
				message:
					"APNS_PRIVATE_KEY is not a readable .p8 key. Paste the whole file, BEGIN/END lines included.",
				raw: cause,
			})
		}
		// WebCrypto signs ECDSA as raw r||s, which is exactly the JOSE encoding ES256 wants —
		// no DER unpacking, and the same reason the VAPID signer needs no helper either.
		const signature = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			encoder.encode(signing_input)
		)
		const value = `${signing_input}.${to_base64url(new Uint8Array(signature))}`
		token_cache.set(this.#key_id, { value, signed_at: now })
		return value
	}

	/** The JSON APNs delivers. Custom keys sit beside `aps`, not inside it. */
	protected payload(message: PreparedPush): string {
		return JSON.stringify({
			...message.data,
			...(message.url ? { url: message.url } : {}),
			aps: {
				alert: { ...(message.title ? { title: message.title } : {}), body: message.message },
				sound: "default",
			},
		})
	}

	protected async build_request(message: PreparedPush): Promise<RequestSpec> {
		if (typeof message.to !== "string") {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "invalid_target",
				message:
					"APNs needs a device token, not a Web Push subscription object. A subscription belongs to postboi/webpush.",
			})
		}
		// The token goes into the request path, so this is a trust boundary as well as a
		// typo check: an FCM token or a URL here would otherwise be a confusing 400 from
		// Apple, and anything with a slash in it would be a different request entirely.
		if (!HEX_TOKEN.test(message.to)) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "invalid_target",
				message: `APNs device tokens are hexadecimal; got ${JSON.stringify(message.to.slice(0, 24))}…. An FCM registration token belongs to postboi/fcm.`,
			})
		}

		const payload = this.payload(message)
		this.check_payload(payload, MAX_PAYLOAD_BYTES, "APNs accepts")

		return {
			url: `${this.#host}/3/device/${message.to}`,
			headers: {
				authorization: `bearer ${await this.#token()}`,
				"apns-topic": this.#topic,
				// Required since iOS 13. Everything this library sends shows an alert — a
				// silent background push has no title or body to carry.
				"apns-push-type": "alert",
				// 10 is "deliver now", 5 is "deliver when it suits the battery". An alert the
				// caller marked low is the only kind worth holding back.
				"apns-priority": message.urgency === "low" || message.urgency === "very-low" ? "5" : "10",
				"apns-expiration": String(Math.floor(Date.now() / 1000) + message.ttl),
				"content-type": "application/json",
			},
			body: payload,
		}
	}

	protected parse_response(response: Response, _data: unknown): SendResponse {
		// APNs answers 200 with an empty body; the id is the header it echoes back (the one
		// it generated, if the request didn't supply one).
		return { id: response.headers.get("apns-id") ?? "" }
	}

	protected parse_error(response: Response, data: unknown): ProviderError | undefined {
		if (response.ok) return undefined
		const reason = (data as { reason?: string } | null)?.reason
		// The two reasons that mean "this device is gone, delete your copy". They arrive as
		// 410 and 400 respectively, so the status alone can't tell them apart from a bad
		// request — normalizing the code here is what makes push.expired() catch both.
		if (reason === "Unregistered" || reason === "BadDeviceToken") {
			return {
				message: `APNs rejected the device token (${reason}). Delete your stored copy. See PushProvider.is_expired().`,
				code: "expired_subscription",
			}
		}
		if (reason) return { message: `APNs rejected the notification: ${reason}`, code: reason }
		return undefined
	}
}
