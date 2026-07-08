import type { WebhookAdapter, WebhookEvent, WebhookEventType, AdapterModule } from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { parse_json, engagement, to_date } from "./shared.js"
import { hmac_sha256, hex_encode, timing_safe_equal } from "./crypto.js"

/**
 * Mailtrap sending webhook payload — `{ events: [...] }`, batched.
 * https://help.mailtrap.io/article/87-webhooks
 */
interface MailtrapPayload {
	events?: Array<MailtrapEvent>
}

interface MailtrapEvent {
	event?: string
	message_id?: string
	email?: string
	timestamp?: number
	category?: string
	response?: string
	reason?: string
	ip?: string
	user_agent?: string
	url?: string
	bounce_category?: string
}

const TYPES: Record<string, WebhookEventType> = {
	delivery: "delivered",
	open: "opened",
	click: "clicked",
	bounce: "bounced",
	"soft bounce": "bounced",
	soft_bounce: "bounced",
	suspension: "failed",
	reject: "failed",
	unsubscribe: "unsubscribed",
	spam: "complained",
}

/**
 * Mailtrap webhook adapter. Verification is HMAC-SHA256 (hex) of the raw body with the
 * webhook's signing secret. The header name has varied across Mailtrap docs, so all
 * observed spellings are accepted.
 */
const adapter: WebhookAdapter = {
	provider: "mailtrap",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "mailtrap",
				message:
					"No webhook signing secret configured for mailtrap. Set MAILTRAP_WEBHOOK_SECRET or pass { secret }.",
				code: "missing_secret",
			})
		}
		const signature =
			ctx.headers.get("mailtrap-signature") ??
			ctx.headers.get("x-mailtrap-signature") ??
			ctx.headers.get("x-message-webhook-signature")
		const expected = hex_encode(await hmac_sha256(ctx.secret, ctx.body))
		if (!signature || !timing_safe_equal(signature, expected)) {
			throw new WebhookVerificationError({
				provider: "mailtrap",
				message: "mailtrap webhook signature did not match",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const payload = parse_json("mailtrap", body) as MailtrapPayload
		const events: Array<WebhookEvent> = []
		for (const item of payload.events ?? []) {
			const type = item.event ? TYPES[item.event] : undefined
			if (!type) continue
			events.push({
				type,
				provider: "mailtrap",
				message_id: item.message_id,
				email: item.email,
				timestamp: to_date(item.timestamp),
				tags: item.category ? [item.category] : undefined,
				url: item.url,
				bounce:
					type === "bounced"
						? {
								category: item.event === "bounce" ? "hard" : "soft",
								detail: item.response ?? item.reason,
							}
						: undefined,
				...engagement(item.user_agent, item.ip),
				raw: item,
			})
		}
		return events
	},
}

export default adapter

/** Build a realistic signed Mailtrap sample request. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const mailtrap_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivery"
	const event: MailtrapEvent = {
		event: mailtrap_type,
		message_id: "mock-message-id",
		email: "recipient@example.com",
		timestamp: Math.floor(Date.now() / 1000),
		category: "welcome",
	}
	if (type === "opened" || type === "clicked") {
		event.ip = "192.0.2.1"
		event.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
	}
	if (type === "clicked") event.url = "https://example.com/pricing"
	if (type === "bounced") event.response = "550 mailbox unavailable"

	const body = JSON.stringify({ events: [event] })
	const signature = hex_encode(await hmac_sha256(secret, body))
	return {
		body,
		headers: { "mailtrap-signature": signature, "content-type": "application/json" },
	}
}
