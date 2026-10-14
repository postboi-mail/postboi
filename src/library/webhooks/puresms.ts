/**
 * PureSMS webhooks — delivery receipts and inbound messages, for SMS.
 * https://the.divergent.guide/connect/sms/webhooks/
 *
 * PureSMS is a brand on Divergent Connect, and its webhooks are the platform's: one
 * endpoint per workspace (Settings → Webhooks), an envelope of `{ id, timestamp,
 * workspace_id, event_type, data }`, and `event_type` 1 for a delivery receipt or 2 for
 * an inbound message.
 *
 * **Verification is HMAC-SHA256**, keyed with the secret set on the endpoint, over the
 * `X-Webhook-Timestamp` header, a full stop, then the raw body, carried base64 in
 * `X-Webhook-Signature`. The secret is `PURESMS_WEBHOOK_SECRET`. PureSMS calls it optional;
 * here it isn't, as everywhere else in `receive()`.
 *
 * There is no replay window, although the timestamp is signed. PureSMS doesn't say how old
 * one may be, nor whether a retry (5 minutes to 12 hours later) is signed afresh, and it
 * disables an endpoint after five failures in a row: a tolerance that turned out to be
 * shorter than its retries would switch receipts off for good. So the timestamp is checked
 * as part of the signature and nothing more, and the envelope's `id` (in `raw`) is the one
 * to deduplicate on.
 *
 * **Ids are read from the body's text.** A receipt's `MessageId` is a 64-bit integer written
 * as a bare JSON number, which JavaScript can't hold exactly (357551956102758401 parses to
 * 357551956102758400), so the digits are taken from the body as sent. The send side already
 * treats them as strings for the same reason.
 *
 * A receipt says nothing about the recipient's number, so `phone` is unset on one; its
 * `ClientReference` (the first tag a send carried) comes back as `tags`.
 */
import { PostboiError } from "../index.js"
import type { AdapterModule, WebhookAdapter, WebhookEvent, WebhookEventType } from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { base64_encode, hmac_sha256, timing_safe_equal } from "./crypto.js"
import { inbound_event, parse_json, to_date } from "./shared.js"

/** The envelope every Divergent Connect webhook arrives in. */
interface Envelope {
	id?: string
	timestamp?: string
	workspace_id?: string
	/** 1 is a delivery receipt, 2 an inbound message. */
	event_type?: number
	data?: Receipt & Inbound
}

interface Receipt {
	/** A 64-bit integer, as a JSON number. See the module comment. */
	MessageId?: number | string
	ClientReference?: string | null
	DeliveryStatus?: number
	DeliveryStatusStr?: string
	ErrorCode?: string | number | null
	ProcessedAt?: string
	DeliveredAt?: string | null
}

interface Inbound {
	MessageId?: string | number
	InboundNumber?: string
	/** The person writing to you, in E.164. */
	Sender?: string
	Body?: string
	ReceivedAt?: string
	/** `sms`, or `web` for a reply typed into PureSMS's own web view. */
	Channel?: string
}

const RECEIPT = 1
const INBOUND = 2

/**
 * `DeliveryStatus` → normalized event. Queued is PureSMS holding the message, Cancelled and
 * Deleted are things somebody did to it before it went, and Unknown says nothing; none of
 * those is something that happened to a send, so none is emitted.
 */
const TYPES: Record<number, WebhookEventType> = {
	2: "sent",
	7: "delivered",
	3: "failed",
	5: "failed",
	8: "failed",
	9: "failed",
}

/** `X-Webhook-Signature` for a timestamp and a body. */
export async function puresms_signature(secret: string, timestamp: string, body: string) {
	return base64_encode(await hmac_sha256(secret, `${timestamp}.${body}`))
}

/** The `MessageId` exactly as written in the body, so a 64-bit id keeps every digit. */
function message_id(body: string, data: Receipt | Inbound): string | undefined {
	const written = /"MessageId"\s*:\s*"?(\d+)"?/.exec(body)?.[1]
	if (written) return written
	return data.MessageId === undefined || data.MessageId === null
		? undefined
		: String(data.MessageId)
}

