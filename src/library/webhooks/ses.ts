import type {
	WebhookAdapter,
	WebhookEvent,
	WebhookEventType,
	BounceDetail,
	AdapterModule,
} from "./index.js"
import { parse_json, engagement, to_date, shared_secret_verify, sns_envelope } from "./shared.js"

/**
 * Amazon SES event publishing via SNS — the event JSON arrives wrapped in an SNS
 * envelope's `Message` string. https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html
 *
 * Verification is the shared-secret `?token=` pattern (put the token in the SNS
 * subscription URL). Full SNS `SigningCertURL` X.509 verification is intentionally not
 * implemented — bring a custom adapter if you need it. Subscription confirmations are
 * handled automatically by `receive`.
 */
interface SesMessage {
	eventType?: string
	notificationType?: string
	mail?: {
		messageId?: string
		destination?: Array<string>
		commonHeaders?: { subject?: string }
		tags?: Record<string, Array<string>>
	}
	bounce?: {
		bounceType?: string
		bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string }>
		timestamp?: string
	}
	complaint?: {
		complainedRecipients?: Array<{ emailAddress?: string }>
		timestamp?: string
	}
	delivery?: { recipients?: Array<string>; timestamp?: string }
	deliveryDelay?: { delayedRecipients?: Array<{ emailAddress?: string }>; timestamp?: string }
	open?: { ipAddress?: string; userAgent?: string; timestamp?: string }
	click?: { ipAddress?: string; userAgent?: string; timestamp?: string; link?: string }
	send?: object
	reject?: { reason?: string }
	failure?: { errorMessage?: string }
}

const TYPES: Record<string, WebhookEventType> = {
	Send: "sent",
	Delivery: "delivered",
	DeliveryDelay: "delayed",
	Bounce: "bounced",
	Complaint: "complained",
	Open: "opened",
	Click: "clicked",
	Reject: "failed",
	"Rendering Failure": "failed",
	RenderingFailure: "failed",
	Subscription: "unsubscribed",
}

function bounce(message: SesMessage): BounceDetail {
	return {
		category:
			message.bounce?.bounceType === "Permanent"
				? "hard"
				: message.bounce?.bounceType === "Transient"
					? "soft"
					: "unknown",
		detail: message.bounce?.bouncedRecipients?.[0]?.diagnosticCode,
	}
}

const adapter: WebhookAdapter = {
	provider: "ses",
	sns: true,

	verify(ctx) {
		shared_secret_verify("ses", ctx)
	},

	normalize(body): Array<WebhookEvent> {
		const envelope = sns_envelope(parse_json("ses", body))
		const inner = envelope?.Message ?? body
		const message = parse_json("ses", typeof inner === "string" ? inner : body) as SesMessage
		const name = message.eventType ?? message.notificationType
		const type = name ? TYPES[name] : undefined
		if (!type) return []

		const email =
			message.bounce?.bouncedRecipients?.[0]?.emailAddress ??
			message.complaint?.complainedRecipients?.[0]?.emailAddress ??
			message.deliveryDelay?.delayedRecipients?.[0]?.emailAddress ??
			message.delivery?.recipients?.[0] ??
			message.mail?.destination?.[0]

		const activity =
			type === "clicked" ? message.click : type === "opened" ? message.open : undefined
		const timestamp =
			activity?.timestamp ??
			message.delivery?.timestamp ??
			message.bounce?.timestamp ??
			message.complaint?.timestamp ??
			message.deliveryDelay?.timestamp

		return [
			{
				type,
				provider: "ses",
				message_id: message.mail?.messageId,
				email,
				timestamp: to_date(timestamp),
				subject: message.mail?.commonHeaders?.subject,
				tags: message.mail?.tags ? Object.keys(message.mail.tags) : undefined,
				url: message.click?.link,
				bounce: type === "bounced" ? bounce(message) : undefined,
				...engagement(activity?.userAgent, activity?.ipAddress),
				raw: message,
			},
		]
	},
}

export default adapter

/** Build an SNS-wrapped SES sample request, authenticated with the ?token= secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const ses_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "Delivery"
	const now = new Date().toISOString()
	const message: SesMessage = {
		eventType: ses_type,
		mail: {
			messageId: "mock-message-id",
			destination: ["recipient@example.com"],
			commonHeaders: { subject: "Mock subject" },
		},
	}
	if (type === "delivered")
		message.delivery = { recipients: ["recipient@example.com"], timestamp: now }
	if (type === "bounced") {
		message.bounce = {
			bounceType: "Permanent",
			bouncedRecipients: [
				{ emailAddress: "recipient@example.com", diagnosticCode: "550 mailbox unavailable" },
			],
			timestamp: now,
		}
	}
	if (type === "opened") {
		message.open = {
			ipAddress: "192.0.2.1",
			userAgent:
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
			timestamp: now,
		}
	}
	if (type === "clicked") {
		message.click = {
			ipAddress: "192.0.2.1",
			userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0",
			timestamp: now,
			link: "https://example.com/pricing",
		}
	}

	const body = JSON.stringify({
		Type: "Notification",
		MessageId: "sns-mock-id",
		Message: JSON.stringify(message),
	})

	const target = new URL(url)
	target.searchParams.set("token", secret)
	return { body, headers: { "content-type": "text/plain" }, url: target.href }
}
