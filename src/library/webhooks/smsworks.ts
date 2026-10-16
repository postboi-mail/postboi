/**
 * The SMS Works webhooks — delivery reports and inbound replies, for SMS.
 * https://thesmsworks.co.uk/developers
 *
 * Twilio is polled because its status callbacks are set per message, at send time. The
 * SMS Works is the other way round: delivery reports go to one account-wide URL
 * (Delivery Reports → Webhook Configuration, or `deliveryreporturl` on a send), so the
 * intended path is the one every email provider in this directory already takes —
 * point the URL at `receive()`.
 *
 * There is no signature. Verification is the shared-secret pattern: a `?token=…` on the
 * URL you paste in, holding the same value as `SMSWORKS_WEBHOOK_SECRET` (or the
 * basic-auth password, where a webhook offers one), compared timing-safe. That is
 * weaker than an HMAC and the docs say so rather than glossing it; their published
 * source addresses are a second check a deployment can add in front.
 *
 * One handler takes both webhooks. A delivery report is a message with a `status`. An
 * inbound reply — a reply-number or keyword webhook — is `messagetype: "incoming"`: STOP
 * is `unsubscribed` and START `resubscribed` for the number that sent it, and anything
 * else, HELP included, is `received` with their words (see `inbound_event`).
 */
import { PostboiError } from "../index.js"
import type {
	AdapterModule,
	BounceDetail,
	WebhookAdapter,
	WebhookEvent,
	WebhookEventType,
} from "./index.js"
import { parse_json, to_date, shared_secret_verify, inbound_event } from "./shared.js"
import { to_e164 } from "../sms/phone.js"

/** Why a message didn't (or hasn't yet) arrived — `permanent` is the classification. */
interface FailureReason {
	code?: number | string
	details?: string
	permanent?: boolean
}

/**
 * A delivery report, which is the message object itself with its current `status`.
 * Only the fields read here are typed; `raw` carries the rest (credits, parts, the
 * echoed `metadata`, …).
 */
interface DeliveryReport {
	messageid?: string
	/** Set on messages sent through `/batch/*` — the id `send()` returned for those. */
	batchid?: string
	status?: string
	/** The recipient, as digits without a `+` — and as a JSON number in their example. */
	destination?: string | number
	sender?: string
	created?: string
	modified?: string
	tag?: string
	failurereason?: FailureReason | null
}

/** An inbound message from a reply-number or keyword webhook. */
interface InboundMessage {
	messagetype?: string
	messageid?: string
	content?: string
	/** The person replying — digits, no `+`. */
	from?: string | number
	to?: string | number
	/** The send they are replying to, when The SMS Works can tell. */
	outboundmessageid?: string
}

type Payload = DeliveryReport & InboundMessage

/**
 * Delivery-report status → normalized event. `SCHEDULED` is the provider holding the
 * message, not something that happened to it, so it is never emitted. A `SENT` that
 * carries a *temporary* failure reason is the carrier still trying (for up to 48 hours)
 * — the same fact as an email deferral, so it is `delayed` rather than `sent`.
 */
const TYPES: Record<string, WebhookEventType> = {
	SENT: "sent",
	DELIVERED: "delivered",
	UNDELIVERABLE: "failed",
	REJECTED: "failed",
	EXPIRED: "failed",
}

/**
 * `447700900123` (a number or a string, with or without a `+`) → `+447700900123`. The
 * send side strips the `+` from E.164 and the report echoes that, so putting it back is
 * the whole conversion; `to_e164` then owns what a plausible number is, as it does for
 * every send. A report about something that isn't one carries no `phone` rather than
 * throwing — a webhook normaliser has to answer every payload the provider posts.
 */
function e164(value: string | number | undefined): string | undefined {
	const digits = String(value ?? "").replace(/\D/g, "")
	try {
		return digits ? to_e164(`+${digits}`) : undefined
	} catch {
		return undefined
	}
}

/**
 * Does this failure reason say anything? Their message object is documented with the
 * object always present, so a healthy report may carry `{ code: 0, details: "",
 * permanent: false }` — which must not read as a temporary failure.
 */
function has_reason(reason: FailureReason | null | undefined): reason is FailureReason {
	return Boolean(reason && ((reason.code !== undefined && reason.code !== 0) || reason.details))
}

/**
 * The failure as a bounce detail. Unlike Twilio, The SMS Works *does* classify: its
 * `permanent` flag is exactly the hard/soft split, so it maps rather than staying
 * "unknown". The carrier's own code and words go in `detail`, the field consumers
 * already read for "why didn't this arrive".
 */
