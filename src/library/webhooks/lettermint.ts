import type {
	WebhookAdapter,
	WebhookEvent,
	WebhookEventType,
	BounceDetail,
	AdapterModule,
} from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { parse_json, engagement, to_date } from "./shared.js"
import { hmac_sha256, hex_encode, timing_safe_equal } from "./crypto.js"

/**
 * Lettermint webhook envelope — https://lettermint.co/docs/platform/webhooks/events
 * Every delivery is `{ id, event, timestamp, context, data }`; `data` is per event.
 */
interface LettermintPayload {
	id?: string
	event?: string
	timestamp?: string
	data?: {
		message_id?: string
		recipient?: string
		subject?: string
		tag?: string | null
		tags?: Array<{ name?: string; value?: string }>
		metadata?: Record<string, string>
		/** delivered / bounced: the receiving server's SMTP response. */
		response?: { status_code?: number; enhanced_status_code?: string; content?: string }
		/** failed / suppressed / policy_rejected: why. */
		reason?: string
		reason_code?: string
		/** opened / clicked */
		opened_at?: string
		clicked_at?: string
		destination_url?: string
		user_agent?: string
		/** inbound */
		from?: { email?: string; name?: string }
		date?: string
		body?: { text?: string; html?: string }
	}
}

const TYPES: Record<string, WebhookEventType> = {
	"message.sent": "sent",
	"message.delivered": "delivered",
	"message.hard_bounced": "bounced",
	"message.soft_bounced": "bounced",
	"message.suppressed": "bounced",
	"message.spam_complaint": "complained",
	"message.failed": "failed",
	"message.policy_rejected": "failed",
	"message.unsubscribed": "unsubscribed",
	"message.opened": "opened",
	"message.clicked": "clicked",
	"message.inbound": "received",
}

/** Allowed clock skew, in seconds — the same 5 minutes Lettermint's own SDKs use. */
const TOLERANCE_S = 300
/** The array form of tags carries the single `tag` under this reserved name. */
const RESERVED_TAG = "__lettermint_tag"

function bounce(event: string, data: NonNullable<LettermintPayload["data"]>): BounceDetail {
	const category =
		event === "message.hard_bounced"
			? "hard"
			: event === "message.soft_bounced"
				? "soft"
				: event === "message.suppressed"
					? "suppressed"
					: "unknown"
	return { category, detail: data.response?.content ?? data.reason }
}

function tag_names(data: NonNullable<LettermintPayload["data"]>): Array<string> | undefined {
	const names = new Set<string>()
	if (data.tag) names.add(data.tag)
	for (const tag of data.tags ?? []) {
		if (tag.name && tag.name !== RESERVED_TAG) names.add(tag.name)
	}
	return names.size ? [...names] : undefined
}

/** Split `t=<unix seconds>,v1=<hex>` into its parts, or undefined when malformed. */
function parse_signature(header: string): { timestamp: string; hash: string } | undefined {
	let timestamp: string | undefined
	let hash: string | undefined
	for (const part of header.split(",")) {
		const eq = part.indexOf("=")
		if (eq < 0) continue
		const key = part.slice(0, eq).trim()
		const value = part.slice(eq + 1).trim()
		if (key === "t") timestamp = value
		else if (key === "v1") hash = value
	}
	return timestamp && hash ? { timestamp, hash } : undefined
}

/**
 * Lettermint webhook adapter. Verification is HMAC-SHA256 (hex) of `{timestamp}.{body}`
 * with the webhook's signing secret, carried as `X-Lettermint-Signature: t=…,v1=…`; the
 * timestamp is checked against the clock for replay protection and, when present,
 * cross-checked against `X-Lettermint-Delivery` — exactly what Lettermint's SDKs do.
 */
