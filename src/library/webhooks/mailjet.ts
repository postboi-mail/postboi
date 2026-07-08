import type { WebhookAdapter, WebhookEvent, WebhookEventType, AdapterModule } from "./index.js"
import { parse_json, engagement, to_date, shared_secret_verify } from "./shared.js"

/**
 * Mailjet event payload — a single object or an array (grouped events).
 * https://dev.mailjet.com/email/guides/webhooks/
 */
interface MailjetEvent {
	event?: string
	time?: number
	MessageID?: number
	Message_GUID?: string
	email?: string
	customcampaign?: string
	url?: string
	ip?: string
	agent?: string
	error_related_to?: string
	error?: string
	hard_bounce?: boolean
}

const TYPES: Record<string, WebhookEventType> = {
	// Mailjet's "sent" fires on delivery to the recipient's server.
	sent: "delivered",
	open: "opened",
	click: "clicked",
	bounce: "bounced",
	spam: "complained",
	blocked: "failed",
	unsub: "unsubscribed",
}

function normalize_one(item: MailjetEvent): WebhookEvent | undefined {
	const type = item.event ? TYPES[item.event] : undefined
	if (!type) return undefined
	return {
		type,
		provider: "mailjet",
		message_id: item.MessageID !== undefined ? String(item.MessageID) : undefined,
		email: item.email,
		timestamp: to_date(item.time),
		tags: item.customcampaign ? [item.customcampaign] : undefined,
		url: item.url,
		bounce:
			type === "bounced"
				? { category: item.hard_bounce ? "hard" : "soft", detail: item.error }
				: undefined,
		...engagement(item.agent, item.ip),
		raw: item,
	}
}

/**
 * Mailjet webhook adapter. Mailjet has no native signing; verification is the
 * shared-secret pattern (a token in the webhook URL or basic auth, compared timing-safe).
 */
const adapter: WebhookAdapter = {
	provider: "mailjet",

	verify(ctx) {
		shared_secret_verify("mailjet", ctx)
	},

	normalize(body) {
		const payload = parse_json("mailjet", body)
		const items = Array.isArray(payload)
			? (payload as Array<MailjetEvent>)
			: [payload as MailjetEvent]
		return items.map(normalize_one).filter((event): event is WebhookEvent => event !== undefined)
	},
}

export default adapter

/** Build a Mailjet sample request, authenticated with the ?token= shared secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const mailjet_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "sent"
	const event: MailjetEvent = {
		event: mailjet_type,
		time: Math.floor(Date.now() / 1000),
		MessageID: 123456789,
		email: "recipient@example.com",
		customcampaign: "welcome",
	}
	if (type === "opened" || type === "clicked") {
		event.ip = "192.0.2.1"
		event.agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
	}
	if (type === "clicked") event.url = "https://example.com/pricing"
	if (type === "bounced") {
		event.hard_bounce = true
		event.error = "user unknown"
	}

	const target = new URL(url)
	target.searchParams.set("token", secret)
	return {
		body: JSON.stringify([event]),
		headers: { "content-type": "application/json" },
		url: target.href,
	}
}
