/**
 * Sinch webhooks — delivery reports and inbound messages, from the SMS API.
 * https://developers.sinch.com/docs/sms/api-reference/sms/tag/Delivery-reports/
 *
 * Delivery reports go to the `callback_url` a send names (`SINCH_CALLBACK_URL`, which asks
 * for one report per recipient) or the service plan's default, and inbound texts to the
 * plan's callback. Point both at `receive()` with `{ provider: "sinch" }`. Both are JSON.
 *
 * **Verification is an HMAC signature or the Basic credentials, whichever Sinch sends.**
 * With HMAC turned on for the service plan (your account manager does this), every callback
 * carries `x-sinch-webhook-signature`: the base64 HMAC-SHA256, keyed with the secret you
 * agreed, of the body, a `.`, `x-sinch-webhook-signature-nonce`, a `.` and
 * `x-sinch-webhook-signature-timestamp`. A signature older than five minutes is refused, so
 * a captured request can't be replayed later. Without it, what Sinch documents is
 * credentials in the callback URL (`https://user:pass@example.com/hooks/sinch`), which
 * arrive as `Authorization: Basic`; nothing in those is timestamped, so deduplicate on
 * `dedupe_key`. Either way `SINCH_WEBHOOK_SECRET` is the secret: the HMAC key, or the same
 * `username:password` (or the password alone). A `?token=` on the URL works too.
 *
 * **Events**: a `recipient_delivery_report_sms` is one recipient's state: `Dispatched` is
 * `sent`, `Delivered` is `delivered`, and `Aborted`, `Rejected`, `Failed`, `Expired`,
 * `Cancelled` and `Deleted` are `failed`, with Sinch's status code in `bounce.detail`, and
 * `bounce.category: "filtered"` for its spam blocks (15, screening; 62, its spam filter). A
 * batch report (`delivery_report_sms`, the plan's default) is one event per recipient it
 * lists, and nothing for a summary that lists none. `message_id` is the batch id a send
 * answered with. An inbound `mo_text` goes through `inbound_event`. Numbers are given back
 * their `+`.
 */
import { PostboiError } from "../index.js"
import type {
	AdapterModule,
	VerifyContext,
	WebhookAdapter,
	WebhookEvent,
	WebhookEventType,
} from "./index.js"
import { WebhookVerificationError, type WebhookVerificationCode } from "./errors.js"
import { base64_encode, hmac_sha256, timing_safe_equal } from "./crypto.js"
import { basic_auth_verify, inbound_event, parse_json, plus_e164, to_date } from "./shared.js"

/** A status → normalized event. `Queued` and `Unknown` say nothing new. */
const TYPES: Record<string, WebhookEventType> = {
	dispatched: "sent",
	delivered: "delivered",
	aborted: "failed",
	rejected: "failed",
	failed: "failed",
	expired: "failed",
	cancelled: "failed",
	deleted: "failed",
}

/**
 * Sinch's codes for a text blocked as spam: 15, "screening blocked the message for possible
 * spam", and 62, its own spam filter. 255 isn't here: it also covers an opted-out number.
 */
const FILTERED = new Set(["15", "62"])

/** How far a signed callback's timestamp may be from now, in seconds. */
const TOLERANCE_SECONDS = 300

/** `x-sinch-webhook-signature` for a body, a nonce and a timestamp, keyed with `secret`. */
export async function sinch_signature(
	secret: string,
	body: string,
	nonce: string,
	timestamp: string
): Promise<string> {
	return base64_encode(await hmac_sha256(secret, `${body}.${nonce}.${timestamp}`))
}

function fail(message: string, code: WebhookVerificationCode = "invalid_signature"): never {
	throw new WebhookVerificationError({ provider: "sinch", message, code })
}

/** Check a callback signed with HMAC, which is the one that carries the signature header. */
async function hmac_verify(ctx: VerifyContext, signature: string) {
	if (!ctx.secret) {
		fail(
			"No secret configured for sinch. Set SINCH_WEBHOOK_SECRET to the HMAC secret, or pass { secret }.",
			"missing_secret"
		)
	}
	const nonce = ctx.headers.get("x-sinch-webhook-signature-nonce")
	const timestamp = ctx.headers.get("x-sinch-webhook-signature-timestamp")
	if (!nonce || !timestamp) fail("sinch webhook signature is missing its nonce or timestamp")
	const algorithm = ctx.headers.get("x-sinch-webhook-signature-algorithm")
	if (algorithm && algorithm.toLowerCase() !== "hmacsha256") {
		fail(`sinch webhook is signed with ${algorithm}, which postboi doesn't check`)
	}
	// Seconds since the epoch. A timestamp that isn't one is still signed; it just can't be aged.
	const seconds = Number(timestamp)
	if (Number.isFinite(seconds) && Math.abs(Date.now() / 1000 - seconds) > TOLERANCE_SECONDS) {
		fail("sinch webhook timestamp is too old or in the future", "stale_timestamp")
	}
	const expected = await sinch_signature(ctx.secret, ctx.body, nonce, timestamp)
	if (!timing_safe_equal(expected, signature)) {
		fail(
			"sinch webhook signature did not match. Check SINCH_WEBHOOK_SECRET is the HMAC secret agreed with Sinch."
		)
	}
}