function normalize_receipt(body: string, envelope: Envelope, data: Receipt) {
	const type = TYPES[data.DeliveryStatus ?? 0]
	if (!type) return undefined
	const detail =
		[data.ErrorCode, data.DeliveryStatusStr]
			.filter((part) => part !== undefined && part !== null && part !== "")
			.join(" ") || undefined
	return {
		type,
		provider: "puresms",
		channel: "sms",
		message_id: message_id(body, data),
		timestamp: to_date(data.DeliveredAt ?? envelope.timestamp ?? data.ProcessedAt),
		tags: data.ClientReference ? [data.ClientReference] : undefined,
		bounce: type === "failed" ? { category: "unknown", detail } : undefined,
		raw: envelope,
	} satisfies WebhookEvent
}

const adapter: WebhookAdapter = {
	provider: "puresms",

	async verify(ctx) {
		const presented = ctx.headers.get("x-webhook-signature")
		const timestamp = ctx.headers.get("x-webhook-timestamp")
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "puresms",
				message:
					"No webhook secret configured for puresms. Set one on the endpoint in PureSMS, then PURESMS_WEBHOOK_SECRET or pass { secret }.",
				code: "missing_secret",
			})
		}
		const expected =
			presented && timestamp && (await puresms_signature(ctx.secret, timestamp, ctx.body))
		if (!expected || !timing_safe_equal(expected, presented)) {
			throw new WebhookVerificationError({
				provider: "puresms",
				message: presented
					? "puresms webhook signature did not match"
					: "puresms webhook is missing its X-Webhook-Signature header. Set a secret on the endpoint in PureSMS.",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const envelope = parse_json("puresms", body) as Envelope | null
		const data = envelope?.data
		if (!envelope || typeof envelope !== "object" || !data || typeof data !== "object") {
			throw new PostboiError({
				provider: "puresms",
				message: "puresms webhook payload is not an event",
				code: "invalid_payload",
				raw: envelope,
			})
		}
		if (envelope.event_type === INBOUND) {
			return [
				inbound_event({
					provider: "puresms",
					channel: "sms",
					phone: data.Sender,
					text: data.Body,
					message_id: message_id(body, data),
					timestamp: to_date(data.ReceivedAt ?? envelope.timestamp),
					raw: envelope,
				}),
			]
		}
		if (envelope.event_type === RECEIPT) {
			const event = normalize_receipt(body, envelope, data)
			return event ? [event] : []
		}
		return []
	},
}

export default adapter

/** Build a PureSMS sample request, signed with `secret`. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const now = new Date().toISOString()
	const replies: Partial<Record<WebhookEventType, string>> = {
		unsubscribed: "STOP",
		resubscribed: "START",
		received: "Yes, please confirm my appointment",
	}
	const reply = replies[type]
	const status = Number(Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? 7)
	// The numbers are from Ofcom's drama range (07700 900xxx), which is never allocated.
	const data =
		reply === undefined
			? `{"MessageId":357551956102758401,"ClientReference":"otp","DeliveryStatus":${status},"DeliveryStatusStr":"${status === 7 ? "Delivered" : status === 2 ? "Dispatched" : "Failed"}","ErrorCode":${status === 8 ? '"EC_UNKNOWN_SUBSCRIBER"' : "null"},"ProcessedAt":"${now}","DeliveredAt":${status === 7 ? `"${now}"` : "null"},"SmsParts":1}`
			: JSON.stringify({
					MessageId: "357552103948288001",
					InboundNumber: "+447700900100",
					Sender: "+447700900123",
					Body: reply,
					ReceivedAt: now,
					Channel: "sms",
				})
	// Written by hand rather than through JSON.stringify, so the receipt's id is the bare
	// 64-bit number PureSMS sends and the sample exercises the precision the adapter keeps.
	const body = `{"id":"b345429f-5aac-43e9-8394-302d04bab685","timestamp":"${now}","workspace_id":"129687389156151296","event_type":${reply === undefined ? RECEIPT : INBOUND},"data":${data}}`
	const timestamp = String(Math.floor(Date.now() / 1000))
	return {
		body,
		headers: {
			"content-type": "application/json",
			"x-webhook-timestamp": timestamp,
			"x-webhook-signature": await puresms_signature(secret, timestamp, body),
		},
	}
}
