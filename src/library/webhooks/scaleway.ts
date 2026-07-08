import type { WebhookAdapter, WebhookEventType, AdapterModule } from "./index.js"
import { parse_json, to_date, shared_secret_verify, sns_envelope } from "./shared.js"

/**
 * Scaleway Transactional Email webhooks — SNS-compatible envelopes over Topics & Events.
 * https://www.scaleway.com/en/docs/transactional-email/reference-content/webhook-events-payloads/
 * Verification is the shared-secret `?token=` pattern; subscription confirmations are
 * handled automatically by `receive`.
 */
interface ScalewayMessage {
	type?: string
	email_id?: string
	message_id?: string
	recipient?: string
	subject?: string
	created_at?: string
	error?: string
}

const TYPES: Record<string, WebhookEventType> = {
	email_queued: "sent",
	email_delivered: "delivered",
	email_dropped: "failed",
	email_bounced: "bounced",
	email_spam: "complained",
	email_mailbox_not_found: "bounced",
	email_blocklisted: "failed",
}

const adapter: WebhookAdapter = {
	provider: "scaleway",
	sns: true,

	verify(ctx) {
		shared_secret_verify("scaleway", ctx)
	},

	normalize(body) {
		const envelope = sns_envelope(parse_json("scaleway", body))
		const inner = typeof envelope?.Message === "string" ? envelope.Message : body
		const message = parse_json("scaleway", inner) as ScalewayMessage
		const type = message.type ? TYPES[message.type] : undefined
		if (!type) return []
		return [
			{
				type,
				provider: "scaleway",
				message_id: message.email_id ?? message.message_id,
				email: message.recipient,
				timestamp: to_date(message.created_at),
				subject: message.subject,
				bounce: type === "bounced" ? { category: "unknown", detail: message.error } : undefined,
				raw: message,
			},
		]
	},
}

export default adapter

/** Build an SNS-wrapped Scaleway sample request, authenticated with the ?token= secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const scaleway_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "email_delivered"
	const message: ScalewayMessage = {
		type: scaleway_type,
		email_id: "mock-message-id",
		recipient: "recipient@example.com",
		subject: "Mock subject",
		created_at: new Date().toISOString(),
	}
	if (type === "bounced") message.error = "mailbox unavailable"

	const body = JSON.stringify({
		Type: "Notification",
		MessageId: "sns-mock-id",
		Message: JSON.stringify(message),
	})
	const target = new URL(url)
	target.searchParams.set("token", secret)
	return { body, headers: { "content-type": "application/json" }, url: target.href }
}
