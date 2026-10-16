/**
 * Vonage webhooks — message status and inbound messages, for SMS, from the Messages API.
 * https://developer.vonage.com/en/messages/concepts/signed-webhooks
 *
 * The application's Status URL and Inbound URL (or `webhook_url` on the provider) point at
 * `receive()` with `{ provider: "vonage" }`. Both arrive as JSON; one handler takes both.
 *
 * **Verification is a JWT** in `Authorization: Bearer …`, HS256, signed with the account's
 * signature secret (Dashboard → Settings → Signature secret), set as
 * `VONAGE_WEBHOOK_SECRET`. Only HS256 is accepted, whatever the token's header says, so a
 * token can't talk its way into another algorithm. The claims must carry `payload_hash`,
 * the hex SHA-256 of the body exactly as delivered, which is what binds the token to this
 * body rather than any body; a token without one is refused. Vonage documents no freshness window for `iat`, and a
 * redelivery may reuse a token, so none is enforced: deduplicate on `message_uuid` and
 * `type`.
 *
 * **Events**: a status is `submitted` (`sent`), `delivered`, or `rejected` / `undeliverable`
 * (`failed`, with Vonage's error title and detail in `bounce.detail`). An inbound message
 * carries `text` and no `status`, and goes through `inbound_event`. Numbers arrive without
 * their `+`, which is put back.
 */
import { PostboiError } from "../index.js"
import type { AdapterModule, WebhookAdapter, WebhookEvent, WebhookEventType } from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { hex_encode, hmac_sha256, timing_safe_equal } from "./crypto.js"
import { inbound_event, parse_json, to_date } from "./shared.js"
import { from_base64url, to_base64url } from "../encoding.js"

interface Payload {
	message_uuid?: string
	to?: string
	from?: string
	timestamp?: string
	channel?: string
	status?: string
	message_type?: string
	text?: string
	client_ref?: string
	error?: { type?: string; title?: string | number; detail?: string }
}

/** Status → normalized event. Anything else Vonage reports is not something we emit. */
const TYPES: Record<string, WebhookEventType> = {
	submitted: "sent",
	delivered: "delivered",
	rejected: "failed",
	undeliverable: "failed",
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** `447700900123` → `+447700900123`; anything that isn't digits is left alone. */
function e164(value: string | undefined): string | undefined {
	if (!value) return undefined
	return /^\d+$/.test(value) ? `+${value}` : value
}

async function sha256_hex(body: string): Promise<string> {
	return hex_encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body))))
}

/** An HS256 JWT over `claims`, keyed with `secret`. */
export async function vonage_token(
	secret: string,
	claims: Record<string, unknown>
): Promise<string> {
	const header = to_base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))
	const payload = to_base64url(encoder.encode(JSON.stringify(claims)))
	const signature = to_base64url(await hmac_sha256(secret, `${header}.${payload}`))
	return `${header}.${payload}.${signature}`
}

function refuse(message: string): never {
	throw new WebhookVerificationError({ provider: "vonage", message, code: "invalid_signature" })
}

const adapter: WebhookAdapter = {
	provider: "vonage",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "vonage",
				message:
					"No signature secret configured for vonage. Set VONAGE_WEBHOOK_SECRET to the signature secret from the dashboard's settings, or pass { secret }.",
				code: "missing_secret",
			})
		}
		const token = /^Bearer\s+(.+)$/i.exec(ctx.headers.get("authorization") ?? "")?.[1]
		if (!token) refuse("vonage webhook carries no Bearer token")
		const parts = token.split(".")
		if (parts.length !== 3) refuse("vonage webhook token is not a JWT")
		const [header_part, payload_part, signature_part] = parts

		let header: { alg?: string }
		let claims: { payload_hash?: string }
		try {
			header = JSON.parse(decoder.decode(from_base64url(header_part)))
			claims = JSON.parse(decoder.decode(from_base64url(payload_part)))
		} catch {
			refuse("vonage webhook token is not readable")
		}
		if (header.alg !== "HS256") refuse(`vonage webhook token uses ${header.alg}, not HS256`)

		const expected = to_base64url(await hmac_sha256(ctx.secret, `${header_part}.${payload_part}`))
		if (!timing_safe_equal(expected, signature_part))
			refuse("vonage webhook signature did not match")
		// Vonage puts `payload_hash` on every signed Messages webhook, and it is the only thing
		// tying the token to this body. Without it a token lifted from one request would carry
		// any body, for ever, since nothing here bounds `iat` either.
		if (claims.payload_hash === undefined) refuse("vonage webhook token carries no payload_hash")
		const actual = await sha256_hex(ctx.body)
		if (!timing_safe_equal(actual, String(claims.payload_hash).toLowerCase())) {
			refuse("vonage webhook body does not match the token's payload_hash")
		}
	},

	normalize(body) {
		const payload = parse_json("vonage", body) as Payload | null
		if (!payload || typeof payload !== "object" || !payload.message_uuid) {
			throw new PostboiError({
				provider: "vonage",
				message: "vonage webhook payload has no message_uuid",
				code: "invalid_payload",
				raw: payload,
			})
		}
		const timestamp = to_date(payload.timestamp)

		if (payload.status === undefined) {
			return [
				inbound_event({
					provider: "vonage",
					channel: "sms",
					phone: e164(payload.from),
					text: payload.text,
					message_id: payload.message_uuid,
					timestamp,
					raw: payload,
				}),
			]
		}

		const type = TYPES[payload.status]
		if (!type) return []
		const detail =
			[payload.error?.title, payload.error?.detail]
				.filter((part) => part !== undefined)
				.join(" ") || undefined
		const event: WebhookEvent = {
			type,
			provider: "vonage",
			channel: "sms",
			phone: e164(payload.to),
			message_id: payload.message_uuid,
			timestamp,
			tags: payload.client_ref ? [payload.client_ref] : undefined,
			bounce: type === "failed" ? { category: "unknown", detail } : undefined,
			raw: payload,
		}
		return [event]
	},
}

export default adapter

/** Build a Vonage sample, signed with `secret` as the signature secret. */
export const mock: AdapterModule["mock"] = async ({ type, secret }) => {
	const now = new Date().toISOString()
	const replies: Partial<Record<WebhookEventType, string>> = {
		unsubscribed: "STOP",
		resubscribed: "START",
		received: "Thanks, see you then",
	}
	const reply = replies[type]
	const status = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivered"
	const payload: Payload =
		reply !== undefined
			? {
					message_uuid: "aaaaaaaa-bbbb-cccc-dddd-0123456789ab",
					to: "447700900100",
					from: "447700900123",
					timestamp: now,
					channel: "sms",
					message_type: "text",
					text: reply,
				}
			: {
					message_uuid: "aaaaaaaa-bbbb-cccc-dddd-0123456789ac",
					to: "447700900123",
					from: "ACME",
					timestamp: now,
					channel: "sms",
					status,
					client_ref: "otp",
					...(status === "rejected"
						? {
								error: {
									type: "https://developer.vonage.com/api-errors/messages#1170",
									title: 1170,
									detail: "Invalid recipient",
								},
							}
						: {}),
				}
	const body = JSON.stringify(payload)
	const token = await vonage_token(secret, {
		iat: Math.floor(Date.now() / 1000),
		jti: crypto.randomUUID(),
		iss: "Vonage",
		payload_hash: await sha256_hex(body),
		api_key: "mock-key",
	})
	return {
		body,
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
	}
}
