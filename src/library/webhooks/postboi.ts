import type { WebhookAdapter, WebhookEventType, BounceDetail, AdapterModule } from "./index.js"
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
		user_agent?: string
		ip?: string
		url?: string
		tags?: Array<string>
		timestamp?: string
	}
}

const TYPES: Record<string, WebhookEventType> = {
	"email.sent": "sent",
	"email.delivered": "delivered",
	"email.bounced": "bounced",
	"email.complained": "complained",
	"email.opened": "opened",
	"email.clicked": "clicked",
	"email.failed": "failed",
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
		return [
			{
				type,
				provider: "postboi",
				message_id: data.message_id,
				email: data.to,
				timestamp: to_date(data.timestamp ?? payload.created_at),
				subject: data.subject,
				tags: data.tags,
				url: data.url,
				bounce: type === "bounced" ? bounce(data) : undefined,
				...engagement(data.user_agent, data.ip),
				raw: payload,
			},
		]
	},
}

export default adapter

/** Build a realistic signed Postboi sample request — used by `mock_request` and tests. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const postboi_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "email.delivered"
	const now = new Date().toISOString()
	const data: NonNullable<PostboiPayload["data"]> = {
		message_id: "mock-message-id",
		from: "mock@example.com",
		to: "recipient@example.com",
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
