/**
 * Shared plumbing for the framework `<MailForm>` components (Svelte, React, Vue, Astro).
 * Everything here is framework-agnostic: the honeypot styling, the special-field mapping,
 * and the managed-captcha loader injection.
 */

/** Where the managed-captcha loader script lives. */
export const CAPTCHA_ORIGIN = "https://postboi.email"

/** Inline styling that hides the honeypot from humans without `display: none` (which smarter bots detect). */
export const honeypot_style = "position:absolute;left:-9999px;height:0;width:0;opacity:0"

/** The same styling as an object, for frameworks that take style objects (React). */
export const honeypot_style_object = {
	position: "absolute",
	left: "-9999px",
	height: 0,
	width: 0,
	opacity: 0,
} as const

/** The special-field props accepted by every `<MailForm>` — rendered as hidden `_x` inputs. */
export interface MailFormFields {
	/** Sets the email's subject via a hidden `_subject` field. */
	subject?: string
	/** Sets the recipient via a hidden `_to` field. */
	to?: string
	/** Sets the sender via a hidden `_from` field. */
	from?: string
	/** Sets the reply-to via a hidden `_reply_to` field. */
	reply_to?: string
	/** Sets the cc via a hidden `_cc` field (comma-separated). */
	cc?: string
	/** Sets the bcc via a hidden `_bcc` field (comma-separated). */
	bcc?: string
}

/** Map the field props to their hidden-input `[name, value]` pairs, skipping unset ones. */
export function special_fields(fields: MailFormFields): Array<[string, string]> {
	const entries: Array<[string, string | undefined]> = [
		["_subject", fields.subject],
		["_to", fields.to],
		["_from", fields.from],
		["_reply_to", fields.reply_to],
		["_cc", fields.cc],
		["_bcc", fields.bcc],
	]
	return entries.filter((entry): entry is [string, string] => Boolean(entry[1]))
}

const SCRIPT_MARKER = "data-postboi-captcha"

/**
 * Inject the managed-captcha loader script once per page. Safe to call from any number of
 * components and on the server (no-op without a DOM). The loader itself watches the DOM,
 * so forms mounted after injection — SPA navigations — still get their widget.
 */
export function ensure_captcha_script(key: string, origin: string = CAPTCHA_ORIGIN): void {
	if (typeof document === "undefined") return
	if (document.querySelector(`script[${SCRIPT_MARKER}]`)) return
	const tag = document.createElement("script")
	tag.src = `${origin.replace(/\/$/, "")}/captcha.js`
	tag.async = true
	tag.defer = true
	tag.setAttribute("data-key", key)
	tag.setAttribute(SCRIPT_MARKER, "")
	document.head.appendChild(tag)
}