const adapter: WebhookAdapter = {
	provider: "lettermint",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "lettermint",
				message:
					"No webhook signing secret configured for lettermint. Set LETTERMINT_WEBHOOK_SECRET to the webhook's secret from the Lettermint dashboard, or pass { secret }.",
				code: "missing_secret",
			})
		}
		const header = ctx.headers.get("x-lettermint-signature")
		const signature = header ? parse_signature(header) : undefined
		if (!signature) {
			throw new WebhookVerificationError({
				provider: "lettermint",
				message: "lettermint webhook is missing its X-Lettermint-Signature header",
				code: "invalid_signature",
			})
		}
		// The delivery header repeats the signed timestamp; a disagreement is tampering.
		const delivery = ctx.headers.get("x-lettermint-delivery")
		if (delivery && delivery.trim() !== signature.timestamp) {
			throw new WebhookVerificationError({
				provider: "lettermint",
				message: "lettermint webhook signature and delivery timestamps disagree",
				code: "invalid_signature",
			})
		}
		const timestamp = Number(signature.timestamp)
		const now = Math.floor(Date.now() / 1000)
		if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > TOLERANCE_S) {
			throw new WebhookVerificationError({
				provider: "lettermint",
				message:
					"lettermint webhook timestamp is outside the accepted tolerance (replay protection)",
				code: "stale_timestamp",
			})
		}
		const expected = hex_encode(await hmac_sha256(ctx.secret, `${signature.timestamp}.${ctx.body}`))
		if (!timing_safe_equal(signature.hash, expected)) {
			throw new WebhookVerificationError({
				provider: "lettermint",
				message: "lettermint webhook signature did not match",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const payload = parse_json("lettermint", body) as LettermintPayload
		const event = payload.event ?? ""
		const type = TYPES[event]
		// message.created, auto-replies, suppression.* and webhook.test aren't delivery events.
		if (!type) return []
		const data = payload.data ?? {}

		if (type === "received") {
			// Inbound: `email` is whoever wrote to you, and the body is the point of it.
			return [
				{
					type,
					provider: "lettermint",
					message_id: data.message_id,
					email: data.from?.email,
					timestamp: to_date(data.date ?? payload.timestamp),
					subject: data.subject,
					body: data.body,
					raw: payload,
				},
			]
		}

		const normalized: WebhookEvent = {
			type,
			provider: "lettermint",
			message_id: data.message_id,
			email: data.recipient,
			timestamp: to_date(data.opened_at ?? data.clicked_at ?? payload.timestamp),
			subject: data.subject,
			tags: tag_names(data),
			url: type === "clicked" ? data.destination_url : undefined,
			bounce: type === "bounced" ? bounce(event, data) : undefined,
			raw: payload,
		}
		// Lettermint reports the client but not the recipient's address.
		if (type === "opened" || type === "clicked") {
			Object.assign(normalized, engagement(data.user_agent, undefined))
		}
		return [normalized]
	},
}

export default adapter

/** Build a realistic signed Lettermint sample request — used by `mock_request` and tests. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const event = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "message.delivered"
	const now = new Date()
	const data: NonNullable<LettermintPayload["data"]> = {
		message_id: "mock-message-id",
		recipient: "recipient@example.com",
		subject: "Mock subject",
		tag: "welcome",
		tags: [{ name: RESERVED_TAG, value: "welcome" }],
	}
	if (type === "delivered") {
		data.response = { status_code: 250, enhanced_status_code: "2.0.0", content: "OK" }
	}
	if (type === "bounced") {
		data.response = {
			status_code: 550,
			enhanced_status_code: "5.1.1",
			content: "mailbox unavailable",
		}
	}
	if (type === "failed") {
		data.reason = "5.7.10 Encryption needed"
		data.reason_code = "enforced_tls_failed"
	}
	if (type === "opened") {
		data.opened_at = now.toISOString()
		data.user_agent =
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
	}
	if (type === "clicked") {
		data.clicked_at = now.toISOString()
		data.destination_url = "https://example.com/pricing"
		data.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
	}
	if (type === "received") {
		delete data.recipient
		data.from = { email: "someone@example.com", name: "Someone" }
		data.date = now.toISOString()
		data.body = { text: "Thanks, that works for me." }
	}

	const body = JSON.stringify({
		id: "mock-delivery-id",
		event,
		timestamp: now.toISOString(),
		context: { scope: "project", team_id: "mock-team", project_id: "mock-project", route_id: null },
		data,
	})
	const timestamp = String(Math.floor(now.getTime() / 1000))
	const hash = hex_encode(await hmac_sha256(secret, `${timestamp}.${body}`))

	return {
		body,
		headers: {
			"x-lettermint-signature": `t=${timestamp},v1=${hash}`,
			"x-lettermint-delivery": timestamp,
			"x-lettermint-event": event,
			"content-type": "application/json",
		},
	}
}
