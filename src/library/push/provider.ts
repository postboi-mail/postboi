/**
 * The push channel's provider base.
 *
 * Push differs from every other channel in one structural way: **the destination is a
 * stored credential, not an address.** An email address or a phone number is something you
 * can be told; a subscription or device token only exists once the device has registered
 * and handed it to you. That shapes the API — there is no useful `default.to`, and the
 * interesting failure is a target that has expired.
 */
import { PostboiError, type Channel } from "../errors.js"
import { Transport, type BatchResult } from "../transport.js"
import { get_config } from "../config.js"
import { ensure_env_loaded } from "../env.js"
import type { PushDefaults, PushOptions, PushProviderOptions, PreparedPush } from "./types.js"

export type {
	PushDefaults,
	PushOptions,
	PushProviderOptions,
	PreparedPush,
	PushTarget,
	WebPushOptions,
	WebPushSubscription,
} from "./types.js"

/** Base class for push providers. */
export abstract class PushProvider<TResponse = unknown> extends Transport<TResponse, PreparedPush> {
	protected readonly channel: Channel = "push"

	protected defaults: PushDefaults

	constructor(options: PushProviderOptions = {}) {
		super(options)
		const s = get_config()
		this.defaults = { ...s.push?.default, ...options.default }
	}

	/** Send one notification. Throws a {@link PostboiError} on failure. */
	send(options: PushOptions): Promise<TResponse>
	/** Send many, with bounded concurrency. Never rejects — each yields its own result. */
	send(
		options: Array<PushOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<TResponse>>>
	async send(
		options: PushOptions | Array<PushOptions>,
		batch: { concurrency?: number } = {}
	): Promise<TResponse | Array<BatchResult<TResponse>>> {
		return this.dispatch(options, batch, (one) => this.prepare_push(one))
	}

	/** Apply defaults and check there's a target and something to say. */
	protected async prepare_push(options: PushOptions): Promise<PreparedPush> {
		await ensure_env_loaded()

		const to = options.to ?? this.defaults.to
		if (!to) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "no_target",
				message:
					"No push target. Pass the subscription or device token the client registered with.",
			})
		}
		if (!options.message?.trim()) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "empty_message",
				message: "Cannot send an empty notification: `message` is required.",
			})
		}

		return {
			to,
			title: options.title,
			message: options.message,
			icon: options.icon ?? this.defaults.icon,
			url: options.url,
			data: options.data,
			ttl: options.ttl ?? this.defaults.ttl ?? 2419200, // 28 days, the common maximum
			urgency: options.urgency ?? "normal",
		}
	}

	/**
	 * Refuse a payload the platform would bounce, saying how big it is. Every push
	 * service caps the notification at a few kilobytes and answers a bare 400 past it,
	 * which doesn't say which of your notifications was too big — so each provider checks
	 * first, and this is the one place the check and its advice are written.
	 */
	protected check_payload(
		payload: string,
		limit: number,
		holds: string,
		where: "app" | "service worker" = "app"
	): void {
		const size = new TextEncoder().encode(payload).length
		if (size > limit) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "payload_too_large",
				message: `Push payload is ${size} bytes; ${holds} ${limit}. Send an id and fetch the detail in the ${where}.`,
			})
		}
	}

	/**
	 * Did the push service say this target is dead?
	 *
	 * Worth a first-class helper rather than leaving callers to match on status codes:
	 * subscriptions expire constantly and normally, and the correct response is to delete
	 * your stored copy — not to retry, and not to alert.
	 *
	 * Zero-config callers have this as `push.expired(error)`, no extra import; the static
	 * exists for code holding a provider instance.
	 */
	static is_expired(error: unknown): boolean {
		if (!(error instanceof PostboiError)) return false
		// A push service says "gone" with a status; APNs says it with a 400 and a reason
		// (`BadDeviceToken`), which no status could distinguish from a malformed request.
		// Providers normalize that case to this code, so the check stays one line here
		// rather than a growing list of per-provider special cases at every call site.
		return error.status === 404 || error.status === 410 || error.code === "expired_subscription"
	}
}
