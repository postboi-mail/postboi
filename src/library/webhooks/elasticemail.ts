import type { WebhookAdapter, WebhookEventType, AdapterModule } from "./index.js"
import { to_date, shared_secret_verify } from "./shared.js"

/**
 * Elastic Email notifications arrive as form/query parameters, not JSON —
 * https://help.elasticemail.com/en/articles/2376855-notifications-webhooks
 * There is no native signing; verification is the shared-secret `?token=` pattern.
 */
const TYPES: Record<string, WebhookEventType> = {
	sent: "sent",
	delivered: "delivered",
	opened: "opened",
	clicked: "clicked",
	unsubscribed: "unsubscribed",
	abusereport: "complained",
	bounced: "bounced",
	error: "failed",
}

/** Elastic Email posts params in the body (form-encoded) or the query string. */
function params_from(body: string, url: URL): URLSearchParams {
	const from_body = new URLSearchParams(body)
	// A JSON body would parse to a single garbage key; a real form body has known keys.
	if (from_body.has("status") || from_body.has("messageid") || from_body.has("to")) {
		return from_body
	}
	return url.searchParams
}

const adapter: WebhookAdapter = {
	provider: "elasticemail",

	verify(ctx) {
		shared_secret_verify("elasticemail", ctx)
	},

	normalize(body, ctx) {
		const params = params_from(body, ctx.url)
		const status = (params.get("status") ?? params.get("event") ?? "").toLowerCase()
		const type = TYPES[status]
		if (!type) return []

		const raw = Object.fromEntries(params.entries())
		return [
			{
				type,
				provider: "elasticemail",
				message_id: params.get("messageid") ?? params.get("msgid") ?? undefined,
				email: params.get("to") ?? undefined,
				timestamp: to_date(params.get("date")),
				subject: params.get("subject") ?? undefined,
				tags: params.get("category") ? [params.get("category")!] : undefined,
				url: params.get("target") ?? undefined,
				bounce:
					type === "bounced"
						? { category: "unknown", detail: params.get("message") ?? undefined }
						: undefined,
				raw,
			},
		]
	},
}

export default adapter

/** Build an Elastic Email sample request (form-encoded), with the ?token= secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const status = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivered"
	const params = new URLSearchParams({
		status,
		messageid: "mock-message-id",
		to: "recipient@example.com",
		subject: "Mock subject",
		category: "welcome",
		date: new Date().toISOString(),
	})
	if (type === "clicked") params.set("target", "https://example.com/pricing")
	if (type === "bounced") params.set("message", "550 mailbox unavailable")

	const target = new URL(url)
	target.searchParams.set("token", secret)
	return {
		body: params.toString(),
		headers: { "content-type": "application/x-www-form-urlencoded" },
		url: target.href,
	}
}
