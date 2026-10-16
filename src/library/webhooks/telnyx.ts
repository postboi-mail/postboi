/**
 * Telnyx webhooks — delivery events and inbound messages, for SMS.
 * https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks
 *
 * Telnyx posts to the messaging profile's webhook URL, or the one a send names
 * (`webhook_url` on the provider). Point it at `receive()` with `{ provider: "telnyx" }`.
 *
 * **Verification is Ed25519**, over `${telnyx-timestamp}|${raw body}`, carried base64 in
 * `telnyx-signature-ed25519`. The secret is Telnyx's *public* key for the account (Mission
 * Control → Keys & Credentials → Public Key), base64, set as `TELNYX_WEBHOOK_SECRET`.
 * Telnyx says to refuse a timestamp more than five minutes old, and retries are signed
 * afresh, so the window is enforced here. Telnyx also says duplicates happen and order
 * isn't guaranteed: deduplicate on the event's `data.id`, in `raw`.
 *
 * **Events**: `message.received` is someone writing to your number and goes through
 * `inbound_event` (STOP `unsubscribed`, START `resubscribed`, anything else `received`).
 * `message.sent` is `sent`; `message.finalized` carries the recipient's final status,
 * `delivered`, or `failed` for `delivery_failed`, `sending_failed` and `expired`, with the
 * carrier's code and words in `bounce.detail`. `delivery_unconfirmed` says nothing either
 * way and is dropped.
 */
import { PostboiError } from "../index.js"
import type { AdapterModule, WebhookAdapter, WebhookEvent, WebhookEventType } from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { base64_encode, verify_ed25519 } from "./crypto.js"
import { assert_fresh_timestamp, inbound_event, parse_json, to_date } from "./shared.js"

interface Party {
	phone_number?: string
	status?: string
}

interface MessagePayload {
	id?: string
	direction?: string
	from?: Party
	to?: Array<Party>
	text?: string
	tags?: Array<string>
	errors?: Array<{ code?: string | number; title?: string; detail?: string }>
	received_at?: string
	completed_at?: string
	sent_at?: string
}

interface Envelope {
	data?: {
		event_type?: string
		id?: string
		occurred_at?: string
		payload?: MessagePayload
	}
}

/** A recipient's final status → normalized event. `delivery_unconfirmed` is not one. */
const FINAL: Record<string, WebhookEventType> = {
	delivered: "delivered",
	delivery_failed: "failed",
	sending_failed: "failed",
	expired: "failed",
}

/** What went wrong, in one line, from Telnyx's `errors`. */
function failure_detail(payload: MessagePayload): string | undefined {
	const error = payload.errors?.[0]
	if (!error) return undefined
	return (
		[error.code, error.title ?? error.detail].filter((part) => part !== undefined).join(" ") ||
		undefined
	)
}

