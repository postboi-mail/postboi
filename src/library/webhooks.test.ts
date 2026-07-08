import { describe, it, expect, vi } from "vitest"

import {
	receive,
	parse_user_agent,
	WebhookVerificationError,
	mock_event,
	mock_request,
} from "$library/webhooks/index.js"
import {
	svix_verify,
	timing_safe_equal,
	hmac_sha256,
	base64_encode,
	base64_decode,
	verify_ecdsa_p256_sha256,
	generate_svix_secret,
} from "$library/webhooks/crypto.js"

describe("webhook crypto", () => {
	it("timing_safe_equal compares correctly", () => {
		expect(timing_safe_equal("abc", "abc")).toBe(true)
		expect(timing_safe_equal("abc", "abd")).toBe(false)
		expect(timing_safe_equal("abc", "abcd")).toBe(false)
		expect(timing_safe_equal("", "")).toBe(true)
	})

	it("svix_verify accepts a valid signature and rejects tampering", async () => {
		const secret = generate_svix_secret()
		const body = JSON.stringify({ hello: "world" })
		const id = "msg_1"
		const timestamp = String(Math.floor(Date.now() / 1000))
		const key = base64_decode(secret.slice("whsec_".length))
		const signature = base64_encode(await hmac_sha256(key, `${id}.${timestamp}.${body}`))

		expect(await svix_verify({ secret, id, timestamp, body, signatures: `v1,${signature}` })).toBe(
			"ok"
		)
		// Other versions/garbage entries are skipped; any valid v1 wins.
		expect(
			await svix_verify({
				secret,
				id,
				timestamp,
				body,
				signatures: `v2,bogus v1,${signature}`,
			})
		).toBe("ok")
		expect(
			await svix_verify({
				secret,
				id,
				timestamp,
				body: body + "!",
				signatures: `v1,${signature}`,
			})
		).toBe("invalid_signature")
	})

	it("svix_verify rejects stale timestamps (replay protection)", async () => {
		const secret = generate_svix_secret()
		const body = "{}"
		const id = "msg_1"
		const timestamp = String(Math.floor(Date.now() / 1000) - 3600)
		const key = base64_decode(secret.slice("whsec_".length))
		const signature = base64_encode(await hmac_sha256(key, `${id}.${timestamp}.${body}`))
		expect(await svix_verify({ secret, id, timestamp, body, signatures: `v1,${signature}` })).toBe(
			"stale_timestamp"
		)
	})

	it("verify_ecdsa_p256_sha256 verifies a DER signature against an SPKI key", async () => {
		const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
			"sign",
			"verify",
		])
		const data = "1600000000payload"
		const raw = new Uint8Array(
			await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				pair.privateKey,
				new TextEncoder().encode(data)
			)
		)
		// WebCrypto emits raw r||s — wrap it in DER the way SendGrid sends it.
		const der = p1363_to_der(raw)
		const spki = base64_encode(
			new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
		)

		expect(
			await verify_ecdsa_p256_sha256({ public_key: spki, signature: base64_encode(der), data })
		).toBe(true)
		expect(
			await verify_ecdsa_p256_sha256({
				public_key: spki,
				signature: base64_encode(der),
				data: data + "!",
			})
		).toBe(false)
	})
})

/** Minimal P1363 (r||s) → DER conversion for the ECDSA test. */
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

describe("parse_user_agent", () => {
	it.each([
		[
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
			{ name: "Apple Mail", os: "iOS", device: "mobile" },
		],
		[
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
			{ name: "Apple Mail", os: "macOS", device: "desktop" },
		],
		[
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			{ name: "Chrome", os: "Windows", device: "desktop" },
		],
		[
			"Mozilla/5.0 (Windows NT 10.0; Microsoft Outlook 16.0.5)",
			{ name: "Outlook", os: "Windows", device: "desktop" },
		],
		["Outlook-iOS/2.0", { name: "Outlook", os: "iOS", device: "mobile" }],
		[
			"Mozilla/5.0 (X11; Linux x86_64) Thunderbird/115.0",
			{ name: "Thunderbird", os: "Linux", device: "desktop" },
		],
		// Google proxies pixel fetches — provider identifiable, device hidden.
		[
			"Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)",
			{ name: "Gmail", os: undefined, device: "unknown" },
		],
		[
			"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
			{ name: "Apple Mail", os: "iPadOS", device: "tablet" },
		],
	])("%s", (ua, expected) => {
		expect(parse_user_agent(ua)).toMatchObject({ ...expected, user_agent: ua })
	})

	it("returns undefined for empty input", () => {
		expect(parse_user_agent(undefined)).toBeUndefined()
		expect(parse_user_agent("")).toBeUndefined()
	})
})

