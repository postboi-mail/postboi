import type { WebhookAdapter, WebhookEventType, BounceDetail, AdapterModule } from "./index.js"
import { parse_json, engagement, to_date, shared_secret_verify } from "./shared.js"

/**
 * Brevo transactional webhook payload — https://developers.brevo.com/docs/transactional-webhooks
 * Brevo has no native signing; verification is the shared-secret pattern (a token in the
 * webhook URL or Brevo's optional basic-auth header, compared timing-safe).
 */
interface BrevoPayload {
	event?: string
	email?: string
	"message-id"?: string
	subject?: string
	tag?: string
	tags?: Array<string>
	link?: string
	reason?: string
	date?: string
	ts_event?: number
	ts?: number
	// Brevo doesn't expose engagement UA/IP on transactional events consistently.
	user_agent?: string
	ip?: string
}

const TYPES: Record<string, WebhookEventType> = {
	request: "sent",
	delivered: "delivered",
	deferred: "delayed",
	soft_bounce: "bounced",
	softBounce: "bounced",
	hard_bounce: "bounced",
	hardBounce: "bounced",
	spam: "complained",
	complaint: "complained",
	opened: "opened",
	unique_opened: "opened",
	uniqueOpened: "opened",
	click: "clicked",
	clicked: "clicked",
	unsubscribed: "unsubscribed",
	unsubscribe: "unsubscribed",
	blocked: "failed",
	invalid_email: "failed",
	invalid: "failed",
	error: "failed",
}

function bounce(payload: BrevoPayload): BounceDetail {
	const hard = payload.event?.toLowerCase().includes("hard")
	return { category: hard ? "hard" : "soft", detail: payload.reason }
}

const adapter: WebhookAdapter = {
	provider: "brevo",

	verify(ctx) {
		shared_secret_verify("brevo", ctx)
	},

	normalize(body) {
		const payload = parse_json("brevo", body) as BrevoPayload
		const type = payload.event ? TYPES[payload.event] : undefined
		if (!type) return []

		return [
			{
				type,
				provider: "brevo",
				message_id: payload["message-id"],
				email: payload.email,
				timestamp: to_date(payload.ts_event ?? payload.ts ?? payload.date),
				subject: payload.subject,
				tags: payload.tags ?? (payload.tag ? [payload.tag] : undefined),
				url: payload.link,
				bounce: type === "bounced" ? bounce(payload) : undefined,
				...engagement(payload.user_agent, payload.ip),
				raw: payload,
			},
		]
	},
}

export default adapter

/** Build a Brevo sample request, authenticated with the ?token= shared secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const events: Record<string, Partial<BrevoPayload>> = {
		sent: { event: "request" },
		delivered: { event: "delivered" },
		delayed: { event: "deferred" },
		bounced: { event: "hard_bounce", reason: "mailbox unavailable" },
		complained: { event: "spam" },
		opened: { event: "unique_opened" },
		clicked: { event: "click", link: "https://example.com/pricing" },
		unsubscribed: { event: "unsubscribed" },
		failed: { event: "blocked", reason: "blocked by policy" },
	}
	const payload: BrevoPayload = {
		email: "recipient@example.com",
		"message-id": "mock-message-id",
		subject: "Mock subject",
		ts_event: Math.floor(Date.now() / 1000),
		tags: ["welcome"],
		...events[type],
	}

	const target = new URL(url)
	target.searchParams.set("token", secret)
	return {
		body: JSON.stringify(payload),
		headers: { "content-type": "application/json" },
		url: target.href,
	}
}
