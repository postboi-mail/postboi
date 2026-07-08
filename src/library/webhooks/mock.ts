/**
 * Test helpers for webhook handlers — synthesize events without a provider or a tunnel.
 *
 * - {@link mock_event} makes a normalized {@link WebhookEvent} to feed your handler
 *   function directly.
 * - {@link mock_request} builds a realistic **signed** HTTP request for a provider, so you
 *   can exercise the whole path — signature verification included — end to end.
 */
import { PostboiError } from "../index.js"
import { MODULES, type WebhookEvent, type WebhookEventType } from "./index.js"
import { parse_user_agent } from "./ua.js"
import { generate_svix_secret, generate_token } from "./crypto.js"

/** Providers whose mock requests are signed with the Svix `whsec_…` scheme. */
const SVIX_PROVIDERS = new Set(["resend", "postboi"])

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
	const sample = await mod.mock({ type, secret, url })

	return {
		request: new Request(sample.url ?? url, {
			method: "POST",
			headers: sample.headers ?? { "content-type": "application/json" },
			body: sample.body,
		}),
		secret,
	}
}
