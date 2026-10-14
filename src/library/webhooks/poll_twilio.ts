/**
 * Twilio poll adapter — delivery receipts for SMS and WhatsApp.
 *
 * Twilio *can* push status callbacks, but only per message: the URL is set when the
 * message is created, so receiving them means every send having somewhere to call back
 * to. Polling the Message resource needs nothing set up at send time and no public
 * endpoint at all, which is what makes delivery receipts work the same way for a script
 * on a laptop as for a deployed app.
 * https://www.twilio.com/docs/messaging/api/message-resource
 *
 * One adapter covers both channels because Twilio has one Message resource for both:
 * a WhatsApp message is the same row with `whatsapp:` in front of its addresses. The
 * `channel` on each event says which, and the number lands in `phone` — never in
 * `email`, which stays what its name says.
 *
 * **The window is trailing, not incremental.** Twilio filters the list by `DateSent`,
 * but what changes over a message's life is its *status* — a message sent last night
 * and delivered this morning still has last night's `DateSent`. So every poll asks for
 * the last 24 hours rather than "since the last poll", and the cursor's `seen` map is
 * what makes that cheap: a message is only emitted when its status is different from
 * the one last seen, so the same row can be listed a hundred times and produce one
 * event per real transition.
 *
 * **Inbound replies are events too.** The same list carries what people text back: a
 * STOP is `unsubscribed` and a START `resubscribed` for that number, on whichever
 * channel they replied over, and anything else, HELP included, is `received` with their
 * words (see `inbound_event`). Twilio's own opt-out handling still applies where it
 * exists (US and Canadian long codes); this makes the fact reach *you*, so a suppression
 * can be written wherever you keep them. An alphanumeric sender can't be replied to at
 * all, so nothing arrives. The list doesn't carry Twilio's `OptOutType`, so a poll
 * matches keywords itself; the `twilio` webhook adapter reads Twilio's verdict.
 */
import { PostboiError } from "../index.js"
import type { Channel } from "../errors.js"
import { twilio_auth, twilio_messages_url } from "../twilio_common.js"
import type { PollAdapter, PollModule, PollResult } from "./poll.js"
import { parse_cursor } from "./poll.js"
import type { WebhookEvent, WebhookEventType } from "./index.js"
import { inbound_event, to_date } from "./shared.js"

interface Cursor {
	/** When the last poll ran. Informational — the query window is always trailing. */
	since?: string
	/** sid → the status it was last seen with. Insertion order is recency. */
	seen?: Record<string, string>
}

interface TwilioMessage {
	sid?: string
	status?: string
	to?: string
	from?: string
	body?: string
	direction?: string
	date_sent?: string
	date_updated?: string
	date_created?: string
	error_code?: number | string | null
	error_message?: string | null
}

interface TwilioList {
	messages?: Array<TwilioMessage>
	message?: string
	code?: number
}

/** How far back each poll looks. Twilio's DateSent filter is date-granular. */
const WINDOW_MS = 24 * 60 * 60 * 1000

const DEFAULT_LIMIT = 100

/** Twilio's own page ceiling. */
const MAX_PAGE_SIZE = 1000

/**
 * How many sids the cursor remembers. Past this the oldest are forgotten, so a status
 * change on a message that has been quiet for ~500 messages is re-emitted once — the
 * cost of a bounded cursor, and cheaper than the alternative of forgetting everything.
 */
const SEEN_CAP = 500

/**
 * Twilio message status → normalized event. The in-flight statuses (queued, sending,
 * accepted, scheduled) are recorded in the cursor but never emitted: they are the
 * provider thinking, not something that happened to the message. `read` is WhatsApp's
 * read receipt, which is the same fact as an email open.
 */
export const TYPES: Record<string, WebhookEventType> = {
	sent: "sent",
	delivered: "delivered",
	undelivered: "failed",
	failed: "failed",
	read: "opened",
}

/** `whatsapp:+15551234` → the channel and the bare number. */
export function address(value: string | undefined): {
	channel: Extract<Channel, "sms" | "whatsapp">
	phone?: string
} {
	if (!value) return { channel: "sms" }
	return value.startsWith("whatsapp:")
		? { channel: "whatsapp", phone: value.slice("whatsapp:".length) }
		: { channel: "sms", phone: value }
}

/** Twilio's DateSent filter takes a date, not an instant. */
function date_only(at: Date): string {
	return at.toISOString().slice(0, 10)
}

/** What went wrong, in one line, for a message Twilio couldn't deliver. */
function failure_detail(message: TwilioMessage): string | undefined {
	const code = message.error_code ?? undefined
	const text = message.error_message ?? undefined
	if (code && text) return `${code} ${text}`
	return text ?? (code ? String(code) : undefined)
}

/** One inbound message as a normalized event. The number is the *sender's*. */
function normalize_inbound(message: TwilioMessage): WebhookEvent | undefined {
	if (!message.sid) return undefined
	const { channel, phone } = address(message.from)
	return inbound_event({
		provider: "twilio",
		channel,
		phone,
		text: message.body,
		message_id: message.sid,
		timestamp: to_date(message.date_sent ?? message.date_created ?? message.date_updated),
		raw: message,
	})
}

