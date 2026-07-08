import type { WebhookAdapter, WebhookEventType, BounceDetail, AdapterModule } from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { parse_json, engagement, to_date } from "./shared.js"
import { hmac_sha256, hex_encode, timing_safe_equal } from "./crypto.js"

/**
 * MailerSend activity webhook payload — https://developers.mailersend.com/api/v1/webhooks.html
 */
interface MailerSendPayload {
	type?: string
	created_at?: string
	data?: {
		id?: string
		created_at?: string
		email?: {
			id?: string
			subject?: string
			tags?: Array<string> | null
			message?: { id?: string }
			recipient?: { email?: string }
		}
		morph?: {
			object?: string
			url?: string
			ip?: string
			user_agent?: string
		} | null
	}
}

const TYPES: Record<string, WebhookEventType> = {
	"activity.sent": "sent",
	"activity.delivered": "delivered",
	"activity.soft_bounced": "bounced",
	"activity.hard_bounced": "bounced",
	"activity.opened": "opened",
	"activity.opened_unique": "opened",
	"activity.clicked": "clicked",
	"activity.clicked_unique": "clicked",
	"activity.spam_complaint": "complained",
	"activity.unsubscribed": "unsubscribed",
}

/**
 * MailerSend webhook adapter. Verification is HMAC-SHA256 (hex) of the raw body with the
 * webhook's signing secret, sent in the `Signature` header.
 */
const adapter: WebhookAdapter = {
	provider: "mailersend",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "mailersend",
				message:
					"No webhook signing secret configured for mailersend. Set MAILERSEND_WEBHOOK_SECRET or pass { secret }.",
				code: "missing_secret",
			})
		}
		const signature = ctx.headers.get("signature")
		const expected = hex_encode(await hmac_sha256(ctx.secret, ctx.body))
		if (!signature || !timing_safe_equal(signature, expected)) {
			throw new WebhookVerificationError({
				provider: "mailersend",
				message: "mailersend webhook signature did not match",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const payload = parse_json("mailersend", body) as MailerSendPayload
		const type = payload.type ? TYPES[payload.type] : undefined
		if (!type) return []

		const data = payload.data ?? {}
		const bounce: BounceDetail | undefined =
			type === "bounced"
				? { category: payload.type === "activity.hard_bounced" ? "hard" : "soft" }
				: undefined

		return [
			{
				type,
				provider: "mailersend",
				message_id: data.email?.message?.id ?? data.email?.id,
				email: data.email?.recipient?.email,
				timestamp: to_date(data.created_at ?? payload.created_at),
				subject: data.email?.subject,
				tags: data.email?.tags ?? undefined,
				url: data.morph?.url,
				bounce,
				...engagement(data.morph?.user_agent, data.morph?.ip),
				raw: payload,
			},
		]
	},
}

export default adapter

/** Build a realistic signed MailerSend sample request. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const mailersend_type =
		Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "activity.delivered"
	const now = new Date().toISOString()
	const morph =
		type === "opened"
			? {
					object: "open",
					ip: "192.0.2.1",
					user_agent:
						"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
				}
			: type === "clicked"
				? {
						object: "click",
						url: "https://example.com/pricing",
						ip: "192.0.2.1",
						user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0",
					}
				: null

	const body = JSON.stringify({
		type: mailersend_type,
		created_at: now,
		data: {
			id: "mock-activity-id",
			created_at: now,
			email: {
				id: "mock-email-id",
				subject: "Mock subject",
				tags: ["welcome"],
				message: { id: "mock-message-id" },
				recipient: { email: "recipient@example.com" },
			},
			morph,
		},
	})

	const signature = hex_encode(await hmac_sha256(secret, body))
	return { body, headers: { Signature: signature, "content-type": "application/json" } }
}
