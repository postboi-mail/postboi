import type {
	WebhookAdapter,
	WebhookEvent,
	WebhookEventType,
	BounceDetail,
	AdapterModule,
} from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { parse_json, engagement, to_date } from "./shared.js"
import {
	hmac_sha256,
	hex_encode,
	base64_encode,
	timing_safe_equal,
	whsec_key_candidates,
} from "./crypto.js"

/**
 * Sequenzy webhook envelope — https://docs.sequenzy.com/integrations/outbound-webhooks
 * Every delivery is `{ id, type, object, metric, created_at, data }`; `data` is per event.
 */
interface SequenzyPayload {
	id?: string
	type?: string
	object?: string
	metric?: string
	created_at?: string
	data?: {
		/** The send record `send()` returned as `emailSendId`. */
		email_send_id?: string
		/** The upstream mail server's id — not what `send()` returned. */
		message_id?: string
		campaign_id?: string
		subscriber_id?: string
		external_id?: string
		recipient?: string
		subject?: string
		email_type?: string
		metadata?: Record<string, unknown>
		/** clicked */
		url?: string
		link?: string
		/** opened / clicked */
		user_agent?: string
		ip?: string
		ip_address?: string
		/** bounced */
		bounce_type?: string
		bounce_classification?: string
		reason?: string
		bounce_reason?: string
		/** failed */
		failure?: { code?: string; message?: string }
		/** replied */
		in_reply_to?: string
		from_email?: string
		from_name?: string
		body_text?: string
		body_html?: string
		stripped_text?: string
		received_at?: string
	}
}

const TYPES: Record<string, WebhookEventType> = {
	"email.sent": "sent",
	"email.delivered": "delivered",
	"email.delivery_delayed": "delayed",
	"email.bounced": "bounced",
	"email.failed": "failed",
	"email.complained": "complained",
	"email.opened": "opened",
	"email.clicked": "clicked",
	"email.unsubscribed": "unsubscribed",
	"email.replied": "received",
}

/**
 * Allowed clock skew, in seconds. Sequenzy documents no window of its own; five minutes
 * is the standard-webhooks default its `v1=` / `whsec_` conventions are borrowed from.
 */
const TOLERANCE_S = 300

/**
 * Sequenzy's own definition: `email.bounced` means the receiving server judged the
 * mailbox bad and the address is now suppressed — transient trouble surfaces as
 * `delivery_delayed` and then `failed` instead. So a bounce with no classification is a
 * hard one, and only an explicit soft label says otherwise.
 */
function bounce(data: NonNullable<SequenzyPayload["data"]>): BounceDetail {
	const kind = (data.bounce_type ?? data.bounce_classification ?? "").toLowerCase()
	const category = /soft|transient/.test(kind)
		? "soft"
		: /suppress/.test(kind)
			? "suppressed"
			: "hard"
	return { category, detail: data.reason ?? data.bounce_reason }
}

/** Every `v1=` value in the header — one per active signing secret during a rotation. */
function parse_signatures(header: string): Array<string> {
	const signatures: Array<string> = []
	for (const part of header.split(",")) {
		const eq = part.indexOf("=")
		if (eq < 0) continue
		if (part.slice(0, eq).trim() !== "v1") continue
		const value = part.slice(eq + 1).trim()
		if (value) signatures.push(value)
	}
	return signatures
}

/**
 * Sequenzy webhook adapter. Verification is HMAC-SHA256 of `v1:{timestamp}:{body}` with
 * the endpoint's signing secret, carried as `X-Sequenzy-Signature: v1=…` (several `v1=`
 * values while secrets rotate) beside `X-Sequenzy-Timestamp`, which is checked against
 * the clock for replay protection. The configured secret may likewise hold several
 * whitespace- or comma-separated values, so one handler can ride out a rotation.
 */