interface Report {
	type?: string
	batch_id?: string
	recipient?: string
	code?: number | string
	status?: string
	at?: string
	client_reference?: string
	statuses?: Array<{ code?: number | string; status?: string; recipients?: Array<string> }>
	// Inbound
	id?: string
	from?: string
	to?: string
	body?: string
	received_at?: string
}

/** One recipient's report as an event, or nothing for a status that isn't one. */
function report_event(
	report: Report,
	recipient: string | undefined,
	status: string | undefined,
	code: number | string | undefined
): WebhookEvent | undefined {
	const type = TYPES[status?.toLowerCase() ?? ""]
	if (!type) return undefined
	return {
		type,
		provider: "sinch",
		channel: "sms",
		phone: plus_e164(recipient),
		message_id: report.batch_id,
		timestamp: to_date(report.at),
		tags: report.client_reference ? [report.client_reference] : undefined,
		// A text has no bounce classification; Sinch's status and code are the detail.
		bounce:
			type === "failed"
				? {
						category: FILTERED.has(String(code ?? "")) ? "filtered" : "unknown",
						detail: [status, code].filter((p) => p !== undefined).join(" "),
					}
				: undefined,
		raw: report,
	}
}

const adapter: WebhookAdapter = {
	provider: "sinch",

	async verify(ctx) {
		const signature = ctx.headers.get("x-sinch-webhook-signature")
		if (signature) return hmac_verify(ctx, signature)
		basic_auth_verify("sinch", ctx, "in your Sinch callback URL")
	},

	normalize(body) {
		const report = parse_json("sinch", body) as Report | null
		if (!report || typeof report !== "object" || Array.isArray(report)) {
			throw new PostboiError({
				provider: "sinch",
				message: "sinch webhook payload is not a JSON object",
				code: "invalid_payload",
				raw: report,
			})
		}
		if (report.type === "mo_text") {
			return [
				inbound_event({
					provider: "sinch",
					channel: "sms",
					phone: plus_e164(report.from),
					text: report.body,
					message_id: report.id,
					timestamp: to_date(report.received_at),
					raw: report,
				}),
			]
		}
		if (report.type === "recipient_delivery_report_sms") {
			const event = report_event(report, report.recipient, report.status, report.code)
			return event ? [event] : []
		}
		if (report.type === "delivery_report_sms") {
			const events: Array<WebhookEvent> = []
			for (const entry of report.statuses ?? []) {
				for (const recipient of entry.recipients ?? []) {
					const event = report_event(report, recipient, entry.status, entry.code)
					if (event) events.push(event)
				}
			}
			return events
		}
		return []
	},
}

export default adapter

/**
 * Build a Sinch sample request, authenticated with `secret` as `username:password`. A secret
 * starting `hmac:` signs it with HMAC instead, keyed with the rest, which is the secret returned.
 */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const now = new Date().toISOString()
	const replies: Partial<Record<WebhookEventType, string>> = {
		unsubscribed: "STOP",
		resubscribed: "START",
		received: "Thanks, see you then",
	}
	const reply = replies[type]
	const status = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivered"
	const payload: Report =
		reply !== undefined
			? {
					type: "mo_text",
					id: "01FC66621VHDBN119Z8PMV1QPQ",
					from: "15557770006",
					to: "15551110001",
					body: reply,
					received_at: now,
				}
			: {
					type: "recipient_delivery_report_sms",
					batch_id: "01FC66621XXXXX119Z8PMV1QPU",
					recipient: "15557770006",
					code: type === "failed" ? 404 : 0,
					status: status[0].toUpperCase() + status.slice(1),
					at: now,
					client_reference: "otp",
				}
	const body = JSON.stringify(payload)
	if (secret.startsWith("hmac:")) {
		const nonce = "01FJA8B4A7BM672RDXN9HZG3N2"
		const timestamp = String(Math.floor(Date.now() / 1000))
		const key = secret.slice("hmac:".length)
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"x-sinch-webhook-signature-algorithm": "HmacSHA256",
			"x-sinch-webhook-signature-nonce": nonce,
			"x-sinch-webhook-signature-timestamp": timestamp,
			"x-sinch-webhook-signature": await sinch_signature(key, body, nonce, timestamp),
		}
		return { body, secret: key, headers }
	}
	const credentials = secret.includes(":") ? secret : `sinch:${secret}`
	return {
		body,
		headers: {
			"content-type": "application/json",
			authorization: `Basic ${btoa(credentials)}`,
		},
	}
}
