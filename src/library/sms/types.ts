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
	/**
	 * Idempotency key. None of the SMS providers here documents one for sending (Twilio,
	 * SNS, The SMS Works and PureSMS alike), so it is not forwarded and does not make a
	 * retry safe: a send that fails with `outcome_unknown` may already have gone out.
	 */
	idempotency_key?: string
	/** Override the default country for national-format numbers in this send. */
	country?: string
	/**
	 * Images or files to send with the text, as public http(s) URLs: an MMS. Twilio and
	 * Telnyx carry up to 10; a provider that can't send MMS refuses rather than dropping them.
	 */
	media?: Array<string>
	/**
	 * How many seconds the provider keeps trying to deliver before giving up: a one-time code
	 * that arrives an hour late is worse than one that never does. Twilio takes 1 to 36000,
	 * Vonage 20 to 604800; anywhere else it is refused rather than ignored.
	 */
	validity?: number
	/**
	 * Parameters this provider takes that the fields above don't cover, passed straight into
	 * its request (Twilio's `MessageIntent`, Telnyx's `subject`, Vonage's `sms` object, …).
	 * Not validated beyond refusing a name the send sets itself, so check the provider's own
	 * reference. Not carried by every provider: Amazon SNS refuses them.
	 */
	provider_options?: Record<string, unknown>
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
	media?: Array<string>
	validity?: number
	provider_options?: Record<string, unknown>
}

/** One problem {@link SmsCheck} found. `code` is the one a send would throw, where it would. */
export type SmsIssue = { code: string; message: string }

/** What `validate()` says about a text before it is sent. */
export interface SmsCheck {
	/** No issues: as far as anything local can tell, the provider would take it. */
	ok: boolean
	/** The provider it was checked against. */
	provider: string
	/** The recipients, in E.164, as they would be sent. */
	to: Array<string>
	/** GSM-7 (160 characters a segment) or UCS-2 (70), whichever the message forces. */
	encoding: "gsm7" | "ucs2"
	/** Segments it costs, the unit most providers bill. An estimate, not a quote. */
	segments: number
	/** Septets for GSM-7 (an extension character is two), UTF-16 units for UCS-2. */
	units: number
	/**
	 * The characters that forced UCS-2, when it was forced: a curly quote or a dash pasted
	 * from a document quietly halves what fits in a segment.
	 */
	ucs2_characters: Array<string>
	/** Every problem found, in the order a send would meet them. Empty when `ok`. */
	issues: Array<SmsIssue>
	/** For a failover chain, the check against each provider in it, in order. */
	chain?: Array<SmsCheck>
}

/** Constructor options shared by every SMS provider. */
export type SmsProviderOptions = TransportOptions<PreparedSms> & {
	/** Default field values applied when a send omits them. */
	default?: SmsDefaults
	/**
	 * Mask phone numbers in what leaves a send for somewhere else: a thrown error's message,
	 * stack and `raw`, and the message and response `after.send` and `on.error` are shown.
	 * `+447700900123` becomes `+4*********23`. Off by default; `sms.redact` in the config or
	 * `POSTBOI_SMS_REDACT=1` turns it on for every SMS provider. The text that is sent, and
	 * `before.send`, are never touched.
	 */
	redact?: boolean
}

/** Options for SMS providers that authenticate with a single API key or token. */
export type SmsApiKeyOptions = SmsProviderOptions & {
	/** The provider API key / token used to authenticate requests. */
	api_key: string
}
