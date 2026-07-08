import type {
	WebhookAdapter,
	WebhookEventType,
	BounceDetail,
	AdapterModule,
	VerifyContext,
} from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { parse_json, engagement, to_date } from "./shared.js"
import { hmac_sha256, hex_encode, timing_safe_equal } from "./crypto.js"

/**
 * Mailgun webhook payload — https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/
 */
interface MailgunPayload {
	signature?: { timestamp?: string; token?: string; signature?: string }
	"event-data"?: {
		event?: string
		severity?: string
		recipient?: string
		timestamp?: number
		url?: string
		ip?: string
		"client-info"?: { "user-agent"?: string }
		tags?: Array<string>
		message?: { headers?: { "message-id"?: string; subject?: string } }
		"delivery-status"?: { message?: string; description?: string }
		reason?: string
	}
}

function event_type(data: NonNullable<MailgunPayload["event-data"]>): WebhookEventType | undefined {
	switch (data.event) {
		case "accepted":
			return "sent"
		case "delivered":
			return "delivered"
		case "opened":
			return "opened"
		case "clicked":
			return "clicked"
		case "complained":
			return "complained"
		case "unsubscribed":
			return "unsubscribed"
		case "failed":
			// Mailgun folds bounces and delays into `failed` split by severity.
			return data.severity === "temporary" ? "delayed" : "bounced"
		default:
			return undefined
	}
}

async function check_signature(ctx: VerifyContext, payload: MailgunPayload): Promise<boolean> {
	const { timestamp, token, signature } = payload.signature ?? {}
	if (!timestamp || !token || !signature || !ctx.secret) return false
	const expected = hex_encode(await hmac_sha256(ctx.secret, timestamp + token))
	return timing_safe_equal(signature, expected)
}

/**
 * Mailgun webhook adapter. Verification is HMAC-SHA256 of `timestamp + token` with your
 * webhook signing key, matched against the payload's own `signature` block.
 */
const adapter: WebhookAdapter = {
	provider: "mailgun",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "mailgun",
				message:
					"No webhook signing key configured for mailgun. Set MAILGUN_WEBHOOK_SECRET or pass { secret }.",
				code: "missing_secret",
			})
		}
		const payload = parse_json("mailgun", ctx.body) as MailgunPayload
		if (!(await check_signature(ctx, payload))) {
			throw new WebhookVerificationError({
				provider: "mailgun",
				message: "mailgun webhook signature did not match",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const payload = parse_json("mailgun", body) as MailgunPayload
		const data = payload["event-data"]
		if (!data) return []
		const type = event_type(data)
		if (!type) return []

		const bounce: BounceDetail | undefined =
			type === "bounced"
				? {
						category: data.severity === "permanent" ? "hard" : "unknown",
						detail:
							data["delivery-status"]?.message ||
							data["delivery-status"]?.description ||
							data.reason,
					}
				: undefined

		return [
			{
				type,
				provider: "mailgun",
				message_id: data.message?.headers?.["message-id"],
				email: data.recipient,
				timestamp: to_date(data.timestamp),
				subject: data.message?.headers?.subject,
				tags: data.tags,
				url: data.url,
				bounce,
				...engagement(data["client-info"]?.["user-agent"], data.ip),
				raw: payload,
			},
		]
	},
}

export default adapter

/** Build a realistic signed Mailgun sample request. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const events: Record<string, Partial<NonNullable<MailgunPayload["event-data"]>>> = {
		sent: { event: "accepted" },
		delivered: { event: "delivered" },
		delayed: { event: "failed", severity: "temporary", reason: "server busy" },
		bounced: {
			event: "failed",
			severity: "permanent",
			"delivery-status": { message: "550 mailbox unavailable" },
		},
		complained: { event: "complained" },
		opened: {
			event: "opened",
			ip: "192.0.2.1",
			"client-info": {
				"user-agent":
					"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
			},
		},
		clicked: {
			event: "clicked",
			url: "https://example.com/pricing",
			ip: "192.0.2.1",
			"client-info": { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0" },
		},
		unsubscribed: { event: "unsubscribed" },
		failed: { event: "failed", severity: "permanent" },
	}

	const timestamp = String(Math.floor(Date.now() / 1000))
	const token = "mock-token"
	const signature = hex_encode(await hmac_sha256(secret, timestamp + token))

	const body = JSON.stringify({
		signature: { timestamp, token, signature },
		"event-data": {
			recipient: "recipient@example.com",
			timestamp: Number(timestamp),
			tags: ["welcome"],
			message: { headers: { "message-id": "mock-message-id", subject: "Mock subject" } },
			...events[type],
		},
	})

	return { body, headers: { "content-type": "application/json" } }
}
