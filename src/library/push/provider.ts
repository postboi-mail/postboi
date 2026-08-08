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
		if (Array.isArray(options)) {
			return this.run_batch(options, (one) => this.send(one), batch)
		}
		return this.with_hooks(
			() => this.prepare_push(options),
			(message) => this.deliver(message)
		)
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
					"No push target — pass the subscription or device token the client registered with.",
			})
		}
		if (!options.message?.trim()) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "empty_message",
				message: "Cannot send an empty notification — `message` is required.",
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
		return error instanceof PostboiError && (error.status === 404 || error.status === 410)
	}
}
