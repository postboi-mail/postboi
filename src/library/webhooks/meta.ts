/**
 * Meta WhatsApp Cloud API webhook adapter — delivery receipts and inbound messages for
 * the `meta` WhatsApp provider.
 *
 * Unlike Twilio, Meta pushes proper webhooks: one endpoint registered once on the app,
 * fed for every number the WhatsApp Business Account owns, so it belongs with
 * `receive()` rather than `poll()`. Two things are Meta's own:
 *
 * - **Verification is `X-Hub-Signature-256`** — `sha256=<hex>` of the raw body, keyed
 *   with the app's **App Secret** (Basic Settings in the app dashboard). That is what
 *   `META_WEBHOOK_SECRET` holds.
 * - **The endpoint is handshaken before it is subscribed.** When the callback URL is
 *   saved, Meta GETs it with `hub.mode=subscribe`, `hub.verify_token` (a string you
 *   choose and type into the same dashboard form) and `hub.challenge`, and only
 *   subscribes if the challenge comes back as the body. `handshake()` in the module
 *   root answers that, comparing the token against `META_WEBHOOK_VERIFY_TOKEN`, and
 *   `webhook()` does it for you on any GET. The verify token is deliberately not the
 *   app secret: it travels in a query string, and query strings end up in access logs.
 *
 * The payload is one WhatsApp Business Account's `entry` list, each carrying `changes`
 * on the `messages` field: `statuses` are receipts for sends, `messages` are people
 * writing to the number. The shared vocabulary covers both — `read` is `opened`, because
 * it is the same fact as an email open; a `failed` status is `failed` with Meta's error
 * code and words in `bounce.detail` (a text message has no bounce *classification*); a
 * reply that is an opt-out keyword is `unsubscribed` for the sender; and anything else
 * somebody writes is `received`, the same event as a reply to an email, with `phone`
 * as the person and `body.text` as what they said. A `received` also means the 24-hour
 * customer service window just opened for that number.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */
import type { WebhookAdapter, WebhookEvent, WebhookEventType, AdapterModule } from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { is_opt_out } from "../sms/opt_out.js"
import { parse_json, to_date } from "./shared.js"
import { hmac_sha256, hex_encode, timing_safe_equal } from "./crypto.js"

interface MetaError {
	code?: number
	title?: string
	message?: string
	error_data?: { details?: string }
}

/** A receipt for one of your sends. */
interface MetaStatus {
	id?: string
	status?: string
	timestamp?: string
	recipient_id?: string
	errors?: Array<MetaError>
	conversation?: { id?: string; origin?: { type?: string }; expiration_timestamp?: string }
	pricing?: { billable?: boolean; category?: string; pricing_model?: string }
}

/** A message somebody sent to your number. */
interface MetaMessage {
	id?: string
	from?: string
	timestamp?: string
	type?: string
	text?: { body?: string }
	/** A quick-reply button on a template they tapped. */
	button?: { text?: string; payload?: string }
	/** A button or list row on an interactive message they tapped. */
	interactive?: {
		type?: string
		button_reply?: { id?: string; title?: string }
		list_reply?: { id?: string; title?: string; description?: string }
	}
	/**
	 * Present when they used WhatsApp's reply — `id` is the message they replied to, and
	 * `from` is who sent it: your number, or their own when they quoted themselves.
	 */
	context?: { from?: string; id?: string }
}

interface MetaValue {
	messaging_product?: string
	metadata?: { display_phone_number?: string; phone_number_id?: string }
	contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
	messages?: Array<MetaMessage>
	statuses?: Array<MetaStatus>
	errors?: Array<MetaError>
}

/** The envelope — https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components */
interface MetaPayload {
	object?: string
	entry?: Array<{
		id?: string
		changes?: Array<{ field?: string; value?: MetaValue }>
	}>
}

