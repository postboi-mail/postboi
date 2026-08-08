/**
 * Phone number normalisation and GSM segment counting.
 *
 * Deliberately *not* a libphonenumber port. Full national-format parsing needs a metadata
 * table per country and megabytes of rules; this handles the shapes that are unambiguous
 * (`+…`, `00…`, a national number with a trunk `0` and a known country) and **throws
 * loudly** rather than guessing anywhere else. A wrong guess here sends a text to a
 * stranger, which is worse than an error.
 */
import { PostboiError } from "../errors.js"

/**
 * Dialling codes for the countries we can resolve by ISO 3166-1 alpha-2. Deliberately not
 * exhaustive — anything missing is served by passing the dialling code directly
 * (`country: "+353"`), which is why an unknown code is an error rather than a silent
 * fallback.
 */
const DIALLING_CODES: Record<string, string> = {
	AE: "971",
	AR: "54",
	AT: "43",
	AU: "61",
	BE: "32",
	BG: "359",
	BR: "55",
	CA: "1",
	CH: "41",
	CL: "56",
	CN: "86",
	CO: "57",
	CY: "357",
	CZ: "420",
	DE: "49",
	DK: "45",
	EE: "372",
	EG: "20",
	ES: "34",
	FI: "358",
	FR: "33",
	GB: "44",
	GR: "30",
	HK: "852",
	HR: "385",
	HU: "36",
	ID: "62",
	IE: "353",
	IL: "972",
	IN: "91",
	IS: "354",
	IT: "39",
	JP: "81",
	KE: "254",
	KR: "82",
	LT: "370",
	LU: "352",
	LV: "371",
	MA: "212",
	MT: "356",
	MX: "52",
	MY: "60",
	NG: "234",
	NL: "31",
	NO: "47",
	NZ: "64",
	PH: "63",
	PK: "92",
	PL: "48",
	PT: "351",
	RO: "40",
	RS: "381",
	SA: "966",
	SE: "46",
	SG: "65",
	SI: "386",
	SK: "421",
	TH: "66",
	TR: "90",
	TW: "886",
	UA: "380",
	US: "1",
	VN: "84",
	ZA: "27",
}

/** Strip everything a human might type around the digits: spaces, dashes, dots, brackets. */
function digits_only(value: string): string {
	return value.replace(/[\s\-().]/g, "")
}

/**
 * Resolve a configured country into a bare dialling code. Accepts an ISO 3166-1 alpha-2
 * code (`"GB"`), a dialling code with or without the plus (`"+44"`, `"44"`).
 */
export function dialling_code(country: string): string {
	const value = country.trim()
	if (/^\+?\d{1,4}$/.test(value)) return value.replace(/^\+/, "")
	const code = DIALLING_CODES[value.toUpperCase()]
	if (!code) {
		throw new PostboiError({
			provider: "postboi",
			channel: "sms",
			code: "unknown_country",
			message: `Unknown SMS country "${country}". Use an ISO country code we know (e.g. "GB") or pass the dialling code directly (e.g. "+44").`,
		})
	}
	return code
}

/**
 * Dialling codes where the trunk `0` is kept when dialling internationally. Italy's leading
 * zero is part of the number itself (+39 02… is a Milan landline), so stripping it reaches
 * nobody — the opposite of the UK/EU norm.
 */
const TRUNK_ZERO_KEPT = new Set(["39"])

/** Message the ambiguous-number error carries, kept in one place so tests can assert on it. */
function ambiguous(value: string): PostboiError {
	return new PostboiError({
		provider: "postboi",
		channel: "sms",
		code: "ambiguous_number",
		message:
			`Cannot tell what country "${value}" belongs to. Write it in full international form ` +
			`("+447788223344"), or set a default country via POSTBOI_SMS_COUNTRY or ` +
			`\`sms.default.country\` in postboi.config.`,
	})
}

