import type { WebhookAdapter, WebhookEvent, WebhookEventType, AdapterModule } from "./index.js"
import { parse_json, engagement, to_date, shared_secret_verify } from "./shared.js"

/**
 * SparkPost webhook payload — an array of `{ msys: { <event_class>: {...} } }` wrappers.
 * https://developers.sparkpost.com/api/webhooks/
 */
interface SparkPostWrapper {
	msys?: {
		message_event?: SparkPostEvent
		track_event?: SparkPostEvent
		unsubscribe_event?: SparkPostEvent
	}
}

interface SparkPostEvent {
	type?: string
	rcpt_to?: string
	message_id?: string
	timestamp?: string | number
	subject?: string
	rcpt_tags?: Array<string>
	target_link_url?: string
	user_agent?: string
	ip_address?: string
	reason?: string
	bounce_class?: string
}

const TYPES: Record<string, WebhookEventType> = {
	injection: "sent",
	delivery: "delivered",
	delay: "delayed",
	bounce: "bounced",
	out_of_band: "bounced",
	spam_complaint: "complained",
	policy_rejection: "failed",
	generation_failure: "failed",
	generation_rejection: "failed",
	open: "opened",
	initial_open: "opened",
	amp_open: "opened",
	click: "clicked",
	amp_click: "clicked",
	list_unsubscribe: "unsubscribed",
	link_unsubscribe: "unsubscribed",
}

// SparkPost bounce classifications — hard = invalid recipient/domain (classes 10, 30, 90).
const HARD_BOUNCE_CLASSES = new Set(["10", "30", "90"])

/**
 * SparkPost webhook adapter. SparkPost's first-class auth is a shared token in the
 * `X-MessageSystems-Webhook-Token` header (or basic auth) — the shared-secret pattern.
 */
const adapter: WebhookAdapter = {
	provider: "sparkpost",

	verify(ctx) {
		shared_secret_verify("sparkpost", ctx, ["x-messagesystems-webhook-token"])
	},

	normalize(body) {
		const payload = parse_json("sparkpost", body)
		const wrappers = Array.isArray(payload) ? (payload as Array<SparkPostWrapper>) : []

		const events: Array<WebhookEvent> = []
		for (const wrapper of wrappers) {
			const msys = wrapper.msys ?? {}
			const item = msys.message_event ?? msys.track_event ?? msys.unsubscribe_event
			const type = item?.type ? TYPES[item.type] : undefined
			if (!item || !type) continue
			events.push({
				type,
				provider: "sparkpost",
				message_id: item.message_id,
				email: item.rcpt_to,
				timestamp: to_date(item.timestamp),
				subject: item.subject,
				tags: item.rcpt_tags,
				url: item.target_link_url,
				bounce:
					type === "bounced"
						? {
								category: HARD_BOUNCE_CLASSES.has(String(item.bounce_class)) ? "hard" : "soft",
								detail: item.reason,
							}
						: undefined,
				...engagement(item.user_agent, item.ip_address),
				raw: wrapper,
			})
		}
		return events
	},
}

export default adapter

/** Build a SparkPost sample request, authenticated with its webhook-token header. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const sparkpost_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivery"
	const event: SparkPostEvent = {
		type: sparkpost_type,
		rcpt_to: "recipient@example.com",
		message_id: "mock-message-id",
		timestamp: String(Math.floor(Date.now() / 1000)),
		subject: "Mock subject",
		rcpt_tags: ["welcome"],
	}
	if (type === "opened" || type === "clicked") {
		event.ip_address = "192.0.2.1"
		event.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
	}
	if (type === "clicked") event.target_link_url = "https://example.com/pricing"
	if (type === "bounced") {
		event.bounce_class = "10"
		event.reason = "550 mailbox unavailable"
	}

	const key =
		type === "opened" || type === "clicked"
			? "track_event"
			: type === "unsubscribed"
				? "unsubscribe_event"
				: "message_event"

	return {
		body: JSON.stringify([{ msys: { [key]: event } }]),
		headers: {
			"x-messagesystems-webhook-token": secret,
			"content-type": "application/json",
		},
	}
}
