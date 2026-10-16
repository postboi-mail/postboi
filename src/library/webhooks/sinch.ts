/**
 * Sinch webhooks — delivery reports and inbound messages, from the SMS API.
 * https://developers.sinch.com/docs/sms/api-reference/sms/tag/Delivery-reports/
 *
 * Delivery reports go to the `callback_url` a send names (`SINCH_CALLBACK_URL`, which asks
 * for one report per recipient) or the service plan's default, and inbound texts to the
 * plan's callback. Point both at `receive()` with `{ provider: "sinch" }`. Both are JSON.
 *
 * **Verification is the Basic credentials on the callback URL.** Sinch's SMS API doesn't
 * publish a signature for these callbacks; what it does document is credentials in the
 * callback URL (`https://user:pass@example.com/hooks/sinch`), which arrive as an
 * `Authorization: Basic` header. Set `SINCH_WEBHOOK_SECRET` to the same `username:password`
 * (or the password alone). A `?token=` on the URL works too. Nothing is timestamped, so
 * deduplicate on `dedupe_key`.
 *
 * **Events**: a `recipient_delivery_report_sms` is one recipient's state: `Dispatched` is
 * `sent`, `Delivered` is `delivered`, and `Aborted`, `Rejected`, `Failed`, `Expired`,
 * `Cancelled` and `Deleted` are `failed`, with Sinch's status code in `bounce.detail`. A
 * batch report (`delivery_report_sms`, the plan's default) is one event per recipient it
 * lists, and nothing for a summary that lists none. `message_id` is the batch id a send
 * answered with. An inbound `mo_text` goes through `inbound_event`. Numbers are given back
 * their `+`.
 */
import { PostboiError } from "../index.js"
import type { AdapterModule, WebhookAdapter, WebhookEvent, WebhookEventType } from "./index.js"
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
				? { category: "unknown", detail: [status, code].filter((p) => p !== undefined).join(" ") }
				: undefined,
		raw: report,
	}
}

const adapter: WebhookAdapter = {
	provider: "sinch",

	verify(ctx) {
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

/** Build a Sinch sample request, authenticated with `secret` as `username:password`. */
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
	const credentials = secret.includes(":") ? secret : `sinch:${secret}`
	return {
		body: JSON.stringify(payload),
		headers: {
			"content-type": "application/json",
			authorization: `Basic ${btoa(credentials)}`,
		},
	}
}