describe("receive — resend", () => {
	it("verifies and normalizes an opened event end to end", async () => {
		const { request, secret } = await mock_request({ provider: "resend", type: "opened" })
		const events = await receive(request, { provider: "resend", secret })

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: "opened",
			provider: "resend",
			message_id: "mock-email-id",
			email: "recipient@example.com",
			subject: "Mock subject",
			ip: "192.0.2.1",
		})
		expect(events[0].client).toMatchObject({ name: "Apple Mail", os: "iOS", device: "mobile" })
		expect(events[0].timestamp).toBeInstanceOf(Date)
	})

	it("normalizes clicked with the link, bounced with a category", async () => {
		const clicked = await mock_request({ provider: "resend", type: "clicked" })
		const [click] = await receive(clicked.request, { provider: "resend", secret: clicked.secret })
		expect(click).toMatchObject({ type: "clicked", url: "https://example.com/pricing" })
		expect(click.client?.name).toBe("Chrome")

		const bounced = await mock_request({ provider: "resend", type: "bounced" })
		const [bounce] = await receive(bounced.request, { provider: "resend", secret: bounced.secret })
		expect(bounce).toMatchObject({
			type: "bounced",
			bounce: { category: "hard", detail: "mailbox unavailable" },
		})
	})

	it("rejects a wrong secret with a WebhookVerificationError", async () => {
		const { request } = await mock_request({ provider: "resend", type: "delivered" })
		const error = await receive(request, {
			provider: "resend",
			secret: generate_svix_secret(),
		}).catch((e) => e)
		expect(error).toBeInstanceOf(WebhookVerificationError)
		expect(error.code).toBe("invalid_signature")
	})

	it("fails closed when no secret is configured", async () => {
		const { request } = await mock_request({ provider: "resend", type: "delivered" })
		const error = await receive(request, { provider: "resend" }).catch((e) => e)
		expect(error).toBeInstanceOf(WebhookVerificationError)
		expect(error.code).toBe("missing_secret")
	})

	it("verify: false normalizes without a secret", async () => {
		const { request } = await mock_request({ provider: "resend", type: "delivered" })
		const events = await receive(request, { provider: "resend", verify: false })
		expect(events[0].type).toBe("delivered")
	})

	it("rejects stale timestamps", async () => {
		const secret = generate_svix_secret()
		const body = JSON.stringify({ type: "email.delivered", data: {} })
		const id = "msg_old"
		const timestamp = String(Math.floor(Date.now() / 1000) - 3600)
		const key = base64_decode(secret.slice("whsec_".length))
		const signature = base64_encode(await hmac_sha256(key, `${id}.${timestamp}.${body}`))
		const request = new Request("https://example.com/webhooks", {
			method: "POST",
			headers: {
				"svix-id": id,
				"svix-timestamp": timestamp,
				"svix-signature": `v1,${signature}`,
			},
			body,
		})
		const error = await receive(request, { provider: "resend", secret }).catch((e) => e)
		expect(error).toBeInstanceOf(WebhookVerificationError)
		expect(error.code).toBe("stale_timestamp")
	})

	it("skips non-delivery events (contact.*, domain.*)", async () => {
		const request = new Request("https://example.com/webhooks", {
			method: "POST",
			body: JSON.stringify({ type: "contact.created", data: {} }),
		})
		expect(await receive(request, { provider: "resend", verify: false })).toEqual([])
	})
})

describe("receive — postboi", () => {
	it("verifies the webhook-* Svix-compatible scheme end to end", async () => {
		const { request, secret } = await mock_request({ provider: "postboi", type: "opened" })
		const events = await receive(request, { provider: "postboi", secret })
		expect(events[0]).toMatchObject({
			type: "opened",
			provider: "postboi",
			message_id: "mock-message-id",
			email: "recipient@example.com",
		})
		expect(events[0].client?.name).toBe("Apple Mail")
	})

	it("normalizes bounce categories", async () => {
		const { request, secret } = await mock_request({ provider: "postboi", type: "bounced" })
		const [event] = await receive(request, { provider: "postboi", secret })
		expect(event.bounce).toEqual({ category: "hard", detail: "mailbox unavailable" })
	})
})

describe("receive — provider handling", () => {
	it("throws webhooks_not_supported for providers without events", async () => {
		const request = new Request("https://example.com/webhooks", { method: "POST", body: "{}" })
		const error = await receive(request, { provider: "smtp" as never }).catch((e) => e)
		expect(error).toMatchObject({ code: "webhooks_not_supported", provider: "smtp" })
	})

	it("accepts a custom adapter object", async () => {
		const request = new Request("https://example.com/webhooks", {
			method: "POST",
			body: JSON.stringify({ event: "opened", rcpt: "a@test.com" }),
		})
		const events = await receive(request, {
			verify: false,
			provider: {
				provider: "custom",
				verify() {},
				normalize(body) {
					const payload = JSON.parse(body) as { event: string; rcpt: string }
					return [{ type: "opened", provider: "custom", email: payload.rcpt, raw: payload }]
				},
			},
		})
		expect(events[0]).toMatchObject({ provider: "custom", email: "a@test.com" })
	})
})

describe("mock_event", () => {
	it("builds a normalized event with sensible defaults and overrides", () => {
		const event = mock_event("clicked", { email: "user@example.com" })
		expect(event).toMatchObject({
			type: "clicked",
			email: "user@example.com",
			url: "https://example.com/pricing",
		})
		expect(event.client?.name).toBe("Apple Mail")
	})
})

