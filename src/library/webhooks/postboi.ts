import type { WebhookAdapter, WebhookEventType, BounceDetail, AdapterModule } from "./index.js"
import type { Channel } from "../errors.js"
import { parse_json, engagement, to_date, svix_adapter_verify } from "./shared.js"
import { hmac_sha256, base64_encode, base64_decode } from "./crypto.js"

/**
 * The Postboi provider's webhook payload. The signing scheme is deliberately
 * standard-webhooks (Svix) compatible — `webhook-id` / `webhook-timestamp` /
 * `webhook-signature` headers, `whsec_…` secret from the Postboi dashboard.
 */
interface PostboiPayload {
	type: string
	created_at?: string
	data?: {
		message_id?: string
		from?: string
		to?: string
		subject?: string
		detail?: string
		bounce?: { category?: string; detail?: string }
		/** `email.received` only: the reply's body, and the send it answers. */
		html?: string
		text?: string
		in_reply_to?: string
		user_agent?: string
		ip?: string
		url?: string
		tags?: Array<string>
		timestamp?: string
		/** A form submission's form and fields, on every event about that send. */
		form?: { id?: string; name?: string }
		fields?: Array<unknown>
	}
}

/**
 * Wire type → normalized type. The prefix says which channel, and the suffix says what
 * happened — so one shared vocabulary covers all three: an SMS that reached the handset
 * is `delivered` exactly like an email that reached the inbox, and WhatsApp's read
 * receipt is the same fact as an email open.
 */
const TYPES: Record<string, WebhookEventType> = {
	"email.sent": "sent",
	"email.delivered": "delivered",
	"email.bounced": "bounced",
	"email.complained": "complained",
	"email.opened": "opened",
	"email.clicked": "clicked",
	"email.failed": "failed",
	"email.received": "received",
	"sms.sent": "sent",
	"sms.delivered": "delivered",
	"sms.failed": "failed",
	"whatsapp.sent": "sent",
	"whatsapp.delivered": "delivered",
	"whatsapp.read": "opened",
	"whatsapp.failed": "failed",
}

/**
 * The channel a wire type belongs to, from its own prefix — no second table to keep in
 * step. Undefined for `email.*`, which leaves `channel` unset: absent means email, and
 * a payload from a Postboi that predates channels shouldn't start claiming one.
 */
function channel_of(wire_type: string): Channel | undefined {
	const prefix = wire_type.slice(0, wire_type.indexOf("."))
	return prefix === "sms" || prefix === "whatsapp" ? prefix : undefined
}

const BOUNCE_CATEGORIES = new Set(["hard", "soft", "suppressed"])

function bounce(data: NonNullable<PostboiPayload["data"]>): BounceDetail | undefined {
	if (!data.bounce) return undefined
	const category = data.bounce.category
	return {
		category: category && BOUNCE_CATEGORIES.has(category) ? (category as never) : "unknown",
		detail: data.bounce.detail,
	}
}

/** Keep only the well-formed `[name, value]` pairs — the shape a handler destructures. */
function field_pairs(fields: Array<unknown>): Array<[string, string]> {
	return fields.filter(
		(pair): pair is [string, string] =>
			Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"
	)
}

const adapter: WebhookAdapter = {
	provider: "postboi",

	verify(ctx) {
		return svix_adapter_verify("postboi", ctx, "webhook")
	},

	normalize(body) {
		const payload = parse_json("postboi", body) as PostboiPayload
		const type = TYPES[payload.type]
		if (!type) return []

		const data = payload.data ?? {}
		const channel = channel_of(payload.type)
		return [
			{
				type,
				provider: "postboi",
				channel,
				// On a text-message event `to` is a number, so it goes where numbers go.
				phone: channel ? data.to : undefined,
				// An inbound reply is about the person who wrote it, and the id worth
				// carrying is the send they answered — not the inbound message's own.
				message_id: type === "received" ? data.in_reply_to : data.message_id,
				email: channel ? undefined : type === "received" ? data.from : data.to,
				timestamp: to_date(data.timestamp ?? payload.created_at),
				subject: data.subject,
				tags: data.tags,
				form:
					data.form && typeof data.form.id === "string" && typeof data.form.name === "string"
						? { id: data.form.id, name: data.form.name }
						: undefined,
				fields: Array.isArray(data.fields) ? field_pairs(data.fields) : undefined,
				url: data.url,
				bounce: type === "bounced" ? bounce(data) : undefined,
				body:
					type === "received" && (data.html || data.text)
						? { html: data.html, text: data.text }
						: undefined,
				...engagement(data.user_agent, data.ip),
				raw: payload,
			},
		]
	},
}

export default adapter

/** Build a realistic signed Postboi sample request — used by `mock_request` and tests. */
export const mock: AdapterModule["mock"] = async ({ type, secret, channel }) => {
	// Two wire types now share most normalized types, so the reverse lookup is scoped
	// by channel; without one, email is what a sample is about.
	const prefix = channel === "sms" || channel === "whatsapp" ? channel : "email"
	const postboi_type =
		Object.entries(TYPES).find(([wire, t]) => t === type && wire.startsWith(`${prefix}.`))?.[0] ??
		`${prefix}.delivered`
	const now = new Date().toISOString()
	const data: NonNullable<PostboiPayload["data"]> = {
		message_id: "mock-message-id",
		from: "mock@example.com",
		to: prefix === "email" ? "recipient@example.com" : "+15557770006",
		subject: "Mock subject",
		timestamp: now,
	}
	if (type === "opened") {
		data.user_agent =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
		data.ip = "192.0.2.1"
	}
	if (type === "clicked") {
		data.url = "https://example.com/pricing"
		data.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
		data.ip = "192.0.2.1"
	}
	if (type === "bounced") data.bounce = { category: "hard", detail: "mailbox unavailable" }
	if (type === "received") {
		data.from = "someone@example.com"
		data.to = "brisk-otter-cove@send.postboi.email"
		data.in_reply_to = "mock-message-id"
		data.text = "Thanks, that works for me."
	}

	const body = JSON.stringify({ type: postboi_type, created_at: now, data })
	const id = "whmsg_mock"
	const timestamp = String(Math.floor(Date.now() / 1000))
	const key = base64_decode(secret.replace(/^whsec_/, ""))
	const signature = base64_encode(await hmac_sha256(key, `${id}.${timestamp}.${body}`))

	return {
		body,
		headers: {
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": `v1,${signature}`,
			"content-type": "application/json",
		},
	}
}