const adapter: WebhookAdapter = {
	provider: "telnyx",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "telnyx",
				message:
					"No webhook public key configured for telnyx. Set TELNYX_WEBHOOK_SECRET to the public key from Mission Control (Keys & Credentials), or pass { secret }.",
				code: "missing_secret",
			})
		}
		const signature = ctx.headers.get("telnyx-signature-ed25519")
		const timestamp = ctx.headers.get("telnyx-timestamp") ?? undefined
		if (!signature) {
			throw new WebhookVerificationError({
				provider: "telnyx",
				message: "telnyx webhook is missing its telnyx-signature-ed25519 header",
				code: "invalid_signature",
			})
		}
		assert_fresh_timestamp("telnyx", timestamp)
		let valid: boolean
		try {
			valid = await verify_ed25519({
				public_key: ctx.secret,
				signature,
				data: `${timestamp}|${ctx.body}`,
			})
		} catch (cause) {
			// Only a missing algorithm is the runtime's fault. A key or a signature that isn't
			// base64, or a key of the wrong length, is a request (or a setting) that doesn't verify.
			if (cause instanceof Error && cause.name === "NotSupportedError") {
				throw new WebhookVerificationError({
					provider: "telnyx",
					message:
						"This runtime's WebCrypto does not support Ed25519, which Telnyx webhook signatures require.",
					code: "unsupported_runtime",
					raw: cause,
				})
			}
			throw new WebhookVerificationError({
				provider: "telnyx",
				message: `telnyx webhook signature could not be checked: ${cause instanceof Error ? cause.message : String(cause)}. Check that TELNYX_WEBHOOK_SECRET is the account's base64 public key.`,
				code: "invalid_signature",
				raw: cause,
			})
		}
		if (!valid) {
			throw new WebhookVerificationError({
				provider: "telnyx",
				message: "telnyx webhook signature did not match",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const envelope = parse_json("telnyx", body) as Envelope | null
		const data = envelope?.data
		if (!data || typeof data !== "object") {
			throw new PostboiError({
				provider: "telnyx",
				message: "telnyx webhook payload has no data",
				code: "invalid_payload",
				raw: envelope,
			})
		}
		const payload = data.payload ?? {}
		const timestamp = to_date(data.occurred_at)

		if (data.event_type === "message.received") {
			return [
				inbound_event({
					provider: "telnyx",
					channel: "sms",
					phone: payload.from?.phone_number,
					text: payload.text,
					message_id: payload.id,
					timestamp: to_date(payload.received_at) ?? timestamp,
					raw: envelope,
				}),
			]
		}

		const recipient = payload.to?.[0]
		const type =
			data.event_type === "message.sent"
				? "sent"
				: data.event_type === "message.finalized"
					? FINAL[recipient?.status ?? ""]
					: undefined
		if (!type) return []
		const event: WebhookEvent = {
			type,
			provider: "telnyx",
			channel: "sms",
			phone: recipient?.phone_number,
			message_id: payload.id,
			timestamp,
			tags: payload.tags?.length ? payload.tags : undefined,
			// A text has no bounce classification; the carrier's code is the detail.
			bounce:
				type === "failed" ? { category: "unknown", detail: failure_detail(payload) } : undefined,
			raw: envelope,
		}
		return [event]
	},
}

export default adapter

/**
 * Build a signed Telnyx sample. Ed25519 needs a private key we can't have, so the mock
 * generates an ephemeral keypair and returns its public key as the secret to verify with.
 */
export const mock: AdapterModule["mock"] = async ({ type }) => {
	const now = new Date().toISOString()
	const replies: Partial<Record<WebhookEventType, string>> = {
		unsubscribed: "STOP",
		resubscribed: "START",
		received: "Thanks, see you then",
	}
	const reply = replies[type]
	const person = "+15557770006"
	const ours = "+15551110001"
	const status = Object.entries(FINAL).find(([, t]) => t === type)?.[0] ?? "delivered"
	const payload: MessagePayload =
		reply !== undefined
			? {
					id: "b0c7e8cb-6227-4c74-9f32-c7f80c30934b",
					direction: "inbound",
					from: { phone_number: person },
					to: [{ phone_number: ours }],
					text: reply,
					received_at: now,
				}
			: {
					id: "40385f64-5717-4562-b3fc-2c963f66afa6",
					direction: "outbound",
					from: { phone_number: ours },
					to: [{ phone_number: person, status: type === "sent" ? "sent" : status }],
					text: "Your code is 4291",
					...(status === "delivery_failed"
						? { errors: [{ code: "40008", title: "Undeliverable" }] }
						: {}),
				}
	const body = JSON.stringify({
		data: {
			event_type:
				reply !== undefined
					? "message.received"
					: type === "sent"
						? "message.sent"
						: "message.finalized",
			id: "0ccc7b54-4df3-4bca-a65a-3da1ecc777f0",
			occurred_at: now,
			payload,
			record_type: "event",
		},
		meta: { attempt: 1, delivered_to: "https://example.com/webhooks" },
	})

	const timestamp = String(Math.floor(Date.now() / 1000))
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"Ed25519",
			pair.privateKey,
			new TextEncoder().encode(`${timestamp}|${body}`)
		)
	)
	const public_key = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
	return {
		body,
		headers: {
			"content-type": "application/json",
			"telnyx-timestamp": timestamp,
			"telnyx-signature-ed25519": base64_encode(signature),
		},
		secret: base64_encode(public_key),
	}
}
