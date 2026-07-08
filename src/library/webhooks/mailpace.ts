import type { WebhookAdapter, WebhookEventType, AdapterModule } from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { parse_json, to_date } from "./shared.js"
import { verify_ed25519, base64_encode } from "./crypto.js"

/**
 * MailPace webhook payload — https://docs.mailpace.com/guide/webhooks/
 */
interface MailPacePayload {
	event?: string
	created_at?: string
	payload?: {
		status?: string
		id?: number
		to?: string
		from?: string
		subject?: string
		tags?: string | Array<string>
		message_id?: string
	}
}

const TYPES: Record<string, WebhookEventType> = {
	"email.queued": "sent",
	"email.delivered": "delivered",
	"email.deferred": "delayed",
	"email.bounced": "bounced",
	"email.spam": "complained",
}

/**
 * MailPace webhook adapter. Verification is Ed25519 over the raw body
 * (`X-MailPace-Signature`), with the account's public verification key as the secret.
 * Throws `unsupported_runtime` where WebCrypto lacks Ed25519.
 */
const adapter: WebhookAdapter = {
	provider: "mailpace",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "mailpace",
				message:
					"No webhook public key configured for mailpace. Set MAILPACE_WEBHOOK_SECRET to your account's webhook verification key, or pass { secret }.",
				code: "missing_secret",
			})
		}
		const signature = ctx.headers.get("x-mailpace-signature")
		if (!signature) {
			throw new WebhookVerificationError({
				provider: "mailpace",
				message: "mailpace webhook is missing its X-MailPace-Signature header",
				code: "invalid_signature",
			})
		}
		let valid: boolean
		try {
			valid = await verify_ed25519({ public_key: ctx.secret, signature, data: ctx.body })
		} catch (cause) {
			throw new WebhookVerificationError({
				provider: "mailpace",
				message:
					"This runtime's WebCrypto does not support Ed25519, which MailPace webhook signatures require.",
				code: "unsupported_runtime",
				raw: cause,
			})
		}
		if (!valid) {
			throw new WebhookVerificationError({
				provider: "mailpace",
				message: "mailpace webhook signature did not match",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const payload = parse_json("mailpace", body) as MailPacePayload
		const type = payload.event ? TYPES[payload.event] : undefined
		if (!type) return []
		const data = payload.payload ?? {}
		return [
			{
				type,
				provider: "mailpace",
				message_id: data.message_id ?? (data.id !== undefined ? String(data.id) : undefined),
				email: data.to,
				timestamp: to_date(payload.created_at),
				subject: data.subject,
				tags: data.tags ? (Array.isArray(data.tags) ? data.tags : [data.tags]) : undefined,
				bounce: type === "bounced" ? { category: "unknown", detail: data.status } : undefined,
				raw: payload,
			},
		]
	},
}

export default adapter

/**
 * Build a signed MailPace sample. Ed25519 needs a private key we can't have, so the mock
 * generates an ephemeral keypair and returns its public key as the secret to verify with.
 */
export const mock: AdapterModule["mock"] = async ({ type }) => {
	const mailpace_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "email.delivered"
	const body = JSON.stringify({
		event: mailpace_type,
		created_at: new Date().toISOString(),
		payload: {
			status: type === "bounced" ? "bounced" : "delivered",
			id: 42,
			to: "recipient@example.com",
			from: "mock@example.com",
			subject: "Mock subject",
			tags: ["welcome"],
			message_id: "mock-message-id",
		},
	})

	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair
	const signature = new Uint8Array(
		await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(body))
	)
	const public_key = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))

	return {
		body,
		headers: {
			"x-mailpace-signature": base64_encode(signature),
			"content-type": "application/json",
		},
		secret: base64_encode(public_key),
	}
}
