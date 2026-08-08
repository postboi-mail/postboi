import { PushProvider, type PreparedPush, type WebPushOptions } from "./provider.js"
import type { WebPushSubscription } from "./types.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"
import { encrypt_payload, vapid_header, MAX_PAYLOAD_BYTES } from "./crypto.js"

type SendResponse = { ok: true; endpoint: string }

/**
 * Signed VAPID headers, cached per signing key and push-service origin. The JWT's audience
 * is the origin, not the endpoint, so one signature covers every subscription on the same
 * service — and in practice that's nearly all of them (a user base concentrates on a
 * handful of browser push services). Module-level like FCM's token cache, and for the same
 * reason: the zero-config `push()` constructs a fresh provider per call, so an
 * instance-level cache would never hit and every message would pay an ECDSA signature.
 */
const vapid_cache = new Map<string, { header: string; signed_at: number }>()

/** Forget every cached VAPID header — for tests, which share the module-level cache. */
export function clear_vapid_cache(): void {
	vapid_cache.clear()
}

/**
 * Web Push — VAPID (RFC 8292) plus `aes128gcm` payload encryption (RFC 8291).
 *
 * Works in every browser worth naming, and unusually for this library there is **no
 * vendor**: the push service is whichever one the user's browser chose, its URL arrives
 * inside the subscription, and it costs nothing. That's why push sits first in `send()`'s
 * cost ordering.
 *
 * @example
 * ```ts
 * import WebPush from "postboi/webpush"
 *
 * const notify = new WebPush({
 *   public_key: process.env.VAPID_PUBLIC_KEY,
 *   private_key: process.env.VAPID_PRIVATE_KEY,
 *   subject: "mailto:you@example.com",
 * })
 * await notify.send({ to: subscription, title: "Order shipped", message: "On its way" })
 * ```
 */
export default class WebPush extends PushProvider<SendResponse> {
	protected readonly provider = "webpush"
	#public_key: string
	#private_key: string
	#subject: string

	constructor({ public_key, private_key, subject, ...options }: WebPushOptions) {
		super(options)
		this.#public_key = public_key
		this.#private_key = private_key
		this.#subject = subject
	}

	/** The cached VAPID header for this endpoint's origin, re-signed when near expiry. */
	async #vapid_for(endpoint: string): Promise<string> {
		const origin = new URL(endpoint).origin
		const key = `${this.#public_key}|${origin}`
		const now = Date.now()
		const cached = vapid_cache.get(key)
		// The JWT expires 12 hours after signing; refresh an hour early so a send never
		// carries a token that lapses mid-flight.
		if (cached && now - cached.signed_at < 11 * 60 * 60 * 1000) return cached.header
		const header = await vapid_header(
			endpoint,
			this.#public_key,
			this.#private_key,
			this.#subject,
			now
		)
		vapid_cache.set(key, { header, signed_at: now })
		return header
	}

	/** The JSON a service worker receives in its `push` event. */
	protected payload(message: PreparedPush): string {
		return JSON.stringify({
			title: message.title,
			body: message.message,
			icon: message.icon,
			url: message.url,
			data: message.data,
		})
	}

	protected async build_request(message: PreparedPush): Promise<RequestSpec> {
		if (typeof message.to === "string") {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "invalid_target",
				message:
					"Web Push needs the full subscription object from pushManager.subscribe(), not a token string. A bare token is an FCM/APNs target.",
			})
		}
		const subscription = message.to as WebPushSubscription

		const payload = this.payload(message)
		// Check before encrypting: the limit is on plaintext, and a 400 from the push service
		// would not tell you which of your notifications was too big.
		const size = new TextEncoder().encode(payload).length
		if (size > MAX_PAYLOAD_BYTES) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "payload_too_large",
				message: `Push payload is ${size} bytes; one aes128gcm record holds ${MAX_PAYLOAD_BYTES}. Send an id and fetch the detail in the service worker.`,
			})
		}

		const body = await encrypt_payload(subscription, payload)
		const authorization = await this.#vapid_for(subscription.endpoint)

		return {
			url: subscription.endpoint,
			headers: {
				Authorization: authorization,
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				TTL: String(message.ttl),
				Urgency: message.urgency,
			},
			body: body as unknown as BodyInit,
		}
	}

	protected parse_response(response: Response, _data: unknown): SendResponse {
		return { ok: true, endpoint: response.url }
	}

	protected parse_error(response: Response, data: unknown): ProviderError | undefined {
		// A 2xx is a delivery whatever the body says — some push services attach a short
		// text body ("Created", a resource URL) to success, and without this guard that
		// body would be thrown as a failure for a push that arrived.
		if (response.ok) return undefined
		// Push services answer with an empty body far more often than not, so the status is
		// usually all there is. 410 is the one that matters and it means "stop storing this".
		if (response.status === 404 || response.status === 410) {
			return {
				message:
					"Push subscription has expired or been unsubscribed — delete your stored copy. See PushProvider.is_expired().",
				code: "expired_subscription",
			}
		}
		if (typeof data === "string" && data.trim()) return { message: data.trim() }
		return undefined
	}
}
