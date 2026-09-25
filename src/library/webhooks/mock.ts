/**
 * Test helpers for webhook handlers — synthesize events without a provider or a tunnel.
 *
 * - {@link mock_event} makes a normalized {@link WebhookEvent} to feed your handler
 *   function directly.
 * - {@link mock_request} builds a realistic **signed** HTTP request for a provider, so you
 *   can exercise the whole path — signature verification included — end to end.
 */
import { PostboiError } from "../index.js"
import type { Channel } from "../errors.js"
import { MODULES, type WebhookEvent, type WebhookEventType } from "./index.js"
import { POLL_MODULES, type PollResult } from "./poll.js"
import { parse_user_agent } from "./ua.js"
import { generate_svix_secret, generate_token } from "./crypto.js"

/** Providers whose mock requests are signed with the Svix `whsec_…` scheme. */
const SVIX_PROVIDERS = new Set(["resend", "postboi", "loops"])

/**
 * A synthetic normalized event — the fastest way to unit-test handler logic.
 *
 * @example
 * ```ts
 * const event = mock_event("opened", { email: "user@example.com" })
 * await my_handler(event)
 * ```
 */
export function mock_event(
	type: WebhookEventType,
	overrides: Partial<WebhookEvent> = {}
): WebhookEvent {
	const base: WebhookEvent = {
		type,
		provider: "mock",
		message_id: "mock-message-id",
		email: "recipient@example.com",
		timestamp: new Date(),
		subject: "Mock subject",
		raw: { mock: true, type },
	}
	if (type === "opened" || type === "clicked") {
		base.client = parse_user_agent(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
		)
		base.ip = "192.0.2.1"
	}
	if (type === "clicked") base.url = "https://example.com/pricing"
	if (type === "bounced") base.bounce = { category: "hard", detail: "mailbox unavailable" }
	if (type === "received") {
		// Inbound: `email` is whoever wrote to you, and the body is the point of it.
		base.email = "someone@example.com"
		base.body = { text: "Thanks, that works for me." }
	}
	if (overrides.channel === "sms" || overrides.channel === "whatsapp") {
		// A text-message event is about a number: never an address, and no subject line.
		base.email = undefined
		base.subject = undefined
		base.phone = "+15557770006"
	}
	return { ...base, ...overrides }
}

/**
 * A realistic **signed** webhook request for a provider, plus the secret that verifies
 * it — drive `receive()` (or the `postboi/kit` handler) exactly like the real thing.
 *
 * The secret is generated per call (pass `secret` to reuse one). For providers that
 * sign with a key you can't fabricate locally, the returned secret is whatever the
 * scheme needs to verify the mock.
 *
 * @example
 * ```ts
 * const { request, secret } = await mock_request({ provider: "resend", type: "opened" })
 * const events = await receive(request, { provider: "resend", secret })
 * expect(events[0].client?.name).toBe("Apple Mail")
 * ```
 */
export async function mock_request(
	options: {
		/** Which provider's payload/signature shape to fake. Defaults to "postboi". */
		provider?: string
		/** The event type the payload describes. Defaults to "delivered". */
		type?: WebhookEventType
		/** Reuse a known secret instead of generating one. */
		secret?: string
		/** The endpoint URL the request targets. */
		url?: string
		/**
		 * Which channel the payload is about, for providers that carry more than email
		 * (the Postboi provider). Defaults to email.
		 */
		channel?: Channel
	} = {}
): Promise<{ request: Request; secret: string }> {
	const provider = options.provider ?? "postboi"
	const type = options.type ?? "delivered"
	const load = MODULES[provider]
	const mod = load ? await load() : undefined
	if (!mod?.mock) {
		throw new PostboiError({
			provider,
			code: "webhooks_not_supported",
			message: `No mock webhook builder for provider "${provider}".`,
		})
	}

	const secret =
		options.secret ?? (SVIX_PROVIDERS.has(provider) ? generate_svix_secret() : generate_token())
	const url = options.url ?? "https://example.com/webhooks"
	const sample = await mod.mock({ type, secret, url, channel: options.channel })

	return {
		request: new Request(sample.url ?? url, {
			method: "POST",
			headers: sample.headers ?? { "content-type": "application/json" },
			body: sample.body,
		}),
		// Asymmetric schemes generate their own keypair and hand back the public key.
		secret: sample.secret ?? secret,
	}
}

/**
 * A realistic {@link PollResult} for a polling provider — the analog of `mock_request`
 * for providers that report delivery by `poll()` instead of pushing webhooks. Each
 * fixture is run through the adapter's own normalization, so it can't drift from the
 * real mapping.
 *
 * @example
 * ```ts
 * const { events } = await mock_poll({ provider: "smtp", type: "bounced" })
 * expect(events[0].bounce?.category).toBe("hard")
 * ```
 */
export async function mock_poll(
	options: {
		/** Which provider's poll result to fake. Defaults to "smtp". */
		provider?: string
		/** The event type the result describes. Defaults to "delivered". */
		type?: WebhookEventType
		/**
		 * Which channel the result is about, for providers that report on more than one
		 * (Twilio). Defaults to the provider's own — email everywhere but Twilio, where
		 * it is SMS.
		 */
		channel?: Channel
	} = {}
): Promise<PollResult> {
	const provider = options.provider ?? "smtp"
	const load = POLL_MODULES[provider]
	const mod = load ? await load() : undefined
	if (!mod?.mock) {
		throw new PostboiError({
			provider,
			code: "polling_not_supported",
			message: `No mock poll builder for provider "${provider}".`,
		})
	}
	return mod.mock({ type: options.type ?? "delivered", channel: options.channel })
}
