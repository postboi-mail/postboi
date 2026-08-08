/**
 * The SMS channel's provider base — {@link Transport} plus the SMS-specific preparation
 * step: defaults, E.164 normalisation and recipient validation.
 *
 * Mirrors `EmailProvider` in shape, so a provider here implements the same three hooks
 * (`build_request`, `parse_response`, optionally `parse_error`) as an email one.
 */
import { PostboiError, type Channel } from "../errors.js"
import { Transport, type BatchResult } from "../transport.js"
import { get_config } from "../config.js"
import { ensure_env_loaded } from "../env.js"
import { to_e164 } from "./phone.js"
import type { Phone, PreparedSms, SmsDefaults, SmsOptions, SmsProviderOptions } from "./types.js"

export type {
	Phone,
	PreparedSms,
	SmsDefaults,
	SmsOptions,
	SmsProviderOptions,
	SmsApiKeyOptions,
} from "./types.js"

/**
 * Base class for SMS providers.
 *
 * @example
 * ```ts
 * import Twilio from "postboi/twilio"
 *
 * const text = new Twilio({ account_sid, auth_token, default: { from: "POSTBOI" } })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export abstract class SmsProvider<TResponse = unknown> extends Transport<TResponse, PreparedSms> {
	protected readonly channel: Channel = "sms"

	/** Whether the provider needs a sender. Providers that default it account-side set false. */
	protected requires_from: boolean = true

	/**
	 * Whether the provider can schedule a send. Left false, a `scheduled_at` is **rejected**
	 * rather than quietly sent immediately — a text that was meant for Tuesday arriving now
	 * is worse than an error, and the caller can't tell it happened.
	 */
	protected readonly supports_scheduling: boolean = false

	protected defaults: SmsDefaults

	constructor(options: SmsProviderOptions = {}) {
		super(options)
		// Global config sits underneath per-instance options, so explicit arguments win.
		const s = get_config()
		this.defaults = { ...s.sms?.default, ...options.default }
	}

	/** Send one text. Throws a {@link PostboiError} on any failure. */
	send(options: SmsOptions): Promise<TResponse>
	/**
	 * Send many texts as individual requests with bounded concurrency (default 5).
	 * Never rejects — each message yields its own {@link BatchResult}.
	 */
	send(
		options: Array<SmsOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<TResponse>>>
	async send(
		options: SmsOptions | Array<SmsOptions>,
		batch: { concurrency?: number } = {}
	): Promise<TResponse | Array<BatchResult<TResponse>>> {
		if (Array.isArray(options)) {
			return this.run_batch(options, (one) => this.send(one), batch)
		}
		return this.with_hooks(
			() => this.prepare_sms(options),
			(message) => this.deliver(message)
		)
	}

	/** Normalise a single {@link Phone} into its E.164 string. */
	protected parse_phone(phone: Phone, country?: string): string {
		if (typeof phone === "object") return to_e164(phone.number, country)
		return to_e164(phone, country)
	}

	/** Normalise one-or-many recipients, accepting a comma-separated string like `to` does. */
	protected parse_phones(phones: Array<Phone> | Phone, country?: string): Array<string> {
		if (Array.isArray(phones)) return phones.map((p) => this.parse_phone(p, country))
		if (typeof phones === "string" && phones.includes(",")) {
			return phones
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
				.map((p) => this.parse_phone(p, country))
		}
		return [this.parse_phone(phones, country)]
	}

	/**
	 * Apply defaults, normalise recipients to E.164 and validate that a recipient (and a
	 * sender, where the provider needs one) is present. Returns a {@link PreparedSms}.
	 */
	protected async prepare_sms(options: SmsOptions): Promise<PreparedSms> {
		// Makes Worker bindings and `.env` values readable, so a provider constructed with no
		// arguments can still find its credentials. Cached after the first send.
		await ensure_env_loaded()

		const to = options.to ?? this.defaults.to
		const from = options.from ?? this.defaults.from
		const country = options.country ?? this.defaults.country

		if (!to) {
			throw new PostboiError({
				provider: this.provider,
				channel: "sms",
				code: "no_recipient",
				message: "No recipient number provided (to or default.to).",
			})
		}
		if (!from && this.requires_from) {
			throw new PostboiError({
				provider: this.provider,
				channel: "sms",
				code: "no_sender",
				message:
					"No sender provided (from or default.from). SMS needs a purchased number or an alphanumeric sender ID.",
			})
		}
		if (!options.message?.trim()) {
			throw new PostboiError({
				provider: this.provider,
				channel: "sms",
				code: "empty_message",
				message: "Cannot send an empty SMS — `message` is required.",
			})
		}

		let scheduled_at: Date | undefined
		if (options.scheduled_at !== undefined) {
			if (!this.supports_scheduling) {
				throw new PostboiError({
					provider: this.provider,
					channel: "sms",
					code: "scheduling_not_supported",
					message: `${this.provider} cannot schedule SMS. Remove scheduled_at, or use a provider that supports it.`,
				})
			}
			scheduled_at = this.resolve_scheduled_at(options.scheduled_at)
			if (Number.isNaN(scheduled_at.getTime())) {
				throw new PostboiError({
					provider: this.provider,
					channel: "sms",
					code: "invalid_scheduled_at",
					message: `Invalid scheduled_at value: ${String(options.scheduled_at)}`,
				})
			}
		}

		return {
			to: this.parse_phones(to, country),
			from,
			message: options.message,
			scheduled_at,
			tags: options.tags,
			idempotency_key: options.idempotency_key,
		}
	}
}