describe("receive — every provider round-trips through mock_request", () => {
	const cases: Array<[string, Array<"delivered" | "opened" | "clicked" | "bounced">]> = [
		["postboi", ["delivered", "opened", "clicked", "bounced"]],
		["resend", ["delivered", "opened", "clicked", "bounced"]],
		["sendgrid", ["delivered", "opened", "clicked", "bounced"]],
		["mailgun", ["delivered", "opened", "clicked", "bounced"]],
		["postmark", ["delivered", "opened", "clicked", "bounced"]],
		["brevo", ["delivered", "opened", "clicked", "bounced"]],
		["mailersend", ["delivered", "opened", "clicked", "bounced"]],
		// Mandrill has no delivered event — send/deferral/bounce/open/click only.
		["mandrill", ["opened", "clicked", "bounced"]],
		["sparkpost", ["delivered", "opened", "clicked", "bounced"]],
		["mailjet", ["delivered", "opened", "clicked", "bounced"]],
		["mailtrap", ["delivered", "opened", "clicked", "bounced"]],
		["zepto", ["delivered", "opened", "clicked", "bounced"]],
		["elasticemail", ["delivered", "opened", "clicked", "bounced"]],
		// Plunk's documented payload is minimal — no click URL surfaced.
		["plunk", ["delivered", "opened", "bounced"]],
		["ses", ["delivered", "opened", "clicked", "bounced"]],
		["scaleway", ["delivered", "bounced"]],
	]

	it.each(cases)("%s", async (provider, types) => {
		for (const type of types) {
			const { request, secret } = await mock_request({ provider, type })
			const events = await receive(request, { provider: provider as never, secret })
			expect(events.length, `${provider}/${type} events`).toBeGreaterThanOrEqual(1)
			const event = events[0]
			expect(event.type, `${provider}/${type} type`).toBe(type)
			expect(event.provider).toBe(provider)
			expect(event.email, `${provider}/${type} email`).toBe("recipient@example.com")
			expect(event.message_id, `${provider}/${type} message_id`).toBeTruthy()
			if (type === "clicked") {
				expect(event.url, `${provider} clicked url`).toBe("https://example.com/pricing")
			}
			if (type === "bounced") {
				expect(event.bounce?.category, `${provider} bounce category`).toBeTruthy()
			}
		}
	})

	// Zepto normalizes delivered/opened/clicked/bounced fine, but only if the adapter maps
	// them; the parameterized case above covers it. MailPace needs Ed25519 — feature-gated.
	it("mailpace (Ed25519, when the runtime supports it)", async (ctx) => {
		try {
			await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])
		} catch {
			ctx.skip()
			return
		}
		for (const type of ["delivered", "bounced"] as const) {
			const { request, secret } = await mock_request({ provider: "mailpace", type })
			const events = await receive(request, { provider: "mailpace", secret })
			expect(events[0]).toMatchObject({ type, provider: "mailpace" })
		}
	})

	it("signed providers reject a wrong secret", async () => {
		for (const provider of ["sendgrid", "mailgun", "mailersend", "mandrill", "mailtrap"]) {
			const { request } = await mock_request({ provider, type: "delivered" })
			const error = await receive(request, {
				provider: provider as never,
				secret: "wrong-secret",
			}).catch((e) => e)
			expect(error, `${provider} wrong secret`).toBeInstanceOf(WebhookVerificationError)
		}
	})

	it("shared-secret providers reject a wrong token", async () => {
		for (const provider of ["postmark", "brevo", "mailjet", "ses", "elasticemail"]) {
			const { request } = await mock_request({ provider, type: "delivered" })
			const error = await receive(request, {
				provider: provider as never,
				secret: "not-the-token",
			}).catch((e) => e)
			expect(error, `${provider} wrong token`).toBeInstanceOf(WebhookVerificationError)
			expect(error.code).toBe("invalid_signature")
		}
	})

	it("confirms SNS subscription handshakes and returns no events", async () => {
		const fetch_spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
		try {
			const secret = "sns-token"
			const request = new Request(`https://example.com/webhooks?token=${secret}`, {
				method: "POST",
				body: JSON.stringify({
					Type: "SubscriptionConfirmation",
					SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=x",
				}),
			})
			const events = await receive(request, { provider: "ses", secret })
			expect(events).toEqual([])
			expect(fetch_spy).toHaveBeenCalledWith(
				"https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=x"
			)
		} finally {
			fetch_spy.mockRestore()
		}
	})

	it("never confirms a subscribe URL outside amazonaws.com", async () => {
		const fetch_spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
		try {
			const secret = "sns-token"
			const request = new Request(`https://example.com/webhooks?token=${secret}`, {
				method: "POST",
				body: JSON.stringify({
					Type: "SubscriptionConfirmation",
					SubscribeURL: "https://evil.example.com/steal",
				}),
			})
			const events = await receive(request, { provider: "ses", secret })
			expect(events).toEqual([])
			expect(fetch_spy).not.toHaveBeenCalled()
		} finally {
			fetch_spy.mockRestore()
		}
	})
})
