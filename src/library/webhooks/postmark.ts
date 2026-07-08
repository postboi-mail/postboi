import type { WebhookAdapter, WebhookEventType, BounceDetail, AdapterModule } from "./index.js"
import { parse_json, engagement, to_date, shared_secret_verify } from "./shared.js"

/**
 * Postmark webhook payload — https://postmarkapp.com/developer/webhooks/webhooks-overview
 * Postmark has no native signing; verification is the shared-secret pattern (a token in
 * the webhook URL or basic-auth credentials, compared timing-safe).
 */
interface PostmarkPayload {
	RecordType?: string
	MessageID?: string
	Recipient?: string
	Email?: string
	Tag?: string
	Subject?: string
	DeliveredAt?: string
	BouncedAt?: string
	ReceivedAt?: string
	Type?: string
	TypeCode?: number
	Description?: string
	Details?: string
	UserAgent?: string
	OriginalLink?: string
	Geo?: { IP?: string }
	SuppressSending?: boolean
}

function event_type(payload: PostmarkPayload): WebhookEventType | undefined {
	switch (payload.RecordType) {
		case "Delivery":
			return "delivered"
		case "Bounce":
			return "bounced"
		case "SpamComplaint":
			return "complained"
		case "Open":
			return "opened"
		case "Click":
			return "clicked"
		case "SubscriptionChange":
			return payload.SuppressSending ? "unsubscribed" : undefined
		default:
			return undefined
	}
}

function bounce(payload: PostmarkPayload): BounceDetail {
	const hard = payload.Type?.includes("Hard") || payload.TypeCode === 1
	const soft = payload.Type?.includes("Soft") || payload.Type === "Transient"
	return {
		category: hard ? "hard" : soft ? "soft" : "unknown",
		detail: payload.Description ?? payload.Details,
	}
}

const adapter: WebhookAdapter = {
	provider: "postmark",

	verify(ctx) {
		shared_secret_verify("postmark", ctx)
	},

	normalize(body) {
		const payload = parse_json("postmark", body) as PostmarkPayload
		const type = event_type(payload)
		if (!type) return []

		return [
			{
				type,
				provider: "postmark",
				message_id: payload.MessageID,
				email: payload.Recipient ?? payload.Email,
				timestamp: to_date(payload.DeliveredAt ?? payload.BouncedAt ?? payload.ReceivedAt),
				subject: payload.Subject,
				tags: payload.Tag ? [payload.Tag] : undefined,
				url: payload.OriginalLink,
				bounce: type === "bounced" ? bounce(payload) : undefined,
				...engagement(payload.UserAgent, payload.Geo?.IP),
				raw: payload,
			},
		]
	},
}

export default adapter

/** Build a Postmark sample request, authenticated with the ?token= shared secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const now = new Date().toISOString()
	const samples: Record<string, PostmarkPayload> = {
		delivered: { RecordType: "Delivery", DeliveredAt: now },
		bounced: {
			RecordType: "Bounce",
			Type: "HardBounce",
			TypeCode: 1,
			Description: "mailbox unavailable",
			BouncedAt: now,
		},
		complained: { RecordType: "SpamComplaint", BouncedAt: now },
		opened: {
			RecordType: "Open",
			ReceivedAt: now,
			UserAgent:
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
			Geo: { IP: "192.0.2.1" },
		},
		clicked: {
			RecordType: "Click",
			ReceivedAt: now,
			OriginalLink: "https://example.com/pricing",
			UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0",
			Geo: { IP: "192.0.2.1" },
		},
		unsubscribed: { RecordType: "SubscriptionChange", SuppressSending: true },
	}
	const payload: PostmarkPayload = {
		MessageID: "mock-message-id",
		Recipient: "recipient@example.com",
		Tag: "welcome",
		Subject: "Mock subject",
		...(samples[type] ?? samples.delivered),
	}

	const target = new URL(url)
	target.searchParams.set("token", secret)
	return {
		body: JSON.stringify(payload),
		headers: { "content-type": "application/json" },
		url: target.href,
	}
}
