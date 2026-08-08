/**
 * The SMS channel's public types.
 *
 * Deliberately free of runtime imports so the package root can widen `Hooks` to include
 * {@link PreparedSms} without pulling the SMS provider into the email module graph.
 */
import type { Duration, TransportOptions } from "../transport.js"

/**
 * A phone number, in any of the shapes the public API accepts.
 *
 * A bare `number` reads nicely (`to: 447788223344`) but cannot carry a leading `+` or a
 * leading `0`, so it is normalised the same way an unprefixed string is — see
 * `to_e164`. When in doubt, pass a `+`-prefixed string.
 */
export type Phone = string | number | { number: string; name?: string }

/** Default field values applied to every SMS send when the option is omitted. */
export type SmsDefaults = {
	to?: Array<Phone> | Phone
	/** Sender: a purchased number in E.164, or an alphanumeric sender ID (11 chars max). */
	from?: string
	/**
	 * Country used to resolve national-format numbers — an ISO 3166-1 alpha-2 code (`"GB"`)
	 * or a dialling code (`"+44"`). Without it, anything that isn't already international
	 * is rejected rather than guessed at.
	 */
	country?: string
}

/** Options accepted by `sms(...)` and every SMS provider's `send`. */
export interface SmsOptions {
	to?: Array<Phone> | Phone
	/** Sender: a purchased number in E.164, or an alphanumeric sender ID (11 chars max). */
	from?: string
	/** The message body. Plain text — SMS has no markup. */
	message: string
	/**
	 * Schedule for future delivery. Accepts a `Date`, an ISO 8601 string, or a relative
	 * {@link Duration}. Forwarded to providers with native scheduling; providers without it
	 * reject rather than silently sending immediately.
	 */
	scheduled_at?: Date | string | Duration
	/** Tags for analytics and filtering, where the provider supports them. */
	tags?: Array<string>
	/** Idempotency key, so a retried request does not send a duplicate text. */
	idempotency_key?: string
	/** Override the default country for national-format numbers in this send. */
	country?: string
}

/**
 * A fully-resolved SMS handed to a provider's `build_request`. Defaults have been applied
 * and every recipient is normalised to E.164.
 */
export interface PreparedSms {
	/** Recipients in E.164 form (`+447788223344`). */
	to: Array<string>
	from?: string
	message: string
	/** Normalized future delivery time; provider-format conversion happens in build_request. */
	scheduled_at?: Date
	tags?: Array<string>
	idempotency_key?: string
}

/** Constructor options shared by every SMS provider. */
export type SmsProviderOptions = TransportOptions<PreparedSms> & {
	/** Default field values applied when a send omits them. */
	default?: SmsDefaults
}

/** Options for SMS providers that authenticate with a single API key or token. */
export type SmsApiKeyOptions = SmsProviderOptions & {
	/** The provider API key / token used to authenticate requests. */
	api_key: string
}
