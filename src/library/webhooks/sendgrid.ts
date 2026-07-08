import type { WebhookAdapter, WebhookEvent, WebhookEventType, AdapterModule } from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { parse_json, engagement, to_date } from "./shared.js"
import { verify_ecdsa_p256_sha256, base64_encode } from "./crypto.js"

/**
 * SendGrid Event Webhook payload — a JSON array of events.
 * https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event
 */
interface SendGridEvent {
	email?: string
	timestamp?: number
	event?: string
	sg_message_id?: string
	category?: string | Array<string>
	url?: string
	ip?: string
	useragent?: string
	reason?: string
	type?: string
	status?: string
}

const TYPES: Record<string, WebhookEventType> = {
	processed: "sent",
	delivered: "delivered",
	deferred: "delayed",
	bounce: "bounced",
	blocked: "bounced",
	spamreport: "complained",
	open: "opened",
	click: "clicked",
	dropped: "failed",
	unsubscribe: "unsubscribed",
	group_unsubscribe: "unsubscribed",
}

const SIGNATURE_HEADER = "x-twilio-email-event-webhook-signature"
const TIMESTAMP_HEADER = "x-twilio-email-event-webhook-timestamp"

/**
 * SendGrid webhook adapter. Verification is the Signed Event Webhook: ECDSA P-256 /
 * SHA-256 over `timestamp + body`, with the base64 public verification key from the
 * SendGrid dashboard as the secret.
 */
const adapter: WebhookAdapter = {
	provider: "sendgrid",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "sendgrid",
				message:
					"No webhook verification key configured for sendgrid. Set SENDGRID_WEBHOOK_SECRET to the Signed Event Webhook public key, or pass { secret }.",
				code: "missing_secret",
			})
		}
		const signature = ctx.headers.get(SIGNATURE_HEADER)
		const timestamp = ctx.headers.get(TIMESTAMP_HEADER)
		if (!signature || !timestamp) {
			throw new WebhookVerificationError({
				provider: "sendgrid",
				message: "sendgrid webhook is missing its signature headers",
				code: "invalid_signature",
			})
		}
		// A malformed key/signature is a failed verification, not a crash.
		const valid = await verify_ecdsa_p256_sha256({
			public_key: ctx.secret,
			signature,
			data: timestamp + ctx.body,
		}).catch(() => false)
		if (!valid) {
			throw new WebhookVerificationError({
				provider: "sendgrid",
				message: "sendgrid webhook signature did not match",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const payload = parse_json("sendgrid", body)
		const items = Array.isArray(payload) ? (payload as Array<SendGridEvent>) : []

		const events: Array<WebhookEvent> = []
		for (const item of items) {
			const type = item.event ? TYPES[item.event] : undefined
			if (!type) continue
			events.push({
				type,
				provider: "sendgrid",
				// sg_message_id carries filter suffixes; the send API returned the first segment.
				message_id: item.sg_message_id?.split(".")[0],
				email: item.email,
				timestamp: to_date(item.timestamp),
				tags: item.category
					? Array.isArray(item.category)
						? item.category
						: [item.category]
					: undefined,
				url: item.url,
				bounce:
					type === "bounced"
						? {
								category: item.event === "bounce" && item.type !== "blocked" ? "hard" : "soft",
								detail: item.reason,
							}
						: undefined,
				...engagement(item.useragent, item.ip),
				raw: item,
			})
		}
		return events
	},
}

export default adapter

/**
 * Build a signed SendGrid sample. ECDSA needs a private key we can't have, so the mock
 * generates an ephemeral keypair and returns its public key as the secret to verify with.
 */
export const mock: AdapterModule["mock"] = async ({ type }) => {
	const sendgrid_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivered"
	const event: SendGridEvent = {
		email: "recipient@example.com",
		timestamp: Math.floor(Date.now() / 1000),
		event: sendgrid_type,
		sg_message_id: "mock-message-id.filter001.1234.0",
		category: ["welcome"],
	}
	if (type === "opened" || type === "clicked") {
		event.ip = "192.0.2.1"
		event.useragent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
	}
	if (type === "clicked") event.url = "https://example.com/pricing"
	if (type === "bounced") event.reason = "550 mailbox unavailable"

	const body = JSON.stringify([event])
	const timestamp = String(Math.floor(Date.now() / 1000))

	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])
	const raw = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			pair.privateKey,
			new TextEncoder().encode(timestamp + body)
		)
	)
	const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))

	return {
		body,
		headers: {
			[SIGNATURE_HEADER]: base64_encode(p1363_to_der(raw)),
			[TIMESTAMP_HEADER]: timestamp,
			"content-type": "application/json",
		},
		secret: base64_encode(spki),
	}
}

/** P1363 (r||s) → DER, since SendGrid sends DER and WebCrypto signs raw. */
function p1363_to_der(raw: Uint8Array): Uint8Array {
	const integer = (bytes: Uint8Array): Array<number> => {
		let start = 0
		while (start < bytes.length - 1 && bytes[start] === 0) start++
		let body = Array.from(bytes.slice(start))
		if (body[0] & 0x80) body = [0, ...body]
		return [0x02, body.length, ...body]
	}
	const r = integer(raw.slice(0, 32))
	const s = integer(raw.slice(32))
	return new Uint8Array([0x30, r.length + s.length, ...r, ...s])
}