/**
 * Status → normalized event. `deleted` (they deleted the message before reading it) and
 * `warning` (a media message Meta chose not to deliver) aren't things that happened to
 * the send in the vocabulary's terms, so they produce no event at all.
 */
const TYPES: Record<string, WebhookEventType> = {
	sent: "sent",
	delivered: "delivered",
	read: "opened",
	failed: "failed",
}

/**
 * Inbound message types that are somebody saying something. A `reaction` is a thumbs-up
 * on your message, `system` is WhatsApp itself (a changed number), `unsupported` is a
 * kind of message the API can't carry — none is a person to reply to.
 */
const NOT_A_MESSAGE = new Set(["reaction", "system", "unsupported"])

/**
 * Meta addresses people by `wa_id` — the number's digits with no `+`. E.164 is what
 * `phone` promises everywhere else, so the `+` goes back on.
 */
function e164(digits: string | undefined): string | undefined {
	if (!digits) return undefined
	return digits.startsWith("+") ? digits : `+${digits}`
}

/**
 * What went wrong, in one line, for a message Meta couldn't deliver. Meta can list more
 * than one error on a status, and the actionable one (131047, the window) isn't always
 * first — so every one is kept, `code words` each, joined.
 */
function failure_detail(errors: Array<MetaError> | undefined): string | undefined {
	const lines = (errors ?? []).flatMap((error) => {
		const words = error.error_data?.details ?? error.message ?? error.title
		const code = error.code === undefined ? undefined : String(error.code)
		const line = code && words ? `${code} ${words}` : (words ?? code)
		return line ? [line] : []
	})
	return lines.length ? lines.join("; ") : undefined
}

/** One receipt as a normalized event — or nothing, for a status we don't emit. */
function normalize_status(status: MetaStatus): WebhookEvent | undefined {
	const type = status.status ? TYPES[status.status] : undefined
	if (!type || !status.id) return undefined
	return {
		type,
		provider: "meta",
		channel: "whatsapp",
		phone: e164(status.recipient_id),
		message_id: status.id,
		timestamp: to_date(status.timestamp),
		bounce:
			type === "failed"
				? { category: "unknown", detail: failure_detail(status.errors) }
				: undefined,
		raw: status,
	}
}

/**
 * One inbound message as a normalized event. A reply that is an opt-out keyword is an
 * `unsubscribed` for the number that sent it; anything else a person writes is
 * `received`, carrying their words when they were words — typed, or the label of the
 * button or list row they tapped. The id worth carrying on a `received` is the send
 * they answered, when they used WhatsApp's reply on one of yours — otherwise the
 * message's own.
 */
function normalize_message(message: MetaMessage): WebhookEvent | undefined {
	if (!message.id || !message.from) return undefined
	if (message.type && NOT_A_MESSAGE.has(message.type)) return undefined
	const text =
		message.text?.body ??
		message.button?.text ??
		message.interactive?.button_reply?.title ??
		message.interactive?.list_reply?.title
	const base: Pick<WebhookEvent, "provider" | "channel" | "phone" | "timestamp" | "raw"> = {
		provider: "meta",
		channel: "whatsapp",
		phone: e164(message.from),
		timestamp: to_date(message.timestamp),
		raw: message,
	}
	if (is_opt_out(text)) {
		return { ...base, type: "unsubscribed", message_id: message.id }
	}
	// A quoted message is only "the send they answered" when it wasn't theirs: WhatsApp
	// lets a person reply to their own earlier message too, and that id is no send of yours.
	const replied_to =
		message.context?.from && message.context.from !== message.from ? message.context.id : undefined
	return {
		...base,
		type: "received",
		message_id: replied_to ?? message.id,
		body: text ? { text } : undefined,
	}
}

/**
 * Meta WhatsApp Cloud API webhook adapter. Verification is HMAC-SHA256 (hex) of the raw
 * body with the app secret, carried as `X-Hub-Signature-256: sha256=…`; the endpoint
 * handshake compares `hub.verify_token` with the configured verify token.
 */
