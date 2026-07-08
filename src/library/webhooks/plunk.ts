import type { WebhookAdapter, WebhookEventType, AdapterModule } from "./index.js"
import { parse_json, to_date, shared_secret_verify } from "./shared.js"

/**
 * Plunk webhook payload — https://docs.useplunk.com/
 * Plunk has no documented native signing; verification is the shared-secret pattern.
 * Payload coverage is best-effort (low docs confidence) — `raw` carries everything.
 */
interface PlunkPayload {
	event?: string
	type?: string
	email?: string
	contact?: { email?: string }
	messageId?: string
	timestamp?: string | number
	createdAt?: string
	subject?: string
}

const TYPES: Record<string, WebhookEventType> = {
	delivered: "delivered",
	bounced: "bounced",
	complained: "complained",
	opened: "opened",
	clicked: "clicked",
	unsubscribed: "unsubscribed",
}

const adapter: WebhookAdapter = {
	provider: "plunk",

	verify(ctx) {
		shared_secret_verify("plunk", ctx, ["plunk-signature", "x-plunk-signature"])
	},

	normalize(body) {
		const payload = parse_json("plunk", body) as PlunkPayload
		const name = (payload.event ?? payload.type ?? "").replace(/^email\./, "").toLowerCase()
		const type = TYPES[name]
		if (!type) return []
		return [
			{
				type,
				provider: "plunk",
				message_id: payload.messageId,
				email: payload.email ?? payload.contact?.email,
				timestamp: to_date(payload.timestamp ?? payload.createdAt),
				subject: payload.subject,
				// Plunk doesn't classify bounces in its payload.
				bounce: type === "bounced" ? { category: "unknown" } : undefined,
				raw: payload,
			},
		]
	},
}

export default adapter

/** Build a Plunk sample request, authenticated with the ?token= shared secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const plunk_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivered"
	const body = JSON.stringify({
		event: plunk_type,
		email: "recipient@example.com",
		messageId: "mock-message-id",
		timestamp: new Date().toISOString(),
		subject: "Mock subject",
	})
	const target = new URL(url)
	target.searchParams.set("token", secret)
	return { body, headers: { "content-type": "application/json" }, url: target.href }
}
