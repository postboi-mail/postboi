/**
 * Keywords — the words a person texts back to say "stop", "start again" or "help".
 *
 * Every carrier and every provider recognises the same short list, because the CTIA
 * (US) and the UK networks settled on it years ago and everyone else copied it. A
 * reply is an opt-out when its **whole** trimmed body is one of these words, case
 * and trailing punctuation aside: "STOP" and "stop." opt out, "please stop texting
 * me" does not — that one is a person to talk to, not a flag to set.
 *
 * Used by every adapter that reads inbound texts (see `inbound_event` in
 * `webhooks/shared.ts`), and exported from the package root for anyone handling their
 * own inbound webhook.
 */

/** The industry-standard opt-out keywords, plus the French one Canada requires. */
export const OPT_OUT_KEYWORDS: ReadonlyArray<string> = [
	"STOP",
	"STOPALL",
	"UNSUBSCRIBE",
	"CANCEL",
	"END",
	"QUIT",
	"ARRET",
]

/**
 * The opt-in keywords — what a person who texted STOP texts to take it back. `YES` is left
 * out on purpose, although Twilio's Advanced Opt-Out counts it: it is also how people answer
 * "Reply YES to confirm", and reading every confirmation as a resubscribe would put people
 * back on lists they never asked to rejoin. Where Twilio says a YES was an opt-in
 * (`OptOutType`), its webhook adapter believes it.
 */
export const OPT_IN_KEYWORDS: ReadonlyArray<string> = ["START", "UNSTOP"]

/**
 * The help keywords. Carriers expect an answer to these (who you are and how to stop), so a
 * HELP is a message somebody's code has to read rather than one to leave in the provider.
 */
export const HELP_KEYWORDS: ReadonlyArray<string> = ["HELP", "INFO"]

/** Which keyword a whole message is: an opt-out, an opt-in, or a request for help. */
export type SmsKeyword = "stop" | "start" | "help"

/** The message as a keyword would be spelled: trimmed, unpunctuated, upper case, unaccented. */
function as_keyword(text: string): string {
	const word = text
		.trim()
		.replace(/[.!?,;:]+$/u, "")
		.trim()
		.toUpperCase()
	// "ARRÊT" with its circumflex is how a French speaker types it; the keyword list
	// carries the bare form the carriers document, so fold the accent before matching.
	return word.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

/**
 * Which keyword this reply is, if it is one: the whole message, trimmed and stripped of
 * trailing punctuation, matched in any case against {@link OPT_OUT_KEYWORDS},
 * {@link OPT_IN_KEYWORDS} and {@link HELP_KEYWORDS}.
 *
 * ```ts
 * sms_keyword("Stop.") // "stop"
 * sms_keyword("unstop") // "start"
 * sms_keyword("HELP") // "help"
 * sms_keyword("Can you help?") // undefined: a sentence, not a keyword
 * ```
 */
export function sms_keyword(text: string | undefined | null): SmsKeyword | undefined {
	if (!text) return undefined
	const word = as_keyword(text)
	if (OPT_OUT_KEYWORDS.includes(word)) return "stop"
	if (OPT_IN_KEYWORDS.includes(word)) return "start"
	if (HELP_KEYWORDS.includes(word)) return "help"
	return undefined
}

/**
 * Is this reply an opt-out? True when the whole message, trimmed and stripped of trailing
 * punctuation, is one of {@link OPT_OUT_KEYWORDS} in any case.
 *
 * ```ts
 * is_opt_out("STOP") // true
 * is_opt_out("stop.") // true
 * is_opt_out("Please stop") // false — a sentence, not a keyword
 * ```
 */
export function is_opt_out(text: string | undefined | null): boolean {
	return sms_keyword(text) === "stop"
}
