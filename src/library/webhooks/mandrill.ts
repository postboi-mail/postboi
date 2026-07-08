import type {
	WebhookAdapter,
	WebhookEvent,
	WebhookEventType,
	BounceDetail,
	AdapterModule,
} from "./index.js"
import { PostboiError } from "../index.js"
import { WebhookVerificationError } from "./errors.js"
import { engagement, to_date } from "./shared.js"
import { hmac_sha1, base64_encode, timing_safe_equal } from "./crypto.js"
import { read_env } from "../env.js"

/**
 * Mandrill webhook events — form-encoded, a JSON array under `mandrill_events`.
 * https://mailchimp.com/developer/transactional/guides/track-respond-activity-webhooks/
 */
interface MandrillEvent {
	event?: string
	ts?: number
	_id?: string
	url?: string
	ip?: string
	user_agent?: string
	msg?: {
		_id?: string
		email?: string
		subject?: string
		tags?: Array<string>
		bounce_description?: string
		diag?: string
	}
}

const TYPES: Record<string, WebhookEventType> = {
	send: "sent",
	deferral: "delayed",
	hard_bounce: "bounced",
	soft_bounce: "bounced",
	open: "opened",
	click: "clicked",
	spam: "complained",
	unsub: "unsubscribed",
	reject: "failed",
}

function parse_events(provider: string, body: string): Array<MandrillEvent> {
	const params = new URLSearchParams(body)
	const raw = params.get("mandrill_events")
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw) as unknown
		return Array.isArray(parsed) ? (parsed as Array<MandrillEvent>) : []
	} catch {
		throw new PostboiError({
			provider,
			message: "mandrill_events is not valid JSON",
			code: "invalid_payload",
			raw: body,
		})
	}
}

/**
 * Mandrill webhook adapter. Verification is HMAC-SHA1 (base64) over the webhook URL
 * followed by the sorted POST params, in the `X-Mandrill-Signature` header. Mandrill
 * signs the URL *it* was configured with — behind a proxy or rewrite, set
 * `MANDRILL_WEBHOOK_URL` to that exact URL.
 */
const adapter: WebhookAdapter = {
	provider: "mandrill",

	async verify(ctx) {
		if (!ctx.secret) {
			throw new WebhookVerificationError({
				provider: "mandrill",
				message:
					"No webhook key configured for mandrill. Set MANDRILL_WEBHOOK_SECRET (the webhook's key from the Mandrill dashboard) or pass { secret }.",
				code: "missing_secret",
			})
		}
		const signature = ctx.headers.get("x-mandrill-signature")
		if (!signature) {
			throw new WebhookVerificationError({
				provider: "mandrill",
				message: "mandrill webhook is missing its X-Mandrill-Signature header",
				code: "invalid_signature",
			})
		}

		// Signed data: the exact configured webhook URL + each sorted POST param key+value.
		const url = read_env("MANDRILL_WEBHOOK_URL") ?? ctx.url.href
		const params = new URLSearchParams(ctx.body)
		let signed = url
		for (const key of [...params.keys()].sort()) signed += key + (params.get(key) ?? "")
		const expected = base64_encode(await hmac_sha1(ctx.secret, signed))

		if (!timing_safe_equal(signature, expected)) {
			throw new WebhookVerificationError({
				provider: "mandrill",
				message:
					"mandrill webhook signature did not match. Mandrill signs the exact URL it was configured with — behind a proxy, set MANDRILL_WEBHOOK_URL.",
				code: "invalid_signature",
			})
		}
	},

	normalize(body) {
		const events: Array<WebhookEvent> = []
		for (const item of parse_events("mandrill", body)) {
			const type = item.event ? TYPES[item.event] : undefined
			if (!type) continue
			const bounce: BounceDetail | undefined =
				type === "bounced"
					? {
							category: item.event === "hard_bounce" ? "hard" : "soft",
							detail: item.msg?.bounce_description ?? item.msg?.diag,
						}
					: undefined
			events.push({
				type,
				provider: "mandrill",
				message_id: item.msg?._id ?? item._id,
				email: item.msg?.email,
				timestamp: to_date(item.ts),
				subject: item.msg?.subject,
				tags: item.msg?.tags,
				url: item.url,
				bounce,
				...engagement(item.user_agent, item.ip),
				raw: item,
			})
		}
		return events
	},
}

export default adapter

/** Build a realistic signed Mandrill sample request (form-encoded, URL-signed). */
export const mock: AdapterModule["mock"] = async ({ type, secret, url }) => {
	const mandrill_type = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "send"
	const event: MandrillEvent = {
		event: mandrill_type,
		ts: Math.floor(Date.now() / 1000),
		_id: "mock-message-id",
		msg: {
			_id: "mock-message-id",
			email: "recipient@example.com",
			subject: "Mock subject",
			tags: ["welcome"],
		},
	}
	if (type === "opened" || type === "clicked") {
		event.ip = "192.0.2.1"
		event.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
	}
	if (type === "clicked") event.url = "https://example.com/pricing"
	if (type === "bounced") event.msg!.bounce_description = "mailbox unavailable"

	const params = new URLSearchParams({ mandrill_events: JSON.stringify([event]) })
	const body = params.toString()

	let signed = url
	for (const key of [...params.keys()].sort()) signed += key + (params.get(key) ?? "")
	const signature = base64_encode(await hmac_sha1(secret, signed))

	return {
		body,
		headers: {
			"x-mandrill-signature": signature,
			"content-type": "application/x-www-form-urlencoded",
		},
	}
}
