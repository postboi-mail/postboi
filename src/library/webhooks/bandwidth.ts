/**
 * Bandwidth webhooks — message callbacks and inbound messages.
 * https://dev.bandwidth.com/docs/messaging/webhooks/
 *
 * Bandwidth posts every callback for a messaging application to that application's
 * callback URL. Point it at `receive()` with `{ provider: "bandwidth" }`. The body is a JSON
 * array of events.
 *
 * **Verification is the application's Basic credentials.** Bandwidth doesn't sign its
 * callbacks; what it offers is a username and password on the application's callback, sent
 * as `Authorization: Basic`. Those are the only proof a request came from Bandwidth, so set
 * them, and set `BANDWIDTH_WEBHOOK_SECRET` to the same `username:password` (or the password
 * alone). Nothing is timestamped, so deduplicate on `dedupe_key`.
 *
 * **Events**: `message-received` goes through `inbound_event`. `message-delivered` is
 * `delivered` and `message-failed` is `failed`, with Bandwidth's `errorCode` and
 * `description` in `bounce.detail`, and `bounce.category: "filtered"` for its spam blocks
 * (4470, Bandwidth's own filter; 4770, the carrier's). `message-sending` (an MMS on its way) says nothing new
 * and is dropped. `message_id` is the id a send answered with, and the send's tag comes back
 * in `tags`.
 */
import { PostboiError } from "../index.js"
import type { AdapterModule, WebhookAdapter, WebhookEvent, WebhookEventType } from "./index.js"
import { basic_auth_verify, inbound_event, parse_json, to_date } from "./shared.js"

/** A callback type → normalized event. */
const TYPES: Record<string, WebhookEventType> = {
	"message-delivered": "delivered",
	"message-failed": "failed",
}

/** Bandwidth's codes for a text rejected as spam: 4470 by Bandwidth, 4770 by the carrier. */
const FILTERED = new Set(["4470", "4770"])

interface Callback {
	type?: string
	time?: string
	description?: string
	to?: string
	errorCode?: number | string
	message?: {
		id?: string
		time?: string
		to?: Array<string>
		from?: string
		text?: string
		tag?: string
		media?: Array<string>
	}
}

/** One callback as an event, or nothing for a type that isn't one. */
function event_of(callback: Callback): WebhookEvent | undefined {
	const message = callback.message ?? {}
	const timestamp = to_date(callback.time ?? message.time)
	if (callback.type === "message-received") {
		return inbound_event({
			provider: "bandwidth",
			channel: "sms",
			phone: message.from,
			text: message.text,
			message_id: message.id,
			timestamp,
			raw: callback,
		})
	}
	const type = TYPES[callback.type ?? ""]
	if (!type) return undefined
	const detail =
		[callback.errorCode, callback.description].filter((part) => part !== undefined).join(" ") ||
		undefined
	return {
		type,
		provider: "bandwidth",
		channel: "sms",
		phone: callback.to ?? message.to?.[0],
		message_id: message.id,
		timestamp,
		tags: message.tag ? [message.tag] : undefined,
		bounce:
			type === "failed"
				? {
						category: FILTERED.has(String(callback.errorCode ?? "")) ? "filtered" : "unknown",
						detail,
					}
				: undefined,
		raw: callback,
	}
}

const adapter: WebhookAdapter = {
	provider: "bandwidth",

	verify(ctx) {
		basic_auth_verify("bandwidth", ctx, "set on your Bandwidth application's callback")
	},

	normalize(body) {
		const parsed = parse_json("bandwidth", body)
		// Bandwidth sends an array; a lone object is read as one, rather than refused.
		const callbacks = Array.isArray(parsed) ? parsed : [parsed]
		if (callbacks.some((c) => !c || typeof c !== "object" || !("type" in c))) {
			throw new PostboiError({
				provider: "bandwidth",
				message: "bandwidth webhook payload is not a list of callbacks",
				code: "invalid_payload",
				raw: parsed,
			})
		}
		return (callbacks as Array<Callback>)
			.map(event_of)
			.filter((event): event is WebhookEvent => event !== undefined)
	},
}

export default adapter

/** Build a Bandwidth sample request, authenticated with `secret` as `username:password`. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const now = new Date().toISOString()
	const replies: Partial<Record<WebhookEventType, string>> = {
		unsubscribed: "STOP",
		resubscribed: "START",
		received: "Thanks, see you then",
	}
	const reply = replies[type]
	const person = "+15557770006"
	const ours = "+15551110001"
	const callback: Callback =
		reply !== undefined
			? {
					type: "message-received",
					time: now,
					description: "Incoming message received",
					to: ours,
					message: {
						id: "1661365814859loidf7mcwd4qacn7",
						time: now,
						to: [ours],
						from: person,
						text: reply,
					},
				}
			: {
					type: type === "failed" ? "message-failed" : "message-delivered",
					time: now,
					description: type === "failed" ? "rejected-unallocated-from-number" : "ok",
					to: person,
					...(type === "failed" ? { errorCode: 9902 } : {}),
					message: {
						id: "1661365814859loidf7mcwd4qacn6",
						time: now,
						to: [person],
						from: ours,
						text: "",
						tag: "otp",
					},
				}
	const credentials = secret.includes(":") ? secret : `bandwidth:${secret}`
	return {
		body: JSON.stringify([callback]),
		headers: {
			"content-type": "application/json",
			authorization: `Basic ${btoa(credentials)}`,
		},
	}
}
