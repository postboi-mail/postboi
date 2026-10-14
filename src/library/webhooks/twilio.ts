/**
 * Twilio webhooks — status callbacks and inbound messages, for SMS and WhatsApp.
 * https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
 * https://www.twilio.com/docs/messaging/guides/webhook-request
 *
 * `poll()` still works and needs nothing set up; this is the other way in, for an app
 * that would rather be told. Status callbacks go wherever the send said (`status_callback`
 * on the provider, or the Messaging Service's own setting), and inbound messages wherever
 * the number or the service says "A message comes in". Point both at `receive()`.
 *
 * **Verification is `X-Twilio-Signature`**: base64 HMAC-SHA1, keyed with the account's
 * auth token, over the URL Twilio called followed by every POST parameter, sorted by name,
 * each name and value appended with nothing between. The secret is therefore the auth token
 * itself, read from `TWILIO_WEBHOOK_SECRET` and then `TWILIO_AUTH_TOKEN`. Because the URL is
 * signed, it has to be the one Twilio was given: behind a proxy or a tunnel, where the
 * request's own URL is a different host or scheme, pass it as `receive(request, { url })`.
 * Twilio signs a URL with or without its default port depending on how it was entered, so
 * both are tried. A JSON body is signed differently: the URL carries `bodySHA256`, the hex
 * hash of the body, and the signature covers the URL alone. Nothing is timestamped, so
 * there is no replay window; a redelivery is the same request, and `message_id` plus `type`
 * is what to deduplicate on.
 *
 * **One request is one event.** A status callback is `MessageStatus` on the message's own
 * sid and maps exactly as the poll does (`sent`, `delivered`, `failed`, and WhatsApp's
 * `read` as `opened`); the in-flight statuses are dropped. An inbound message carries
 * `Body`, and goes through `inbound_event`: STOP is `unsubscribed`, START `resubscribed`,
 * anything else `received`, and a HELP says so in `keyword`. Where Twilio's Advanced Opt-Out
 * has already judged the message (`OptOutType`), that verdict is used rather than matching
 * the words, which is the one thing a poll can't see.
 */
import { PostboiError } from "../index.js"
import type { AdapterModule, WebhookAdapter, WebhookEvent, WebhookEventType } from "./index.js"
import type { SmsKeyword } from "../sms/opt_out.js"
import { WebhookVerificationError } from "./errors.js"
import { base64_encode, hex_encode, hmac_sha1, timing_safe_equal } from "./crypto.js"
import { inbound_event } from "./shared.js"
import { address, TYPES } from "./poll_twilio.js"

/** The parameters a request carried, in the order they arrived. */
type Params = Array<[string, string]>

/** Twilio's word for a keyword on `OptOutType` → ours. */
const OPT_OUT_TYPES: Record<string, SmsKeyword> = { STOP: "stop", START: "start", HELP: "help" }

const encoder = new TextEncoder()

/** The hex SHA-256 of a body, which Twilio puts in `bodySHA256` for a JSON request. */
async function sha256_hex(body: string): Promise<string> {
	return hex_encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body))))
}

/**
 * `X-Twilio-Signature` for a URL and its parameters: the URL, then each name and its
 * value, sorted by name (and a repeated name by value), keyed with the auth token.
 */
export async function twilio_signature(auth_token: string, url: string, params: Params) {
	const sorted = [...params].sort(([a, x], [b, y]) =>
		a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1
	)
	const data = url + sorted.map(([name, value]) => name + value).join("")
	return base64_encode(await hmac_sha1(auth_token, data))
}

/**
 * The spellings of a URL Twilio may have signed: as given, and with its default port
 * added or taken away. Twilio signs what was typed into the console, and a URL's `href`
 * drops a default port that was typed, so a signature over `:443` can't be checked
 * against `href` alone.
 */
function url_variants(url: URL): Array<string> {
	const variants = [url.href]
	const fallback = url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : ""
	if (!fallback || url.port) return variants
	variants.push(`${url.protocol}//${url.hostname}:${fallback}${url.pathname}${url.search}`)
	return variants
}

/** Is this a JSON request Twilio signed by its body hash? */
function json_mode(headers: Headers, url: URL): boolean {
	const type = headers.get("content-type")?.toLowerCase() ?? ""
	return type.includes("application/json") && url.searchParams.has("bodySHA256")
}

/** A JSON body's top-level fields as parameters, so both encodings normalize alike. */
function json_params(body: string): Params {
	let parsed: unknown
	try {
		parsed = JSON.parse(body)
	} catch {
		parsed = undefined
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new PostboiError({
			provider: "twilio",
			message: "twilio webhook payload is not a JSON object",
			code: "invalid_payload",
			raw: body,
		})
	}
	return Object.entries(parsed).map(([name, value]) => [
		name,
		typeof value === "string" ? value : JSON.stringify(value),
	])
}

/** What one request said, read as name → value (a repeated name keeps its first value). */
function fields(body: string, headers: Headers, url: URL): Record<string, string> {
	const params = json_mode(headers, url) ? json_params(body) : [...new URLSearchParams(body)]
	const out: Record<string, string> = {}
	for (const [name, value] of params) if (!(name in out)) out[name] = value
	return out
}

