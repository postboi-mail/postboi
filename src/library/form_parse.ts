import type { FormName, FromAddress, SendOptions } from "./index.js"
import { HONEYPOT_FIELD } from "./form.js"
import { TURNSTILE_FIELD, TURNSTILE_REMOTE_FIELD } from "./captcha.js"
import { title, escape_html, escape_lines } from "./utils.js"

/**
 * The fields postboi reads as send options instead of rendering them: `_subject`,
 * `_reply_to`, the addressing below, and `_form` (which form the submission is filed under).
 */
export const SPECIAL_FIELDS = [
	"_to",
	"_from",
	"_reply_to",
	"_cc",
	"_bcc",
	"_subject",
	"_form",
] as const

/** The special fields that choose who a send goes to or is from. Ignored in a post unless the send passes `form_addressing: true`. */
export const FORM_ADDRESSING = ["_to", "_cc", "_bcc", "_from"] as const

/** The honeypot: a hidden input humans leave empty. Filled means a bot. */
export const HONEYPOT_FIELDS = [HONEYPOT_FIELD] as const

/** Where a Turnstile token arrives: the widget's own input, and the remote-form alias. */
export const CAPTCHA_FIELDS = [TURNSTILE_FIELD, TURNSTILE_REMOTE_FIELD] as const

/** How {@link parse_form} reads and renders a post. */
export type FormParseOptions = {
	/** Label formatting, as {@link SendOptions.formatter}. `title()` by default. */
	formatter?: SendOptions["formatter"]
	/** How a special field's value is decoded. Base64 values are decoded by default. */
	decode?: (value: string) => string
	/** Escapes a label (a field or fieldset name) for the table. `escape_html` by default. */
	escape_label?: (label: string) => string
	/** Escapes a value for the table. `escape_lines` (escape, then line breaks to `<br>`) by default. */
	escape_value?: (value: string) => string
	/** Fields rendered and returned at most; the rest are dropped. Unlimited by default. */
	max_fields?: number
	/** Characters kept of each rendered value. Unlimited by default. */
	max_value_length?: number
	/** Files kept as attachments. Unlimited by default. */
	max_files?: number
}

/** What {@link parse_form} found in a post. */
export type ParsedForm = {
	/** The special fields as send options, plus the rendered table as `body` when there are fields. */
	options: Partial<SendOptions>
	/** Non-empty files, in order. */
	attachments: Array<File>
	/** The rendered fields as the `[name, value]` pairs they came in as. */
	fields: Array<[string, string]>
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const UTF8 = new TextDecoder("utf-8", { fatal: true })
const LETTERS_DECODE_TO = /^(?=.*[ @.])\w[\w@&!?,.'-]+(?: [\w@&!?,.':;-]+)*$/

/**
 * Decode a special field's value when it is base64 of some text, and pass it through
 * otherwise. Plenty of plain values are valid base64 too: any word of four, eight or twelve
 * letters, like `Help`, `Test` or `Jobs`. Those decode to control bytes or broken UTF-8,
 * so a value is only decoded when what comes out reads as text.
 */
export function decode_special(str: string): string {
	const clean = str.replace(/[\r\n]+/g, "")
	if (!clean || !BASE64.test(clean)) return str
	let decoded: string
	try {
		decoded = UTF8.decode(Uint8Array.from(atob(clean), (char) => char.charCodeAt(0)))
	} catch {
		return str
	}
	// Control characters (a line break aside) mean it was never text.
	if (/[\p{Cc}]/u.test(decoded.replace(/\n/g, ""))) return str
	// A value of letters alone is far likelier a word than an encoding ("also" decodes to
	// "j[("), where base64 of real text almost always carries a digit, `+`, `/` or `=`. So
	// letters alone are decoded only into what an encoded field holds: words with single
	// spaces between them, or an address.
	if (/^[A-Za-z]+$/.test(clean) && !LETTERS_DECODE_TO.test(decoded)) return str
	return decoded
}

/**
 * Parse a form post the way every provider does: the {@link SPECIAL_FIELDS} become send
 * options, files become attachments, and the rest render into a compact HTML table grouped
 * by the `fieldset→field` key syntax, escaped. Honeypot and captcha fields aren't handled
 * here: providers strip them first (see {@link HONEYPOT_FIELDS} and {@link CAPTCHA_FIELDS}).
 *
 * Exported so code that receives the same posts outside a send (Postboi's hosted form
 * endpoints) renders them identically, with its own escaping and limits.
 */
