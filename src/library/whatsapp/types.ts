/**
 * The WhatsApp channel's public types.
 *
 * Free of runtime imports so the package root can widen `Hooks` to include
 * {@link PreparedWhatsapp} without pulling a WhatsApp provider into the email module graph.
 *
 * The shape that makes WhatsApp unlike SMS: the **24-hour customer service window**. A
 * business may send free-form text only within 24 hours of the user's last inbound
 * message; outside it, only pre-approved **templates**. Most transactional sends happen
 * outside any window, so the template path is the normal case, not the fallback — which
 * is why `template` sits beside `message` rather than buried in provider options.
 */
import type { TransportOptions } from "../transport.js"
import type { Phone } from "../sms/types.js"

export type { Phone } from "../sms/types.js"

/** Default values applied to every WhatsApp send when the option is omitted. */
export type WhatsappDefaults = {
	to?: Phone
	/**
	 * Your WhatsApp sender number in E.164 (Twilio; the `whatsapp:` prefix is added for
	 * you). The Meta Cloud API ignores this — there the sender is the `phone_number_id`
	 * the provider is constructed with.
	 */
	from?: string
	/**
	 * Country used to resolve national-format numbers — an ISO 3166-1 alpha-2 code (`"GB"`)
	 * or a dialling code (`"+44"`). Without it, anything that isn't already international
	 * is rejected rather than guessed at.
	 */
	country?: string
	/**
	 * Template language code (`"en"`, `"en_GB"`, …) — must match a language the template
	 * was approved in. Meta only; defaults to `"en"`.
	 */
	language?: string
}

/** Options accepted by `whatsapp(...)` and every WhatsApp provider's `send`. */
export interface WhatsappOptions {
	to?: Phone
	/** Sender override (Twilio). See {@link WhatsappDefaults.from}. */
	from?: string
	/**
	 * Free-form text. **Only deliverable inside the 24-hour customer service window** —
	 * outside it the provider rejects with `code: "outside_window"`, which a `send()`
	 * fallback chain treats as "try the next channel".
	 */
	message?: string
	/**
	 * A pre-approved template, by the name it was approved under (Meta) or its Content
	 * SID, `HX…` (Twilio). The deliverable-anytime path. Exactly one of `message` or
	 * `template` per send.
	 */
	template?: string
	/**
	 * Template variables. Named keys for templates approved with named parameters
	 * (`{ name: "Ada" }`), or numeric keys for positional ones (`{ 1: "Ada" }`).
	 */
	variables?: Record<string, string>
	/** Template language code for this send (Meta). */
	language?: string
	/** Override the default country for a national-format number in this send. */
	country?: string
}

/** A fully-resolved WhatsApp message handed to a provider's `build_request`. */
export interface PreparedWhatsapp {
	/** The recipient in E.164 form (`+447788223344`) — provider prefixes are added later. */
	to: string
	from?: string
	message?: string
	template?: string
	variables?: Record<string, string>
	language: string
}

/** Constructor options shared by every WhatsApp provider. */
export type WhatsappProviderOptions = TransportOptions<PreparedWhatsapp> & {
	/** Default field values applied when a send omits them. */
	default?: WhatsappDefaults
}
