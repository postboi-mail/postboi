import type { WebhookAdapter, WebhookEventType, BounceDetail, AdapterModule } from "./index.js"
import { parse_json, engagement, to_date, svix_adapter_verify } from "./shared.js"
import { hmac_sha256, base64_encode, base64_decode } from "./crypto.js"

/** Resend webhook payload — https://resend.com/docs/dashboard/webhooks/event-types */
interface ResendPayload {
	type: string
	created_at?: string
	data?: {
		email_id?: string
		from?: string
		to?: Array<string>
		subject?: string
		created_at?: string
		tags?: Record<string, string> | Array<{ name: string; value: string }>
		click?: { ipAddress?: string; link?: string; timestamp?: string; userAgent?: string }
		open?: { ipAddress?: string; timestamp?: string; userAgent?: string }
		bounce?: { message?: string; type?: string; subType?: string }
		failed?: { reason?: string }
	}
}

const TYPES: Record<string, WebhookEventType> = {
	"email.sent": "sent",
	"email.delivered": "delivered",
	"email.delivery_delayed": "delayed",
	"email.bounced": "bounced",
	"email.complained": "complained",
	"email.opened": "opened",
	"email.clicked": "clicked",
	"email.failed": "failed",
}

function bounce(data: NonNullable<ResendPayload["data"]>): BounceDetail | undefined {
	if (!data.bounce) return undefined
	const category =
		data.bounce.subType === "Suppressed"
			? "suppressed"
			: data.bounce.type === "Permanent"
				? "hard"
				: data.bounce.type === "Transient"
					? "soft"
					: "unknown"
	return { category, detail: data.bounce.message }
}

function tag_names(tags: NonNullable<ResendPayload["data"]>["tags"]): Array<string> | undefined {
	if (!tags) return undefined
	if (Array.isArray(tags)) return tags.map((t) => t.name)
	return Object.keys(tags)
}

/**
 * Resend webhook adapter. Verification is the Svix scheme (`svix-id` / `svix-timestamp` /
 * `svix-signature` headers, `whsec_…` secret from the Resend dashboard).
 */
const adapter: WebhookAdapter = {
	provider: "resend",

	verify(ctx) {
		return svix_adapter_verify("resend", ctx, "svix")
	},

	normalize(body) {
		const payload = parse_json("resend", body) as ResendPayload
		const type = TYPES[payload.type]
		// Non-delivery events (contact.*, domain.*, email.scheduled) aren't ours to surface.
		if (!type) return []

		const data = payload.data ?? {}
		const activity = type === "clicked" ? data.click : type === "opened" ? data.open : undefined

		return [
			{
				type,
				provider: "resend",
				message_id: data.email_id,
				email: data.to?.[0],
				timestamp: to_date(activity?.timestamp ?? payload.created_at ?? data.created_at),
				subject: data.subject,
				tags: tag_names(data.tags),
				url: data.click?.link,
				bounce: type === "bounced" ? bounce(data) : undefined,
				...engagement(activity?.userAgent, activity?.ipAddress),
				raw: payload,
			},
		]
	},
}

export default adapter

/** Build a realistic signed Resend sample request — used by `mock_request` and tests. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const resend_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "email.delivered"
	const now = new Date().toISOString()
	const data: NonNullable<ResendPayload["data"]> = {
		email_id: "mock-email-id",
		from: "Mock <mock@example.com>",
		to: ["recipient@example.com"],
		subject: "Mock subject",
		created_at: now,
	}
	if (type === "opened") {
		data.open = {
			ipAddress: "192.0.2.1",
			timestamp: now,
			userAgent:
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
		}
	}
	if (type === "clicked") {
		data.click = {
			ipAddress: "192.0.2.1",
			link: "https://example.com/pricing",
			timestamp: now,
			userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0",
		}
	}
	if (type === "bounced") {
		data.bounce = { message: "mailbox unavailable", type: "Permanent", subType: "General" }
	}

	const body = JSON.stringify({ type: resend_type, created_at: now, data })
	const id = "msg_mock"
	const timestamp = String(Math.floor(Date.now() / 1000))
	const key = base64_decode(secret.replace(/^whsec_/, ""))
	const signature = base64_encode(await hmac_sha256(key, `${id}.${timestamp}.${body}`))

	return {
		body,
		headers: {
			"svix-id": id,
			"svix-timestamp": timestamp,
			"svix-signature": `v1,${signature}`,
			"content-type": "application/json",
		},
	}
}