/**
 * Normalise a phone number to E.164 (`+` followed by 8–15 digits).
 *
 * Definitive shapes need no country: a leading `+`, or a leading `00` international prefix.
 * A national number needs `country` — a single leading `0` is treated as a trunk prefix and
 * stripped, which is right for the UK and most of Europe and harmless where there isn't one.
 * Italy is the exception (its zero is part of the number) and is kept.
 *
 * **The ambiguous case**, and the one worth knowing about: bare digits with no `+` and no
 * leading `0` could be a national number *or* an international one someone forgot the `+`
 * on. We treat it as international when it already starts with the default country's
 * dialling code and at least seven digits remain after it — so `447788223344` with `GB`
 * resolves to `+447788223344`, not `+4444…`. Anything else is national. Pass `+` to be
 * certain.
 */
export function to_e164(input: string | number, country?: string): string {
	// "(0)" in printed numbers ("+44 (0) 7788 223344") marks a trunk prefix to *omit* when
	// dialling internationally. Handled before digits_only strips the brackets — after
	// that the zero is indistinguishable from a real digit, and "+4407788223344" passes
	// length validation while reaching nobody.
	const cleaned = typeof input === "number" ? input : input.replace(/\(0\)/g, "")
	const raw = typeof cleaned === "number" ? String(cleaned) : digits_only(cleaned.trim())
	if (!raw) throw ambiguous(String(input))

	// A number literal can never carry a "+", so it's only ever digits.
	if (raw.startsWith("+")) return validate(raw.slice(1), input)
	if (raw.startsWith("00")) return validate(raw.slice(2), input)
	if (!/^\d+$/.test(raw)) throw ambiguous(String(input))

	if (!country) throw ambiguous(String(input))
	const code = dialling_code(country)

	// National number with a trunk prefix — the common UK/EU shape. Italy is the exception:
	// its leading zero is part of the subscriber number, not a prefix, so +39 keeps it.
	if (raw.startsWith("0")) {
		if (TRUNK_ZERO_KEPT.has(code)) return validate(code + raw, input)
		return validate(code + raw.slice(1), input)
	}
	// Already carries the country code (someone dropped the "+"). The length guard is what
	// stops a short national number that happens to begin with the dialling code being read
	// as international: seven digits is the floor for a plausible subscriber number, and the
	// case this exists for (`447788223344` under GB) leaves ten.
	if (raw.startsWith(code) && raw.length - code.length >= 7) return validate(raw, input)
	return validate(code + raw, input)
}

/** Check the digit count is plausible for E.164 and return the `+`-prefixed number. */
function validate(digits: string, original: string | number): string {
	if (!/^\d{8,15}$/.test(digits)) {
		throw new PostboiError({
			provider: "postboi",
			channel: "sms",
			code: "invalid_number",
			message: `"${original}" is not a valid phone number — E.164 allows 8 to 15 digits, got ${digits.length}.`,
		})
	}
	return `+${digits}`
}

// The GSM 03.38 basic alphabet, plus the extension table (each extension character costs
// two septets). Anything outside both forces the whole message into UCS-2.
const GSM_BASIC =
	"@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
	"¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
const GSM_EXTENDED = "^{}\\[~]|€"

/** Is every character in `text` representable in GSM 03.38? */
export function is_gsm7(text: string): boolean {
	for (const char of text) {
		if (!GSM_BASIC.includes(char) && !GSM_EXTENDED.includes(char)) return false
	}
	return true
}

/**
 * How many SMS segments `text` costs, and the encoding it forces.
 *
 * Worth having beyond validation: segments are the unit providers actually bill, so this is
 * what a cost-aware `send()` needs in order to compare SMS against a channel that bills per
 * message (see the RCS notes in CHANNELS.md).
 */
export function segments(text: string): {
	count: number
	encoding: "gsm7" | "ucs2"
	units: number
} {
	if (is_gsm7(text)) {
		let units = 0
		for (const char of text) units += GSM_EXTENDED.includes(char) ? 2 : 1
		const count = units <= 160 ? 1 : Math.ceil(units / 153)
		return { count: Math.max(count, 1), encoding: "gsm7", units }
	}
	// UCS-2 counts UTF-16 code units, so an emoji outside the BMP costs two.
	const units = text.length
	const count = units <= 70 ? 1 : Math.ceil(units / 67)
	return { count: Math.max(count, 1), encoding: "ucs2", units }
}
