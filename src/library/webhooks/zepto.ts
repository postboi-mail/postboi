import type { WebhookAdapter, WebhookEvent, WebhookEventType, AdapterModule } from "./index.js"
import { parse_json, engagement, to_date, shared_secret_verify } from "./shared.js"

/**
 * ZeptoMail webhook payload — https://www.zoho.com/zeptomail/help/webhooks.html
 * ZeptoMail's native signing scheme is not publicly documented well enough to implement
 * confidently, so verification is the shared-secret pattern for now.
 */
interface ZeptoPayload {
	event_name?: Array<string> | string
	event_message?: Array<string> | string
	request_id?: string
	event_data?: Array<{
		email_info?: {
			to?: Array<{ email_address?: { address?: string } }>
			subject?: string
			message_id?: string
			client_reference?: string
		}
		event_info?: Array<{
			time?: string
			reason?: string
			details?: Array<{
				time?: string
				reason?: string
				user_agent?: string
				ip_address?: string
				clicked_link?: string
			}>
		}>
	}>
}

const TYPES: Record<string, WebhookEventType> = {
	hardbounce: "bounced",
	softbounce: "bounced",
	email_open: "opened",
	open: "opened",
	email_link_click: "clicked",
	click: "clicked",
	delivered: "delivered",
	spam: "complained",
	unsubscribe: "unsubscribed",
}

function names(value: ZeptoPayload["event_name"]): Array<string> {
	if (!value) return []
	return Array.isArray(value) ? value : [value]
}

const adapter: WebhookAdapter = {
	provider: "zepto",

	verify(ctx) {
		shared_secret_verify("zepto", ctx)
	},

	normalize(body) {
		const payload = parse_json("zepto", body) as ZeptoPayload
		const events: Array<WebhookEvent> = []

		for (const name of names(payload.event_name)) {
			const type = TYPES[name]
			if (!type) continue
			for (const data of payload.event_data ?? [{}]) {
				const info = data.event_info?.[0]
				const detail = info?.details?.[0]
				const bounce_category = name === "hardbounce" ? "hard" : "soft"
				events.push({
					type,
					provider: "zepto",
					message_id: data.email_info?.message_id,
					email: data.email_info?.to?.[0]?.email_address?.address,
					timestamp: to_date(detail?.time ?? info?.time),
					subject: data.email_info?.subject,
					url: detail?.clicked_link,
					bounce:
						type === "bounced"
							? { category: bounce_category, detail: detail?.reason ?? info?.reason }
							: undefined,
					...engagement(detail?.user_agent, detail?.ip_address),
					raw: payload,
				})
			}
		}
		return events
	},
}

export default adapter

/** Build a ZeptoMail sample request, authenticated with the ?token= shared secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const zepto_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivered"
	const now = new Date().toISOString()
	const detail: NonNullable<
		NonNullable<NonNullable<ZeptoPayload["event_data"]>[number]["event_info"]>[number]["details"]
	>[number] = { time: now }
	if (type === "opened" || type === "clicked") {
		detail.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
		detail.ip_address = "192.0.2.1"
	}
	if (type === "clicked") detail.clicked_link = "https://example.com/pricing"
	if (type === "bounced") detail.reason = "mailbox unavailable"

	const body = JSON.stringify({
		event_name: [zepto_type],
		request_id: "mock-request-id",
		event_data: [
			{
				email_info: {
					to: [{ email_address: { address: "recipient@example.com" } }],
					subject: "Mock subject",
					message_id: "mock-message-id",
				},
				event_info: [{ time: now, details: [detail] }],
			},
		],
	})

	const target = new URL(url)
	target.searchParams.set("token", secret)
	return { body, headers: { "content-type": "application/json" }, url: target.href }
}