export function parse_form(
	form_data: Iterable<[string, FormDataEntryValue]>,
	{
		formatter,
		decode = decode_special,
		escape_label = escape_html,
		escape_value = escape_lines,
		max_fields = Infinity,
		max_value_length = Infinity,
		max_files = Infinity,
	}: FormParseOptions = {}
): ParsedForm {
	const options: Partial<SendOptions> = {}
	const attachments: Array<File> = []
	const fields: Array<[string, string]> = []
	const grouped = new Map<string, Map<string, string | Array<string>>>()
	let stored = 0

	// choose formatter behaviour
	const identity = (s: string) => s
	let format_fieldset: (s: string) => string
	let format_name: (s: string) => string
	if (formatter === null || formatter === false) {
		format_fieldset = identity
		format_name = identity
	} else {
		const fset = formatter?.fieldset
		const fname = formatter?.name
		format_fieldset = fset === undefined ? title : fset ? fset : identity
		format_name = fname === undefined ? title : fname ? fname : identity
	}

	for (const [key, value] of form_data) {
		if (value && typeof value === "object" && "name" in value && "type" in value) {
			const file = value as File
			// ignore empty file inputs (no name or zero length)
			const size = (file as unknown as { size?: number }).size ?? 0
			if (file.name && size > 0 && attachments.length < max_files) attachments.push(file)
		} else if (typeof value === "string") {
			switch (key) {
				case "_to":
					options.to = decode(value)
					continue
				case "_subject":
					options.subject = decode(value)
					continue
				case "_from":
					// FormData carries arbitrary strings; a project-level `Register`
					// augmentation can narrow `from` below `string`, hence the cast.
					options.from = decode(value) as FromAddress
					continue
				case "_reply_to":
					options.reply_to = decode(value)
					continue
				case "_cc":
					options.cc = decode(value)
					continue
				case "_bcc":
					options.bcc = decode(value)
					continue
				case "_form":
					// The Postboi form to file the submission under, so one route can serve every
					// form on a site. A registered FormName narrows below `string`, hence the cast.
					options.form = decode(value) as FormName
					continue
			}

			if (++stored > max_fields) continue
			const kept = value.slice(0, max_value_length)
			fields.push([key, kept])
			const [fieldset, field] = key.split("→")
			if (field) {
				if (!grouped.has(fieldset)) grouped.set(fieldset, new Map())
				const map = grouped.get(fieldset)!
				const existing = map.get(field)
				if (existing) {
					if (Array.isArray(existing)) existing.push(kept)
					else map.set(field, [existing, kept])
				} else {
					map.set(field, kept)
				}
			} else {
				if (!grouped.has("general")) grouped.set("general", new Map())
				const map = grouped.get("general")!
				const existing = map.get(key)
				if (existing) {
					if (Array.isArray(existing)) existing.push(kept)
					else map.set(key, [existing, kept])
				} else {
					map.set(key, kept)
				}
			}
		}
	}

	if (grouped.size > 0) {
		const rows: Array<string> = []
		for (const [fieldset, entries] of grouped) {
			if (entries.size > 0) {
				if (fieldset !== "general") {
					// Labels derive from submitted field names, so they need escaping too —
					// and formatters are documented as label→label string transforms, not
					// a way to inject markup.
					const header_label = escape_label(format_fieldset(fieldset))
					rows.push(
						`<tr><td colspan="2" style="padding: 15px 0 10px 0; font-weight: bold; font-size: 16px; border-bottom: 1px solid #ccc;">${header_label}</td></tr>`
					)
				}
				const field_rows = Array.from(entries.entries()).map(([field, value]) => {
					const label = escape_label(format_name(field))
					const display = Array.isArray(value)
						? `<ul style="margin: 0; padding-left: 20px;">${value.map((v) => `<li>${escape_value(v)}</li>`).join("")}</ul>`
						: escape_value(value)
					return `<tr><td style="padding: 5px 10px 5px 0; vertical-align: top;">${label}</td><td style="padding: 5px 0;">${display}</td></tr>`
				})
				rows.push(...field_rows)
				if (fieldset !== "general")
					rows.push(`<tr><td colspan="2" style="padding: 10px 0;"></td></tr>`)
			}
		}
		options.body = `<table style="border-collapse: collapse; width: auto;">${rows.join("")}</table>`
	}

	return { options, attachments, fields }
}