const adapter: WebhookAdapter = {
	provider: "sequenzy",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "sequenzy",
				message:
					"No webhook signing secret configured for sequenzy. Set SEQUENZY_WEBHOOK_SECRET to the endpoint's whsec_… signing secret, or pass { secret }.",
				code: "missing_secret",
			})
		}
		const timestamp = ctx.headers.get("x-sequenzy-timestamp")?.trim()
		const header = ctx.headers.get("x-sequenzy-signature")
		const signatures = header ? parse_signatures(header) : []
		if (!timestamp || signatures.length === 0) {
			throw new WebhookVerificationError({
				provider: "sequenzy",
				message:
					"sequenzy webhook is missing its X-Sequenzy-Signature or X-Sequenzy-Timestamp header",
				code: "invalid_signature",
			})
		}
		const seconds = Number(timestamp)
		const now = Math.floor(Date.now() / 1000)
		if (!Number.isFinite(seconds) || Math.abs(now - seconds) > TOLERANCE_S) {
			throw new WebhookVerificationError({
				provider: "sequenzy",
				message: "sequenzy webhook timestamp is outside the accepted tolerance (replay protection)",
				code: "stale_timestamp",
			})
		}
		const payload = `v1:${timestamp}:${ctx.body}`
		const secrets = ctx.secret.split(/[\s,]+/).filter(Boolean)
		const expected: Array<string> = []
		for (const secret of secrets) {
			for (const key of whsec_key_candidates(secret)) {
				// The docs leave the digest's encoding unsaid; hex and base64 are both derived
				// from the same key, so accepting either costs nothing.
				const digest = await hmac_sha256(key, payload)
				expected.push(hex_encode(digest), base64_encode(digest))
			}
		}
		const ok = signatures.some((signature) =>
			expected.some((candidate) => timing_safe_equal(signature, candidate))
		)
		if (!ok) {
			throw new WebhookVerificationError({
				provider: "sequenzy",
				message: "sequenzy webhook signature did not match",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const payload = parse_json("sequenzy", body) as SequenzyPayload
		const type = payload.type ? TYPES[payload.type] : undefined
		// campaign.*, sms.*, subscriber.*, sequence.* and poll.* aren't email delivery events.
		if (!type) return []
		const data = payload.data ?? {}

		if (type === "received") {
			// A reply: `email` is whoever wrote back, and `message_id` is the send they
			// answered — Sequenzy's own send id, the one `send()` returned.
			return [
				{
					type,
					provider: "sequenzy",
					message_id: data.email_send_id,
					email: data.from_email,
					timestamp: to_date(data.received_at ?? payload.created_at),
					subject: data.subject,
					body:
						data.body_html || data.body_text || data.stripped_text
							? { html: data.body_html, text: data.body_text ?? data.stripped_text }
							: undefined,
					raw: payload,
				},
			]
		}

		const normalized: WebhookEvent = {
			type,
			provider: "sequenzy",
			// The send record, not `message_id`: that one is the upstream mail server's id,
			// which `send()` never sees.
			message_id: data.email_send_id,
			email: data.recipient,
			timestamp: to_date(payload.created_at),
			subject: data.subject,
			url: type === "clicked" ? (data.url ?? data.link) : undefined,
			bounce: type === "bounced" ? bounce(data) : undefined,
			raw: payload,
		}
		if (type === "opened" || type === "clicked") {
			Object.assign(normalized, engagement(data.user_agent, data.ip ?? data.ip_address))
		}
		return [normalized]
	},
}

export default adapter

/** Build a realistic signed Sequenzy sample request — used by `mock_request` and tests. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const sequenzy_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "email.delivered"
	const now = new Date()
	const data: NonNullable<SequenzyPayload["data"]> = {
		email_send_id: "send_mock",
		message_id: "mock-upstream-message-id",
		subscriber_id: "sub_mock",
		external_id: "customer_mock",
		recipient: "recipient@example.com",
		subject: "Mock subject",
		email_type: "transactional",
		metadata: { source: "api" },
	}
	if (type === "opened" || type === "clicked") {
		data.ip = "192.0.2.1"
		data.user_agent =
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
	}
	if (type === "clicked") data.url = "https://example.com/pricing"
	if (type === "bounced") {
		data.bounce_type = "hard"
		data.reason = "User unknown"
	}
	if (type === "failed") data.failure = { code: "transport_exhausted" }
	if (type === "received") {
		data.in_reply_to = data.message_id
		data.from_email = "someone@example.com"
		data.from_name = "Someone"
		data.subject = "Re: Mock subject"
		data.body_text = "Thanks, that works for me."
		data.body_html = "<p>Thanks, that works for me.</p>"
		data.stripped_text = "Thanks, that works for me."
		data.received_at = now.toISOString()
	}

	const body = JSON.stringify({
		id: "evt_mock",
		type: sequenzy_type,
		object: "event",
		metric: sequenzy_type.slice(sequenzy_type.indexOf(".") + 1),
		created_at: now.toISOString(),
		data,
	})
	const timestamp = String(Math.floor(now.getTime() / 1000))
	const signature = hex_encode(await hmac_sha256(secret, `v1:${timestamp}:${body}`))

	return {
		body,
		headers: {
			"x-sequenzy-event-id": "evt_mock",
			"x-sequenzy-event-type": sequenzy_type,
			"x-sequenzy-timestamp": timestamp,
			"x-sequenzy-signature": `v1=${signature}`,
			"content-type": "application/json",
		},
	}
}