/** One status callback as an event, or nothing for a status that isn't one. */
function normalize_status(f: Record<string, string>, sid: string, status: string) {
	const type = TYPES[status]
	if (!type) return undefined
	const { channel, phone } = address(f.To)
	const code = f.ErrorCode || undefined
	return {
		type,
		provider: "twilio",
		channel,
		phone,
		message_id: sid,
		// As in the poll: a text has no bounce classification, so the carrier's code goes
		// in `detail`. A callback carries the code and not Twilio's words for it.
		bounce: type === "failed" ? { category: "unknown", detail: code } : undefined,
		raw: f,
	} satisfies WebhookEvent
}

/** One inbound message as an event, with Twilio's own keyword verdict where it gave one. */
function normalize_inbound(f: Record<string, string>, sid: string): WebhookEvent {
	const { channel, phone } = address(f.From)
	return inbound_event({
		provider: "twilio",
		channel,
		phone,
		text: f.Body,
		message_id: sid,
		// A WhatsApp reply to one of your messages names it.
		replied_to: f.OriginalRepliedMessageSid || undefined,
		keyword: OPT_OUT_TYPES[f.OptOutType?.toUpperCase() ?? ""],
		raw: f,
	})
}

/**
 * Empty TwiML. Twilio reads the reply to an inbound message as instructions, so a JSON
 * answer is "Invalid Content-Type" in its debugger; this says "nothing to send back".
 * A status callback's reply is ignored, so the same answer serves both.
 */
const NO_REPLY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

const adapter: WebhookAdapter = {
	provider: "twilio",
	secret_env: ["TWILIO_AUTH_TOKEN"],

	accepted() {
		return new Response(NO_REPLY, { status: 200, headers: { "content-type": "text/xml" } })
	},

	async verify(ctx) {
		const presented = ctx.headers.get("x-twilio-signature")
		if (!ctx.secret || !presented) {
			throw new WebhookVerificationError({
				provider: "twilio",
				message: presented
					? "No auth token configured for twilio. Set TWILIO_WEBHOOK_SECRET or TWILIO_AUTH_TOKEN, or pass { secret }."
					: "twilio webhook is missing its X-Twilio-Signature header",
				code: presented ? "missing_secret" : "invalid_signature",
			})
		}
		let params: Params = [...new URLSearchParams(ctx.body)]
		if (json_mode(ctx.headers, ctx.url)) {
			const claimed = ctx.url.searchParams.get("bodySHA256")?.toLowerCase() ?? ""
			if (!timing_safe_equal(await sha256_hex(ctx.body), claimed)) {
				throw new WebhookVerificationError({
					provider: "twilio",
					message: "twilio webhook body does not match its bodySHA256",
					code: "invalid_signature",
				})
			}
			params = []
		}
		for (const url of url_variants(ctx.url)) {
			if (timing_safe_equal(await twilio_signature(ctx.secret, url, params), presented)) return
		}
		throw new WebhookVerificationError({
			provider: "twilio",
			message:
				"twilio webhook signature did not match. Check the auth token, and that the URL is the one Twilio calls (pass { url } behind a proxy).",
			code: "invalid_signature",
		})
	},

	normalize(body, ctx) {
		const f = fields(body, ctx.headers, ctx.url)
		const sid = f.MessageSid || f.SmsSid
		if (!sid) {
			throw new PostboiError({
				provider: "twilio",
				message: "twilio webhook payload has no MessageSid",
				code: "invalid_payload",
				raw: f,
			})
		}
		const status = f.MessageStatus || f.SmsStatus
		// An inbound message carries its words and is "received"; a status callback carries
		// MessageStatus and no Body.
		if ("Body" in f && (!status || status === "received" || status === "receiving")) {
			return [normalize_inbound(f, sid)]
		}
		const event = status ? normalize_status(f, sid, status) : undefined
		return event ? [event] : []
	},
}

export default adapter

/** Build a Twilio sample request, signed with `secret` as the auth token. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url, channel }) => {
	const whatsapp = channel === "whatsapp"
	const person = whatsapp ? "whatsapp:+15557770006" : "+15557770006"
	const ours = whatsapp ? "whatsapp:+15551110001" : "+15551110001"
	const replies: Partial<Record<WebhookEventType, string>> = {
		unsubscribed: "STOP",
		resubscribed: "START",
		received: "Thanks, see you then",
	}
	const reply = replies[type]
	// The one table, read backwards, so the sample can't drift from the mapping.
	const status = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivered"
	const params: Params =
		reply === undefined
			? [
					["MessageSid", "SM00000000000000000000000000000000"],
					["MessageStatus", status],
					["To", person],
					["From", ours],
					["AccountSid", "AC00000000000000000000000000000000"],
					...(status === "undelivered" || status === "failed"
						? ([["ErrorCode", "30006"]] as Params)
						: []),
				]
			: [
					["MessageSid", "SM11111111111111111111111111111111"],
					["SmsStatus", "received"],
					["Body", reply],
					["From", person],
					["To", ours],
					["NumMedia", "0"],
					["AccountSid", "AC00000000000000000000000000000000"],
				]
	return {
		body: new URLSearchParams(params).toString(),
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			// Signed over the URL as receive() will read it back, so a bare origin's slash
			// and a host's case can't make the sample fail its own check.
			"x-twilio-signature": await twilio_signature(secret, new URL(url).href, params),
		},
	}
}