function bounce(reason: FailureReason | null | undefined): BounceDetail {
	const detail =
		[reason?.code, reason?.details]
			.filter((part) => part !== undefined && part !== null && part !== "")
			.join(" ") || undefined
	return {
		category:
			reason?.permanent === true ? "hard" : reason?.permanent === false ? "soft" : "unknown",
		detail,
	}
}

/**
 * One inbound reply as an event. The number is the *sender's*, and a `received` carries
 * the send they replied to when The SMS Works can tell (`outboundmessageid`).
 */
function normalize_inbound(payload: InboundMessage): WebhookEvent {
	return inbound_event({
		provider: "smsworks",
		channel: "sms",
		phone: e164(payload.from),
		text: payload.content,
		message_id: payload.messageid,
		replied_to: payload.outboundmessageid || undefined,
		raw: payload,
	})
}

/** One delivery report as an event — or nothing, for a status we don't emit. */
function normalize_report(payload: DeliveryReport): WebhookEvent | undefined {
	let type = TYPES[payload.status?.toUpperCase() ?? ""]
	if (!type) return undefined
	const reason = payload.failurereason
	if (type === "sent" && has_reason(reason) && reason.permanent === false) type = "delayed"
	return {
		type,
		provider: "smsworks",
		channel: "sms",
		phone: e164(payload.destination),
		message_id: payload.messageid,
		// `modified` is when the status last changed, which is when this happened.
		timestamp: to_date(payload.modified ?? payload.created),
		tags: payload.tag ? [payload.tag] : undefined,
		bounce: type === "failed" || type === "delayed" ? bounce(reason) : undefined,
		raw: payload,
	}
}

const adapter: WebhookAdapter = {
	provider: "smsworks",

	verify(ctx) {
		shared_secret_verify("smsworks", ctx)
	},

	normalize(body) {
		const parsed = parse_json("smsworks", body)
		// One report per POST is what they document; a list is the natural batch shape,
		// so it is taken too. Anything else isn't a report at all.
		const payloads = Array.isArray(parsed) ? parsed : [parsed]
		const events: Array<WebhookEvent> = []
		for (const payload of payloads as Array<Payload | null>) {
			if (payload === null || typeof payload !== "object") {
				throw new PostboiError({
					provider: "smsworks",
					message: "smsworks webhook payload is not a delivery report",
					code: "invalid_payload",
					raw: parsed,
				})
			}
			const event =
				payload.messagetype === "incoming" ? normalize_inbound(payload) : normalize_report(payload)
			if (event) events.push(event)
		}
		return events
	},
}

export default adapter

/** Build an SMS Works sample request, authenticated with the ?token= shared secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const now = new Date().toISOString()
	// The number is from Ofcom's drama range (07700 900xxx), which is never allocated.
	const report: Payload = {
		messageid: "d87e93c0-fa08-4903-becd-aeb5b0ab3b6a",
		batchid: "",
		destination: 447700900123,
		sender: "POSTBOI",
		created: now,
		modified: now,
		tag: "otp",
	}
	const incoming: Payload = {
		messagetype: "incoming",
		messageid: "328827210622192878142",
		from: "447700900123",
		to: "447700900456",
		outboundmessageid: report.messageid,
	}
	const samples: Partial<Record<WebhookEventType, Payload>> = {
		sent: { ...report, status: "SENT" },
		delivered: { ...report, status: "DELIVERED" },
		delayed: {
			...report,
			status: "SENT",
			failurereason: {
				code: 3001,
				details: "Handset unreachable: switched off or out of coverage, retrying",
				permanent: false,
			},
		},
		failed: {
			...report,
			status: "UNDELIVERABLE",
			failurereason: {
				code: 5001,
				details: "Handset Error: Number does not exist or has not been assigned to a user.",
				permanent: true,
			},
		},
		// The inbound samples: the person at +44 7700 900123 texting back to the reply
		// number — so the addresses swap around, and the number is theirs.
		unsubscribed: { ...incoming, content: "STOP" },
		resubscribed: { ...incoming, content: "START" },
		received: { ...incoming, content: "Thanks, see you then" },
	}
	const target = new URL(url)
	target.searchParams.set("token", secret)
	return {
		body: JSON.stringify(samples[type] ?? samples.delivered),
		headers: { "content-type": "application/json" },
		url: target.href,
	}
}
