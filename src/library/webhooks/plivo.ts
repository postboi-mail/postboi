/**
 * Plivo webhooks — message status and inbound messages, for SMS and MMS.
 * https://www.plivo.com/docs/messaging/concepts/signature-validation
 *
 * A message's status goes to the `url` a send names, or the application's Message URL, and
 * an inbound text to the number's application. Point both at `receive()` with
 * `{ provider: "plivo" }`. Both arrive form-encoded.
 *
 * **Verification is Plivo's V2 signature**, the one it documents for messaging:
 * `X-Plivo-Signature-V2` (or `X-Plivo-Signature-Ma-V2`, signed with the main account's
 * token) is the base64 HMAC-SHA256, keyed with the auth token, of the URL Plivo called
 * without its query string followed by `X-Plivo-Signature-V2-Nonce`. The secret is the auth
 * token itself, read from `PLIVO_WEBHOOK_SECRET` and then `PLIVO_AUTH_TOKEN`. Because the
 * URL is signed, it has to be the one Plivo was given: behind a proxy, pass it as
 * `receive(request, { url })`.
 *
 * V2 signs the URL and the nonce, not the body, and carries no timestamp. So a captured
 * request can be replayed, or its parameters changed, without the signature noticing: serve
 * the endpoint over HTTPS and deduplicate on `dedupe_key`. That is Plivo's scheme, not a
 * shortcut here; its V3, which signs the parameters, is documented for Voice only.
 *
 * **Events**: an inbound message carries `Text` and goes through `inbound_event`. A status is
 * `sent`, `delivered`, or `failed` for `failed`, `undelivered` and `rejected`, with Plivo's
 * `ErrorCode` in `bounce.detail` and `bounce.category: "filtered"` for 30, its code for a
 * text blocked as spam; `queued` says nothing new and is dropped. Numbers arrive
 * without their `+`, which is put back.
 */
import { PostboiError } from "../index.js"
import type { AdapterModule, WebhookAdapter, WebhookEvent, WebhookEventType } from "./index.js"
import { WebhookVerificationError } from "./errors.js"
import { base64_encode, hmac_sha256, timing_safe_equal } from "./crypto.js"
import { inbound_event, plus_e164 } from "./shared.js"

/** A status → normalized event. Anything else Plivo reports isn't one we emit. */
const TYPES: Record<string, WebhookEventType> = {
	sent: "sent",
	delivered: "delivered",
	failed: "failed",
	undelivered: "failed",
	rejected: "failed",
}

/**
 * Plivo's code for a text blocked as spam: 30, "Spam Detected". 960 isn't here: it also
 * covers a sending limit.
 */
const FILTERED_CODE = "30"

/** The URL Plivo signs: everything but the query string and the fragment. */
function signed_url(url: URL): string {
	return `${url.protocol}//${url.host}${url.pathname}`
}

/** `X-Plivo-Signature-V2` for a URL and a nonce, keyed with the auth token. */
export async function plivo_signature(auth_token: string, url: string, nonce: string) {
	return base64_encode(await hmac_sha256(auth_token, signed_url(new URL(url)) + nonce))
}

const adapter: WebhookAdapter = {
	provider: "plivo",
	secret_env: ["PLIVO_AUTH_TOKEN"],

	async verify(ctx) {
		const nonce = ctx.headers.get("x-plivo-signature-v2-nonce")
		const presented = [
			ctx.headers.get("x-plivo-signature-v2"),
			ctx.headers.get("x-plivo-signature-ma-v2"),
		].filter((value): value is string => Boolean(value))
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "plivo",
				message:
					"No auth token configured for plivo. Set PLIVO_WEBHOOK_SECRET or PLIVO_AUTH_TOKEN, or pass { secret }.",
				code: "missing_secret",
			})
		}
		if (!nonce || presented.length === 0) {
			throw new WebhookVerificationError({
				provider: "plivo",
				message: "plivo webhook is missing its X-Plivo-Signature-V2 header or its nonce",
				code: "invalid_signature",
			})
		}
		const expected = await plivo_signature(ctx.secret, ctx.url.href, nonce)
		if (presented.some((signature) => timing_safe_equal(expected, signature))) return
		throw new WebhookVerificationError({
			provider: "plivo",
			message:
				"plivo webhook signature did not match. Check the auth token, and that the URL is the one Plivo calls (pass { url } behind a proxy).",
			code: "invalid_signature",
		})
	},

	normalize(body) {
		const f = Object.fromEntries(new URLSearchParams(body))
		const id = f.MessageUUID
		if (!id) {
			throw new PostboiError({
				provider: "plivo",
				message: "plivo webhook payload has no MessageUUID",
				code: "invalid_payload",
				raw: f,
			})
		}
		// An inbound message carries its words and no Status.
		if (f.Status === undefined && "Text" in f) {
			return [
				inbound_event({
					provider: "plivo",
					channel: "sms",
					phone: plus_e164(f.From),
					text: f.Text,
					message_id: id,
					raw: f,
				}),
			]
		}
		const type = TYPES[f.Status?.toLowerCase() ?? ""]
		if (!type) return []
		// "000" is Plivo's code for no error.
		const code = f.ErrorCode && f.ErrorCode !== "000" ? f.ErrorCode : undefined
		const event: WebhookEvent = {
			type,
			provider: "plivo",
			channel: "sms",
			phone: plus_e164(f.To),
			message_id: id,
			bounce:
				type === "failed"
					? { category: code === FILTERED_CODE ? "filtered" : "unknown", detail: code }
					: undefined,
			raw: f,
		}
		return [event]
	},
}

export default adapter

/** Build a Plivo sample request, signed with `secret` as the auth token. */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const replies: Partial<Record<WebhookEventType, string>> = {
		unsubscribed: "STOP",
		resubscribed: "START",
		received: "Thanks, see you then",
	}
	const reply = replies[type]
	const status = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "delivered"
	const params: Record<string, string> =
		reply === undefined
			? {
					MessageUUID: "db3ce55a-7f1d-11e1-8ea7-1231380bc196",
					Status: status,
					To: "15557770006",
					From: "15551110001",
					...(status === "failed" ? { ErrorCode: "200" } : {}),
				}
			: {
					MessageUUID: "e5c9a6a2-7f1d-11e1-8ea7-1231380bc197",
					From: "15557770006",
					To: "15551110001",
					Text: reply,
					Type: "sms",
				}
	const nonce = "05429567804466091622"
	return {
		body: new URLSearchParams(params).toString(),
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-plivo-signature-v2-nonce": nonce,
			"x-plivo-signature-v2": await plivo_signature(secret, url, nonce),
		},
	}
}