const adapter: WebhookAdapter = {
	provider: "meta",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "meta",
				message:
					"No webhook secret configured for meta. Set META_WEBHOOK_SECRET to the app secret from your Meta app's Basic Settings, or pass { secret }.",
				code: "missing_secret",
			})
		}
		const signature = ctx.headers.get("x-hub-signature-256")?.replace(/^sha256=/, "")
		// No header, no HMAC: an unsigned probe shouldn't cost a digest of a whole batch.
		if (
			!signature ||
			!timing_safe_equal(signature, hex_encode(await hmac_sha256(ctx.secret, ctx.body)))
		) {
			throw new WebhookVerificationError({
				provider: "meta",
				message: "meta webhook signature did not match",
				code: "invalid_signature",
			})
		}
	},

	handshake({ url }) {
		if (url.searchParams.get("hub.mode") !== "subscribe") return undefined
		const challenge = url.searchParams.get("hub.challenge")
		if (challenge === null) return undefined
		return { challenge, token: url.searchParams.get("hub.verify_token") ?? undefined }
	},

	normalize(body) {
		const payload = parse_json("meta", body) as MetaPayload
		// The same app can subscribe to other Meta products; only WhatsApp is ours.
		if (payload.object !== "whatsapp_business_account") return []

		const events: Array<WebhookEvent> = []
		for (const entry of payload.entry ?? []) {
			for (const change of entry.changes ?? []) {
				// Other fields (template status, account review) aren't delivery events.
				if (change.field !== "messages" || !change.value) continue
				for (const status of change.value.statuses ?? []) {
					const event = normalize_status(status)
					if (event) events.push(event)
				}
				for (const message of change.value.messages ?? []) {
					const event = normalize_message(message)
					if (event) events.push(event)
				}
			}
		}
		return events
	},
}

export default adapter

/** Build a realistic signed Meta sample request — used by `mock_request` and tests. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const now = String(Math.floor(Date.now() / 1000))
	// The person at +1 555 777 0006, on the receiving end of a send from your number —
	// or, for the two inbound samples, writing back to it.
	const person = "15557770006"
	const value: MetaValue = {
		messaging_product: "whatsapp",
		metadata: { display_phone_number: "15551110001", phone_number_id: "100000000000001" },
	}
	if (type === "unsubscribed" || type === "received") {
		const message: MetaMessage = {
			from: person,
			id: "wamid.mock-inbound",
			timestamp: now,
			type: "text",
			text: { body: type === "unsubscribed" ? "STOP" : "Thanks, that works for me." },
		}
		// A reply to one of yours — so the event carries the send it answers.
		if (type === "received") message.context = { from: "15551110001", id: "wamid.mock" }
		value.contacts = [{ wa_id: person, profile: { name: "Mock Person" } }]
		value.messages = [message]
	} else {
		// The one table, read backwards — so the sample can't drift from the mapping.
		const wire = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivered"
		const status: MetaStatus = {
			id: "wamid.mock",
			status: wire,
			timestamp: now,
			recipient_id: person,
		}
		if (wire === "failed") {
			status.errors = [
				{
					code: 131047,
					title: "Re-engagement message",
					message: "Re-engagement message",
					error_data: {
						details:
							"Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
					},
				},
			]
		} else {
			status.conversation = { id: "mock-conversation", origin: { type: "utility" } }
			status.pricing = { billable: true, pricing_model: "PMP", category: "utility" }
		}
		value.statuses = [status]
	}

	const body = JSON.stringify({
		object: "whatsapp_business_account",
		entry: [{ id: "200000000000002", changes: [{ field: "messages", value }] }],
	} satisfies MetaPayload)
	const signature = hex_encode(await hmac_sha256(secret, body))
	return {
		body,
		headers: { "x-hub-signature-256": `sha256=${signature}`, "content-type": "application/json" },
	}
}