/** One listed message as a normalized event — or nothing, for a status we don't emit. */
function normalize(message: TwilioMessage): WebhookEvent | undefined {
	if (message.direction?.startsWith("inbound")) return normalize_inbound(message)
	const type = message.status ? TYPES[message.status] : undefined
	if (!type || !message.sid) return undefined
	const { channel, phone } = address(message.to)
	return {
		type,
		provider: "twilio",
		channel,
		phone,
		message_id: message.sid,
		timestamp: to_date(message.date_sent ?? message.date_updated ?? message.date_created),
		// There is no bounce classification for a text message, so the category stays
		// "unknown" and the carrier's own code and words go in the detail — the one
		// field consumers already read for "why didn't this arrive".
		bounce:
			type === "failed" ? { category: "unknown", detail: failure_detail(message) } : undefined,
		raw: message,
	}
}

const adapter: PollAdapter = {
	provider: "twilio",

	async poll(ctx): Promise<PollResult> {
		const cursor = parse_cursor<Cursor>("twilio", ctx.cursor) ?? {}
		const page_size = Math.min(ctx.limit ?? DEFAULT_LIMIT, MAX_PAGE_SIZE)

		// The same helper the SMS provider sends through; with no id it is the list.
		const url = new URL(twilio_messages_url(ctx.options.account_sid))
		url.searchParams.set("DateSent>=", date_only(new Date(Date.now() - WINDOW_MS)))
		url.searchParams.set("PageSize", String(page_size))

		const response = await fetch(url, {
			headers: {
				Authorization: twilio_auth(ctx.options.account_sid, ctx.options.auth_token),
				Accept: "application/json",
			},
		})
		const data = (await response.json().catch(() => undefined)) as TwilioList | undefined
		if (!response.ok) {
			throw new PostboiError({
				provider: "twilio",
				status: response.status,
				code: data?.code,
				message: data?.message ?? `Twilio message list failed (${response.status})`,
				raw: data,
			})
		}

		const messages = data?.messages ?? []
		const seen: Record<string, string> = { ...cursor.seen }
		const events: Array<WebhookEvent> = []

		for (const message of messages) {
			const sid = message.sid
			const status = message.status
			if (!sid || !status) continue
			// An inbound message is somebody writing to you, not a receipt for a send —
			// its status never moves, so `seen` emits it exactly once.
			if (seen[sid] === status) continue
			// Delete first so the rewritten entry moves to the end: insertion order is
			// what SEEN_CAP trims by, and a message still moving shouldn't age out.
			delete seen[sid]
			seen[sid] = status

			const event = normalize(message)
			if (event) events.push(event)
		}

		// Never remember fewer than one page: a page is listed newest first, so trimming
		// inside it would forget the newest rows and re-emit them on every later poll.
		const trimmed = Object.entries(seen).slice(-Math.max(SEEN_CAP, page_size))
		return {
			events,
			cursor: JSON.stringify({
				since: new Date().toISOString(),
				seen: Object.fromEntries(trimmed),
			} satisfies Cursor),
			// A full page means Twilio had at least this much ready; poll again rather
			// than waiting out an interval with a backlog sitting there.
			more: messages.length >= page_size,
		}
	},
}

export default adapter

/** A realistic poll result for `mock_poll` — run through the adapter's own mapping. */
export const mock: PollModule["mock"] = async ({ type, channel }) => {
	const statuses: Partial<Record<WebhookEventType, string>> = {
		sent: "sent",
		delivered: "delivered",
		failed: "undelivered",
		opened: "read",
		unsubscribed: "received",
		resubscribed: "received",
		received: "received",
	}
	const status = statuses[type] ?? "delivered"
	const whatsapp = channel === "whatsapp"
	const now = new Date().toISOString()
	// The inbound samples: the person at +1 555 777 0006 texting back to the sender, so
	// the addresses swap around, and the number is theirs.
	const replies: Partial<Record<WebhookEventType, string>> = {
		unsubscribed: "STOP",
		resubscribed: "START",
		received: "Thanks, see you then",
	}
	const reply = replies[type]
	const inbound = reply !== undefined
	const person = whatsapp ? "whatsapp:+15557770006" : "+15557770006"
	const sender = whatsapp ? "whatsapp:+15551110001" : "+15551110001"
	const message: TwilioMessage = {
		sid: "SM00000000000000000000000000000000",
		status,
		to: inbound ? sender : person,
		from: inbound ? person : sender,
		direction: inbound ? "inbound" : "outbound-api",
		...(inbound ? { body: reply } : {}),
		date_sent: now,
		date_updated: now,
		...(status === "undelivered"
			? { error_code: 30006, error_message: "Landline or unreachable carrier" }
			: {}),
	}
	// Run through the adapter's own normalization, so a fixture can't drift from what
	// a real poll produces.
	const event = normalize(message)
	return {
		events: event ? [event] : [],
		cursor: JSON.stringify({
			since: now,
			seen: { [message.sid as string]: status },
		} satisfies Cursor),
	}
}
