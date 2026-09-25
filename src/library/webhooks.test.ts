import { describe, it, expect, vi } from "vitest"

import {
	receive,
	parse_user_agent,
	WebhookVerificationError,
	mock_event,
	mock_request,
	handshake,
} from "$library/webhooks/index.js"
import {
	svix_verify,
	timing_safe_equal,
	hmac_sha256,
	hex_encode,
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
		// "No secret" has to mean it, on any machine — an inherited RESEND_WEBHOOK_SECRET
		// turns this into a test that verification succeeds.
		delete process.env.RESEND_WEBHOOK_SECRET
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

	it("carries a submission's form and fields through", async () => {
		const request = new Request("https://example.com/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "email.delivered",
				data: {
					message_id: "msg_1",
					to: "housing@acme.com",
					form: { id: "form_1", name: "Home Ownership Query" },
					fields: [
						["name", "Ada"],
						["interest", "web"],
						["interest", "print"],
						// a malformed entry is dropped rather than handed over as a pair
						"stray",
						["half"],
					],
				},
			}),
		})
		const [event] = await receive(request, { provider: "postboi", verify: false })
		expect(event.form).toEqual({ id: "form_1", name: "Home Ownership Query" })
		expect(event.fields).toEqual([
			["name", "Ada"],
			["interest", "web"],
			["interest", "print"],
		])
		// and stays absent on a send that wasn't a submission
		const plain = new Request("https://example.com/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "email.delivered", data: { message_id: "msg_2" } }),
		})
		const [other] = await receive(plain, { provider: "postboi", verify: false })
		expect(other.form).toBeUndefined()
		expect(other.fields).toBeUndefined()
	})

	it("normalizes bounce categories", async () => {
		const { request, secret } = await mock_request({ provider: "postboi", type: "bounced" })
		const [event] = await receive(request, { provider: "postboi", secret })
		expect(event.bounce).toEqual({ category: "hard", detail: "mailbox unavailable" })
	})

	it("turns inbound mail around: the sender is the address, the answered send the id", async () => {
		const { request, secret } = await mock_request({ provider: "postboi", type: "received" })
		const [event] = await receive(request, { provider: "postboi", secret })
		expect(event).toMatchObject({
			type: "received",
			// Not the recipient — on inbound that would be your own sending address.
			email: "someone@example.com",
			message_id: "mock-message-id",
		})
		expect(event.body?.text).toBe("Thanks, that works for me.")
	})

	it("accepts a space/comma-separated secret list — any candidate verifies", async () => {
		const { request, secret } = await mock_request({ provider: "postboi", type: "opened" })
		// The real secret buried among decoys, both separators in play — rotation and
		// multiple endpoints on one handler both land here.
		const list = `${generate_svix_secret()} ${secret},${generate_svix_secret()}`
		const events = await receive(request, { provider: "postboi", secret: list })
		expect(events[0].type).toBe("opened")
	})

	it("carries an SMS event on the shared vocabulary, with the number in phone", async () => {
		const { request, secret } = await mock_request({
			provider: "postboi",
			type: "delivered",
			channel: "sms",
		})
		const [event] = await receive(request, { provider: "postboi", secret })
		expect(event).toMatchObject({
			type: "delivered",
			channel: "sms",
			phone: "+15557770006",
		})
		// A handler reading `email` must never be handed a phone number.
		expect(event.email).toBeUndefined()
	})

	it("reads WhatsApp's read receipt as the open it is", async () => {
		const { request, secret } = await mock_request({
			provider: "postboi",
			type: "opened",
			channel: "whatsapp",
		})
		// The wire type is channel-scoped: without that, "opened" would map back to
		// whichever of email.opened / whatsapp.read the table happened to list first.
		expect(JSON.parse(await request.clone().text()).type).toBe("whatsapp.read")

		const [event] = await receive(request, { provider: "postboi", secret })
		expect(event).toMatchObject({ type: "opened", channel: "whatsapp", phone: "+15557770006" })
	})

	it("leaves channel unset on email, so absent keeps meaning email", async () => {
		const { request, secret } = await mock_request({ provider: "postboi", type: "delivered" })
		const [event] = await receive(request, { provider: "postboi", secret })
		expect(event.channel).toBeUndefined()
		expect(event.phone).toBeUndefined()
		expect(event.email).toBe("recipient@example.com")
	})

	it("rejects when none of the listed secrets match", async () => {
		const { request } = await mock_request({ provider: "postboi", type: "opened" })
		const list = `${generate_svix_secret()} ${generate_svix_secret()}`
		const error = await receive(request, { provider: "postboi", secret: list }).catch((e) => e)
		expect(error).toBeInstanceOf(WebhookVerificationError)
		expect(error.code).toBe("invalid_signature")
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

describe("receive — lettermint", () => {
	it("rejects a stale signature timestamp (replay protection)", async () => {
		const { request, secret } = await mock_request({ provider: "lettermint", type: "delivered" })
		const body = await request.text()
		const stale = String(Math.floor(Date.now() / 1000) - 3600)
		const key = new TextEncoder().encode(secret)
		const imported = await crypto.subtle.importKey(
			"raw",
			key,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"]
		)
		const digest = new Uint8Array(
			await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(`${stale}.${body}`))
		)
		const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("")
		const replay = new Request("https://example.com/webhooks", {
			method: "POST",
			headers: { "x-lettermint-signature": `t=${stale},v1=${hex}` },
			body,
		})
		const error = await receive(replay, { provider: "lettermint", secret }).catch((e) => e)
		expect(error).toBeInstanceOf(WebhookVerificationError)
		expect(error.code).toBe("stale_timestamp")
	})

	it("rejects when the delivery header disagrees with the signed timestamp", async () => {
		const { request, secret } = await mock_request({ provider: "lettermint", type: "delivered" })
		const headers = new Headers(request.headers)
		headers.set("x-lettermint-delivery", "1")
		const forged = new Request(request.url, { method: "POST", headers, body: await request.text() })
		const error = await receive(forged, { provider: "lettermint", secret }).catch((e) => e)
		expect(error).toBeInstanceOf(WebhookVerificationError)
		expect(error.code).toBe("invalid_signature")
	})

	it("classifies bounces and folds the reserved tag entry into one tag", async () => {
		const { request, secret } = await mock_request({ provider: "lettermint", type: "bounced" })
		const [event] = await receive(request, { provider: "lettermint", secret })
		expect(event.bounce).toEqual({ category: "hard", detail: "mailbox unavailable" })
		expect(event.tags).toEqual(["welcome"])

		const soft = JSON.stringify({
			event: "message.soft_bounced",
			timestamp: new Date().toISOString(),
			data: { message_id: "m", recipient: "r@example.com", response: { content: "try later" } },
		})
		const suppressed = JSON.stringify({
			event: "message.suppressed",
			timestamp: new Date().toISOString(),
			data: { message_id: "m", recipient: "r@example.com", reason: "hard_bounce" },
		})
		const { default: adapter } = await import("./webhooks/lettermint.js")
		const ctx = { headers: new Headers(), url: new URL("https://example.com/webhooks") }
		expect((await adapter.normalize(soft, ctx))[0].bounce).toEqual({
			category: "soft",
			detail: "try later",
		})
		expect((await adapter.normalize(suppressed, ctx))[0].bounce).toEqual({
			category: "suppressed",
			detail: "hard_bounce",
		})
	})

	it("turns inbound mail into received, with the sender as the address", async () => {
		const { request, secret } = await mock_request({ provider: "lettermint", type: "received" })
		const [event] = await receive(request, { provider: "lettermint", secret })
		expect(event.type).toBe("received")
		expect(event.email).toBe("someone@example.com")
		expect(event.body?.text).toContain("works for me")
	})

	it("ignores non-delivery events (created, suppression.*, webhook.test)", async () => {
		const { default: adapter } = await import("./webhooks/lettermint.js")
		const ctx = { headers: new Headers(), url: new URL("https://example.com/webhooks") }
		for (const event of ["message.created", "suppression.added", "webhook.test"]) {
			expect(await adapter.normalize(JSON.stringify({ event, data: {} }), ctx)).toEqual([])
		}
	})
})

describe("receive — unosend", () => {
	it("classifies bounces and reads the first recipient of an array", async () => {
		const { default: adapter } = await import("./webhooks/unosend.js")
		const ctx = { headers: new Headers(), url: new URL("https://example.com/webhooks") }
		const soft = JSON.stringify({
			type: "email.bounced",
			created_at: new Date().toISOString(),
			data: {
				email_id: "eml_1",
				to: ["first@example.com", "second@example.com"],
				bounce_type: "soft",
				bounce_reason: "Mailbox full",
			},
		})
		const [event] = await adapter.normalize(soft, ctx)
		expect(event.email).toBe("first@example.com")
		expect(event.bounce).toEqual({ category: "soft", detail: "Mailbox full" })
	})

	it("verifies whichever reading of the whsec_ secret the vendor signs with", async () => {
		const { default: adapter } = await import("./webhooks/unosend.js")
		const { hmac_sha256, hex_encode, base64_encode } = await import("./webhooks/crypto.js")
		const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e" } })
		const raw = new Uint8Array(24).fill(7)
		const secret = `whsec_${base64_encode(raw)}`
		const keys: Array<Uint8Array | string> = [secret, secret.slice(6), raw]
		for (const key of keys) {
			const signature = hex_encode(await hmac_sha256(key, body))
			await expect(
				adapter.verify({
					body,
					headers: new Headers({ "x-unosend-signature": `sha256=${signature}` }),
					url: new URL("https://example.com/webhooks"),
					secret,
				})
			).resolves.toBeUndefined()
		}
		const wrong = hex_encode(await hmac_sha256("something-else", body))
		await expect(
			adapter.verify({
				body,
				headers: new Headers({ "x-unosend-signature": `sha256=${wrong}` }),
				url: new URL("https://example.com/webhooks"),
				secret,
			})
		).rejects.toBeInstanceOf(WebhookVerificationError)
	})

	it("accepts the signature with or without its sha256= prefix", async () => {
		const { request, secret } = await mock_request({ provider: "unosend", type: "opened" })
		const body = await request.text()
		const bare = request.headers.get("x-unosend-signature")!.replace(/^sha256=/, "")
		const unprefixed = new Request(request.url, {
			method: "POST",
			headers: { "x-unosend-signature": bare },
			body,
		})
		const [event] = await receive(unprefixed, { provider: "unosend", secret })
		expect(event.client?.name).toBeTruthy()
		expect(event.ip).toBe("192.0.2.1")
	})
})

describe("receive — sequenzy", () => {
	const ctx = { headers: new Headers(), url: new URL("https://example.com/webhooks") }

	it("rejects a stale timestamp (replay protection)", async () => {
		const { request, secret } = await mock_request({ provider: "sequenzy", type: "delivered" })
		const body = await request.text()
		const { hmac_sha256, hex_encode } = await import("./webhooks/crypto.js")
		const stale = String(Math.floor(Date.now() / 1000) - 3600)
		const hex = hex_encode(await hmac_sha256(secret, `v1:${stale}:${body}`))
		const replay = new Request(request.url, {
			method: "POST",
			headers: { "x-sequenzy-timestamp": stale, "x-sequenzy-signature": `v1=${hex}` },
			body,
		})
		const error = await receive(replay, { provider: "sequenzy", secret }).catch((e) => e)
		expect(error).toBeInstanceOf(WebhookVerificationError)
		expect(error.code).toBe("stale_timestamp")
	})

	it("accepts any v1= value in the header, and any configured secret, during a rotation", async () => {
		const { request, secret } = await mock_request({ provider: "sequenzy", type: "delivered" })
		const body = await request.text()
		const timestamp = request.headers.get("x-sequenzy-timestamp")!
		const { hmac_sha256, hex_encode } = await import("./webhooks/crypto.js")
		const good = hex_encode(await hmac_sha256(secret, `v1:${timestamp}:${body}`))
		const other = hex_encode(await hmac_sha256("retired-secret", `v1:${timestamp}:${body}`))
		const rotated = new Request(request.url, {
			method: "POST",
			headers: {
				"x-sequenzy-timestamp": timestamp,
				"x-sequenzy-signature": `v1=${other},v1=${good}`,
			},
			body,
		})
		const [event] = await receive(rotated, { provider: "sequenzy", secret: `old-one, ${secret}` })
		expect(event.type).toBe("delivered")
		expect(event.message_id).toBe("send_mock")
	})

	it("verifies whichever reading of the whsec_ secret the vendor signs with", async () => {
		const { default: adapter } = await import("./webhooks/sequenzy.js")
		const { hmac_sha256, hex_encode, base64_encode } = await import("./webhooks/crypto.js")
		const body = JSON.stringify({ type: "email.delivered", data: { email_send_id: "s" } })
		const timestamp = String(Math.floor(Date.now() / 1000))
		const raw = new Uint8Array(24).fill(7)
		const secret = `whsec_${base64_encode(raw)}`
		const keys: Array<Uint8Array | string> = [secret, secret.slice(6), raw]
		for (const key of keys) {
			const digest = await hmac_sha256(key, `v1:${timestamp}:${body}`)
			for (const signature of [hex_encode(digest), base64_encode(digest)]) {
				await expect(
					adapter.verify({
						body,
						headers: new Headers({
							"x-sequenzy-timestamp": timestamp,
							"x-sequenzy-signature": `v1=${signature}`,
						}),
						url: ctx.url,
						secret,
					})
				).resolves.toBeUndefined()
			}
		}
		const wrong = hex_encode(await hmac_sha256("something-else", `v1:${timestamp}:${body}`))
		await expect(
			adapter.verify({
				body,
				headers: new Headers({
					"x-sequenzy-timestamp": timestamp,
					"x-sequenzy-signature": `v1=${wrong}`,
				}),
				url: ctx.url,
				secret,
			})
		).rejects.toBeInstanceOf(WebhookVerificationError)
	})

	it("keys events on the send id, reads engagement, and classifies bounces", async () => {
		const { request, secret } = await mock_request({ provider: "sequenzy", type: "clicked" })
		const [clicked] = await receive(request, { provider: "sequenzy", secret })
		expect(clicked.message_id).toBe("send_mock")
		expect(clicked.url).toBe("https://example.com/pricing")
		expect(clicked.ip).toBe("192.0.2.1")
		expect(clicked.client?.name).toBeTruthy()

		const { default: adapter } = await import("./webhooks/sequenzy.js")
		const bounced = JSON.stringify({
			type: "email.bounced",
			created_at: new Date().toISOString(),
			data: { email_send_id: "send_1", message_id: "upstream", recipient: "r@example.com" },
		})
		// Unlabelled is hard: Sequenzy only calls it a bounce once the mailbox was judged bad.
		expect((await adapter.normalize(bounced, ctx))[0].bounce).toEqual({ category: "hard" })
		const soft = JSON.stringify({
			type: "email.bounced",
			data: { email_send_id: "send_1", bounce_type: "soft", reason: "Mailbox full" },
		})
		expect((await adapter.normalize(soft, ctx))[0].bounce).toEqual({
			category: "soft",
			detail: "Mailbox full",
		})
	})

	it("maps delays and exhausted deliveries, and ignores everything that isn't mail", async () => {
		const { default: adapter } = await import("./webhooks/sequenzy.js")
		const one = async (type: string, data: Record<string, unknown> = {}) =>
			adapter.normalize(JSON.stringify({ type, data }), ctx)
		expect((await one("email.delivery_delayed"))[0].type).toBe("delayed")
		expect((await one("email.failed", { failure: { code: "admin_bounce" } }))[0].type).toBe(
			"failed"
		)
		expect((await one("email.unsubscribed"))[0].type).toBe("unsubscribed")
		for (const type of ["campaign.sent", "sms.delivered", "subscriber.updated", "poll.answered"]) {
			expect(await one(type), type).toEqual([])
		}
	})

	it("turns a tracked reply into received, with the sender as the address", async () => {
		const { request, secret } = await mock_request({ provider: "sequenzy", type: "received" })
		const [event] = await receive(request, { provider: "sequenzy", secret })
		expect(event.type).toBe("received")
		expect(event.email).toBe("someone@example.com")
		expect(event.message_id).toBe("send_mock")
		expect(event.body?.text).toContain("works for me")
		expect(event.body?.html).toContain("<p>")
	})
})

describe("receive — the new roster", () => {
	const ctx = { headers: new Headers(), url: new URL("https://example.com/webhooks") }

	it("loops: verifies standard-webhooks signatures and maps bounce kinds", async () => {
		const { request, secret } = await mock_request({ provider: "loops", type: "bounced" })
		expect(secret.startsWith("whsec_")).toBe(true)
		const [event] = await receive(request, { provider: "loops", secret })
		expect(event.bounce).toEqual({ category: "hard", detail: "User unknown" })
		const { default: adapter } = await import("./webhooks/loops.js")
		const soft = JSON.stringify({
			eventName: "email.softBounced",
			eventTime: 1734425918,
			email: { id: "e1", subject: "S" },
			contactIdentity: { email: "a@example.com" },
		})
		expect((await adapter.normalize(soft, ctx))[0]).toMatchObject({
			type: "bounced",
			message_id: "e1",
			email: "a@example.com",
			bounce: { category: "soft" },
		})
		const sent = JSON.stringify({
			eventName: "campaign.email.sent",
			email: {},
			contactIdentity: {},
		})
		expect((await adapter.normalize(sent, ctx))[0].type).toBe("sent")
		const contact = JSON.stringify({ eventName: "contact.created", contactIdentity: {} })
		expect(await adapter.normalize(contact, ctx)).toEqual([])
	})

	it("smtp2go: reads form-encoded deliveries too, and classifies bounces", async () => {
		const { default: adapter } = await import("./webhooks/smtp2go.js")
		const form = new URLSearchParams({
			event: "bounce",
			email_id: "e1",
			rcpt: "a@example.com",
			bounce: "soft",
			message: "452 mailbox full",
		}).toString()
		expect((await adapter.normalize(form, ctx))[0]).toMatchObject({
			type: "bounced",
			message_id: "e1",
			email: "a@example.com",
			bounce: { category: "soft", detail: "452 mailbox full" },
		})
		const sms = JSON.stringify({ event: "sms_delivered", email_id: "x" })
		expect(await adapter.normalize(sms, ctx)).toEqual([])
		const reject = JSON.stringify({ event: "reject", email_id: "e2", rcpt: "b@example.com" })
		expect((await adapter.normalize(reject, ctx))[0].type).toBe("failed")
	})

	it("socketlabs: checks the secret key in the body and answers the validation handshake", async () => {
		const { request, secret } = await mock_request({ provider: "socketlabs", type: "clicked" })
		const [event] = await receive(request, { provider: "socketlabs", secret })
		expect(event.url).toBe("https://example.com/pricing")
		expect(event.client?.name).toBeTruthy()

		const { default: adapter } = await import("./webhooks/socketlabs.js")
		const unsubscribe = JSON.stringify({
			Type: "Tracking",
			TrackingType: 2,
			Address: "a@example.com",
		})
		expect((await adapter.normalize(unsubscribe, ctx))[0].type).toBe("unsubscribed")
		const failed = JSON.stringify({
			Type: "Failed",
			Address: "a@example.com",
			FailureType: "Temporary",
			Reason: "421 try later",
		})
		expect((await adapter.normalize(failed, ctx))[0].bounce).toEqual({
			category: "soft",
			detail: "421 try later",
		})

		const { webhook } = await import("./webhooks/handler.js")
		const validation = new Request("https://example.com/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ Type: "Validation", ValidationKey: "vk_123", SecretKey: secret }),
		})
		const seen: Array<unknown> = []
		const response = await webhook((event) => void seen.push(event), {
			provider: "socketlabs",
			secret,
		})(validation)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ValidationKey: "vk_123" })
		expect(seen).toEqual([])
	})

	it("azure: completes the Event Grid handshake and maps engagement reports", async () => {
		const fetch_spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
		try {
			const { default: adapter } = await import("./webhooks/azure.js")
			const handshake = JSON.stringify([
				{
					eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
					data: {
						validationCode: "code",
						validationUrl:
							"https://rp-westus.eventgrid.azure.net:553/eventsubscriptions/x/validate?id=1",
					},
				},
			])
			expect(await adapter.normalize(handshake, ctx)).toEqual([])
			expect(fetch_spy).toHaveBeenCalledWith(
				"https://rp-westus.eventgrid.azure.net:553/eventsubscriptions/x/validate?id=1"
			)
			// A forged handshake pointing anywhere else is ignored, not visited.
			const forged = JSON.stringify([
				{
					eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
					data: { validationUrl: "https://evil.example.com/steal" },
				},
			])
			expect(await adapter.normalize(forged, ctx)).toEqual([])
			expect(fetch_spy).toHaveBeenCalledTimes(1)
		} finally {
			fetch_spy.mockRestore()
		}

		const { request, secret } = await mock_request({ provider: "azure", type: "clicked" })
		const [clicked] = await receive(request, { provider: "azure", secret })
		expect(clicked).toMatchObject({
			type: "clicked",
			message_id: "8540c0de-899f-5cce-acb5-3ec493af3800",
			url: "https://example.com/pricing",
		})
		expect(clicked.client?.name).toBeTruthy()

		const { default: adapter } = await import("./webhooks/azure.js")
		const suppressed = JSON.stringify([
			{
				eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
				data: { recipient: "a@example.com", messageId: "m", status: "Suppressed" },
			},
			{
				eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
				data: { recipient: "a@example.com", messageId: "m", status: "Expanded" },
			},
		])
		const events = await adapter.normalize(suppressed, ctx)
		expect(events).toHaveLength(1)
		expect(events[0].bounce?.category).toBe("suppressed")
	})

	it("postal: keys on the Message-ID header and reads bounces from the original message", async () => {
		const { request, secret } = await mock_request({ provider: "postal", type: "bounced" })
		const [event] = await receive(request, { provider: "postal", secret })
		expect(event.message_id).toBe("6f4e8d4e-mock@rp.postal.example.com")
		expect(event.tags).toEqual(["welcome"])
		expect(event.bounce?.detail).toContain("Undeliverable")
		const { default: adapter } = await import("./webhooks/postal.js")
		const dns = JSON.stringify({ event: "DomainDNSError", payload: { domain: "x" } })
		expect(await adapter.normalize(dns, ctx)).toEqual([])
		const held = JSON.stringify({
			event: "MessageHeld",
			timestamp: 1700000000,
			payload: { message: { message_id: "m", to: "a@example.com" }, status: "Held" },
		})
		expect((await adapter.normalize(held, ctx))[0].type).toBe("failed")
	})

	it("customerio: rejects a stale timestamp and ignores other channels", async () => {
		const { request, secret } = await mock_request({ provider: "customerio", type: "delivered" })
		const body = await request.text()
		const { hmac_sha256, hex_encode } = await import("./webhooks/crypto.js")
		const stale = String(Math.floor(Date.now() / 1000) - 3600)
		const replay = new Request(request.url, {
			method: "POST",
			headers: {
				"x-cio-timestamp": stale,
				"x-cio-signature": hex_encode(await hmac_sha256(secret, `v0:${stale}:${body}`)),
			},
			body,
		})
		const error = await receive(replay, { provider: "customerio", secret }).catch((e) => e)
		expect(error).toBeInstanceOf(WebhookVerificationError)
		expect(error.code).toBe("stale_timestamp")

		const { default: adapter } = await import("./webhooks/customerio.js")
		const push = JSON.stringify({ object_type: "push", metric: "delivered", data: {} })
		expect(await adapter.normalize(push, ctx)).toEqual([])
		const undeliverable = JSON.stringify({
			object_type: "email",
			metric: "undeliverable",
			data: { delivery_id: "d", identifiers: { email: "a@example.com" }, reason: "suppressed" },
		})
		expect((await adapter.normalize(undeliverable, ctx))[0]).toMatchObject({
			type: "bounced",
			email: "a@example.com",
			bounce: { category: "suppressed", detail: "suppressed" },
		})
	})

	it("ahasend: signs with the literal secret, and accepts the conventional readings too", async () => {
		const { default: adapter } = await import("./webhooks/ahasend.js")
		const { hmac_sha256, base64_encode } = await import("./webhooks/crypto.js")
		const body = JSON.stringify({ type: "message.delivered", data: { recipient: "a@example.com" } })
		const timestamp = String(Math.floor(Date.now() / 1000))
		const raw = new Uint8Array(24).fill(9)
		const secret = `whsec_${base64_encode(raw)}`
		for (const key of [secret, secret.slice(6), raw] as Array<string | Uint8Array>) {
			const signature = base64_encode(await hmac_sha256(key, `id.${timestamp}.${body}`))
			await expect(
				adapter.verify({
					body,
					headers: new Headers({
						"webhook-id": "id",
						"webhook-timestamp": timestamp,
						"webhook-signature": `v1,${signature}`,
					}),
					url: ctx.url,
					secret,
				})
			).resolves.toBeUndefined()
		}
		const suppressed = JSON.stringify({
			type: "message.suppressed",
			data: { recipient: "a@example.com", message_id_header: "m", reason: "on suppression list" },
		})
		expect((await adapter.normalize(suppressed, ctx))[0].bounce).toEqual({
			category: "suppressed",
			detail: "on suppression list",
		})
		const deferred = JSON.stringify({ type: "message.transient_error", data: {} })
		expect((await adapter.normalize(deferred, ctx))[0].type).toBe("delayed")
		const domain = JSON.stringify({ type: "domain.dns_error", data: {} })
		expect(await adapter.normalize(domain, ctx)).toEqual([])
	})

	it("infobip: reads one report per result and keeps the permanent flag", async () => {
		const { request, secret } = await mock_request({ provider: "infobip", type: "bounced" })
		const [event] = await receive(request, { provider: "infobip", secret })
		expect(event.bounce).toEqual({ category: "hard", detail: "Unknown Subscriber" })
		const { default: adapter } = await import("./webhooks/infobip.js")
		const mixed = JSON.stringify({
			results: [
				{ messageId: "1", to: "a@example.com", status: { groupName: "DELIVERED" } },
				{ messageId: "2", to: "b@example.com", status: { groupName: "EXPIRED" } },
				{ messageId: "3", to: "+447700900000", channel: "SMS", status: { groupName: "DELIVERED" } },
			],
		})
		const events = await adapter.normalize(mixed, ctx)
		expect(events.map((e) => e.type)).toEqual(["delivered", "failed"])
	})

	it("sendpulse: reads a batch, and the bounce events that name the address differently", async () => {
		const { default: adapter } = await import("./webhooks/sendpulse.js")
		const batch = JSON.stringify([
			{
				event: "delivered",
				timestamp: 1490953933,
				message_id: 1149317311,
				recipient: "a@example.com",
			},
			{
				event: "hard_bounces",
				timestamp: 1658998170,
				task_id: 17076325,
				email: "b@example.com",
				smtp_server_response_code: 550,
				smtp_server_response_subcode: "5.1.1",
				smtp_server_response: "Recipient address rejected",
			},
			{ event: "resubscribed", recipient: "c@example.com" },
		])
		const events = await adapter.normalize(batch, ctx)
		expect(events).toHaveLength(2)
		expect(events[0]).toMatchObject({
			type: "delivered",
			message_id: "1149317311",
			email: "a@example.com",
		})
		expect(events[1]).toMatchObject({
			type: "bounced",
			email: "b@example.com",
			bounce: { category: "hard", detail: "550 5.1.1 Recipient address rejected" },
		})
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
		["lettermint", ["delivered", "opened", "clicked", "bounced"]],
		["unosend", ["delivered", "opened", "clicked", "bounced"]],
		["sequenzy", ["delivered", "opened", "clicked", "bounced"]],
		["loops", ["delivered", "opened", "clicked", "bounced"]],
		["smtp2go", ["delivered", "opened", "clicked", "bounced"]],
		["socketlabs", ["delivered", "opened", "clicked", "bounced"]],
		// Event Grid's engagement reports name the message and sender, never the recipient.
		["azure", ["delivered", "bounced"]],
		["postal", ["delivered", "opened", "clicked", "bounced"]],
		["customerio", ["delivered", "opened", "clicked", "bounced"]],
		["ahasend", ["delivered", "opened", "clicked", "bounced"]],
		// Infobip's delivery reports carry no engagement.
		["infobip", ["delivered", "bounced"]],
		["sendpulse", ["delivered", "opened", "clicked", "bounced"]],
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
		for (const provider of [
			"sendgrid",
			"mailgun",
			"mailersend",
			"mandrill",
			"mailtrap",
			"lettermint",
			"unosend",
			"sequenzy",
			"loops",
			"customerio",
			"ahasend",
			"socketlabs",
		]) {
			const { request } = await mock_request({ provider, type: "delivered" })
			const error = await receive(request, {
				provider: provider as never,
				secret: "wrong-secret",
			}).catch((e) => e)
			expect(error, `${provider} wrong secret`).toBeInstanceOf(WebhookVerificationError)
		}
	})

	it("shared-secret providers reject a wrong token", async () => {
		for (const provider of [
			"postmark",
			"brevo",
			"mailjet",
			"ses",
			"elasticemail",
			"smtp2go",
			"azure",
			"postal",
			"infobip",
			"sendpulse",
			"smsworks",
		]) {
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

describe("receive — smsworks (SMS delivery reports and replies)", () => {
	// Twilio's receipts are polled; The SMS Works pushes them, so this is the first
	// webhook adapter whose events are about a number rather than an address.
	it("a delivery report is a delivered event about a phone number, never an email", async () => {
		const { request, secret } = await mock_request({ provider: "smsworks", type: "delivered" })
		const [event] = await receive(request, { provider: "smsworks", secret })
		expect(event).toMatchObject({
			type: "delivered",
			provider: "smsworks",
			channel: "sms",
			phone: "+447700900123",
			message_id: "d87e93c0-fa08-4903-becd-aeb5b0ab3b6a",
			tags: ["otp"],
		})
		expect(event.email).toBeUndefined()
		expect(event.timestamp).toBeInstanceOf(Date)
	})

	it("maps the statuses: SENT, the three failures, and never SCHEDULED", async () => {
		const secret = "smsworks-token"
		const url = `https://example.com/webhooks?token=${secret}`
		const post = (payload: Record<string, unknown>) =>
			receive(new Request(url, { method: "POST", body: JSON.stringify(payload) }), {
				provider: "smsworks",
				secret,
			})
		const base = { messageid: "m1", destination: "447700900123", modified: "2026-08-07T10:00:00Z" }

		expect((await post({ ...base, status: "SENT" }))[0].type).toBe("sent")
		for (const status of ["UNDELIVERABLE", "REJECTED", "EXPIRED"]) {
			expect((await post({ ...base, status }))[0].type, status).toBe("failed")
		}
		// The provider still holding the message is not something that happened to it.
		expect(await post({ ...base, status: "SCHEDULED" })).toEqual([])
		// Lower-case, just in case a payload ever arrives that way.
		expect((await post({ ...base, status: "delivered" }))[0].type).toBe("delivered")
		// A healthy report can carry an empty failure object; that is not a retry.
		const healthy = {
			...base,
			status: "SENT",
			failurereason: { code: 0, details: "", permanent: false },
		}
		expect((await post(healthy))[0]).toMatchObject({ type: "sent", bounce: undefined })
	})

	it("takes a list of reports, and refuses a body that is no report at all", async () => {
		const secret = "smsworks-token"
		const url = `https://example.com/webhooks?token=${secret}`
		const post = (body: string) =>
			receive(new Request(url, { method: "POST", body }), { provider: "smsworks", secret })
		const events = await post(
			JSON.stringify([
				{ messageid: "a", status: "DELIVERED", destination: 447700900123 },
				{ messageid: "b", status: "SCHEDULED", destination: 447700900124 },
				{ messageid: "c", status: "EXPIRED", destination: 447700900125 },
			])
		)
		expect(events.map((event) => [event.message_id, event.type])).toEqual([
			["a", "delivered"],
			["c", "failed"],
		])
		const error = await post("null").catch((e) => e)
		expect(error).toMatchObject({ code: "invalid_payload", provider: "smsworks" })
	})

	it("leaves phone unset for a destination that isn't a number, rather than inventing one", async () => {
		const secret = "smsworks-token"
		const request = new Request(`https://example.com/webhooks?token=${secret}`, {
			method: "POST",
			body: JSON.stringify({ messageid: "m1", status: "DELIVERED", destination: "4477" }),
		})
		const [event] = await receive(request, { provider: "smsworks", secret })
		expect(event.type).toBe("delivered")
		expect(event.phone).toBeUndefined()
	})

	it("classifies a failure by the permanent flag, with the carrier's code in the detail", async () => {
		const { request, secret } = await mock_request({ provider: "smsworks", type: "failed" })
		const [event] = await receive(request, { provider: "smsworks", secret })
		expect(event.type).toBe("failed")
		expect(event.bounce?.category).toBe("hard")
		expect(event.bounce?.detail).toBe(
			"5001 Handset Error: Number does not exist or has not been assigned to a user."
		)
	})

	it("a SENT carrying a temporary failure is delayed — the carrier is still trying", async () => {
		const { request, secret } = await mock_request({ provider: "smsworks", type: "delayed" })
		const [event] = await receive(request, { provider: "smsworks", secret })
		expect(event.type).toBe("delayed")
		expect(event.bounce?.category).toBe("soft")
		expect(event.bounce?.detail).toContain("3001")
	})

	it("reads an inbound reply for an opt-out and nothing else", async () => {
		const { request, secret } = await mock_request({ provider: "smsworks", type: "unsubscribed" })
		const [event] = await receive(request, { provider: "smsworks", secret })
		// The number is the sender's — they are the one opting out.
		expect(event).toMatchObject({
			type: "unsubscribed",
			channel: "sms",
			phone: "+447700900123",
			message_id: "328827210622192878142",
		})

		const url = `https://example.com/webhooks?token=${secret}`
		const reply = new Request(url, {
			method: "POST",
			body: JSON.stringify({
				messagetype: "incoming",
				messageid: "in-2",
				content: "Thanks, see you at 3",
				from: "447700900123",
			}),
		})
		expect(await receive(reply, { provider: "smsworks", secret })).toEqual([])
	})

	it("is the default when no email provider is configured but the SMS one pushes", async () => {
		const saved = { ...process.env }
		delete process.env.POSTBOI_PROVIDER
		delete process.env.POSTBOI_TOKEN
		delete process.env.POSTBOI_WHATSAPP_PROVIDER
		process.env.POSTBOI_SMS_PROVIDER = "smsworks"
		try {
			const { request, secret } = await mock_request({ provider: "smsworks", type: "delivered" })
			const [event] = await receive(request, { secret })
			expect(event).toMatchObject({ provider: "smsworks", type: "delivered", channel: "sms" })
			// Twilio polls, so naming it is not naming a webhook provider.
			process.env.POSTBOI_SMS_PROVIDER = "twilio"
			const again = await mock_request({ provider: "smsworks", type: "delivered", secret })
			const error = await receive(again.request, { secret }).catch((e) => e)
			expect(error).toMatchObject({ code: "no_provider" })
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
			Object.assign(process.env, saved)
		}
	})

	it("accepts the token as a basic-auth password, the option their reply webhooks offer", async () => {
		const secret = "smsworks-token"
		const request = new Request("https://example.com/webhooks", {
			method: "POST",
			headers: { authorization: `Basic ${btoa(`postboi:${secret}`)}` },
			body: JSON.stringify({ messageid: "m1", status: "DELIVERED", destination: 447700900123 }),
		})
		const events = await receive(request, { provider: "smsworks", secret })
		expect(events[0]).toMatchObject({ type: "delivered", phone: "+447700900123" })
	})
})

describe("receive — meta (WhatsApp Cloud API)", () => {
	/** Sign a payload the way Meta does: sha256=<hex HMAC of the raw body, app secret>. */
	async function signed(payload: unknown, secret: string): Promise<Request> {
		const body = JSON.stringify(payload)
		const hex = hex_encode(await hmac_sha256(secret, body))
		return new Request("https://example.com/webhooks/whatsapp", {
			method: "POST",
			headers: { "x-hub-signature-256": `sha256=${hex}` },
			body,
		})
	}

	function envelope(
		value: Record<string, unknown>,
		field = "messages",
		object = "whatsapp_business_account"
	) {
		return {
			object,
			entry: [{ id: "200000000000002", changes: [{ field, value }] }],
		}
	}

	it("verifies X-Hub-Signature-256 and normalizes a receipt end to end", async () => {
		const { request, secret } = await mock_request({ provider: "meta", type: "delivered" })
		expect(request.headers.get("x-hub-signature-256")).toMatch(/^sha256=[0-9a-f]{64}$/)

		const events = await receive(request, { provider: "meta", secret })
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: "delivered",
			provider: "meta",
			channel: "whatsapp",
			phone: "+15557770006",
			message_id: "wamid.mock",
		})
		expect(events[0].timestamp).toBeInstanceOf(Date)
		// A handler reading `email` must never be handed a phone number.
		expect(events[0].email).toBeUndefined()
	})

	it("reads the read receipt as the open it is, and a failure with Meta's words", async () => {
		const read = await mock_request({ provider: "meta", type: "opened" })
		const [opened] = await receive(read.request, { provider: "meta", secret: read.secret })
		expect(opened).toMatchObject({ type: "opened", channel: "whatsapp", phone: "+15557770006" })

		const failed = await mock_request({ provider: "meta", type: "failed" })
		const [failure] = await receive(failed.request, { provider: "meta", secret: failed.secret })
		expect(failure.type).toBe("failed")
		// No bounce classification for a text message — the code and the reason are the detail.
		expect(failure.bounce?.category).toBe("unknown")
		expect(failure.bounce?.detail).toMatch(/^131047 Message failed to send/)
	})

	it("turns a texted STOP into an unsubscribe for the number that sent it", async () => {
		const { request, secret } = await mock_request({ provider: "meta", type: "unsubscribed" })
		const [event] = await receive(request, { provider: "meta", secret })
		expect(event).toMatchObject({
			type: "unsubscribed",
			channel: "whatsapp",
			phone: "+15557770006",
			message_id: "wamid.mock-inbound",
		})
		expect(event.body).toBeUndefined()
	})

	it("carries anything else a person writes as received, about the send they answered", async () => {
		const { request, secret } = await mock_request({ provider: "meta", type: "received" })
		const [event] = await receive(request, { provider: "meta", secret })
		expect(event).toMatchObject({
			type: "received",
			channel: "whatsapp",
			phone: "+15557770006",
			// The reply's context names your message; that is the id worth carrying.
			message_id: "wamid.mock",
			body: { text: "Thanks, that works for me." },
		})
	})

	it("emits one event per status and per message in a batched delivery", async () => {
		const secret = "app-secret"
		const request = await signed(
			envelope({
				messaging_product: "whatsapp",
				metadata: { display_phone_number: "15551110001", phone_number_id: "1" },
				statuses: [
					{ id: "a", status: "sent", timestamp: "1756720000", recipient_id: "15557770006" },
					{ id: "b", status: "delivered", timestamp: "1756720001", recipient_id: "15557770006" },
					{ id: "c", status: "read", timestamp: "1756720002", recipient_id: "15557770006" },
					{
						id: "d",
						status: "failed",
						timestamp: "1756720003",
						recipient_id: "15557770007",
						errors: [{ code: 131026, title: "Message undeliverable" }],
					},
					// Not things that happened to the send, in the vocabulary's terms.
					{ id: "e", status: "deleted", timestamp: "1756720004", recipient_id: "15557770006" },
					{ id: "f", status: "warning", timestamp: "1756720005", recipient_id: "15557770006" },
				],
				messages: [
					{
						from: "15557770006",
						id: "g",
						timestamp: "1756720006",
						type: "text",
						text: { body: "hi" },
					},
					// A reply that didn't use WhatsApp's reply carries its own id.
					{
						from: "15557770008",
						id: "h",
						timestamp: "1756720007",
						type: "image",
						image: { id: "m" },
					},
					{ from: "15557770006", id: "i", timestamp: "1756720008", type: "reaction", reaction: {} },
					{
						from: "15557770006",
						id: "j",
						timestamp: "1756720009",
						type: "text",
						text: { body: "stop." },
					},
					{
						from: "15557770006",
						id: "k",
						timestamp: "1756720010",
						type: "button",
						button: { text: "Unsubscribe", payload: "Unsubscribe" },
					},
					// An interactive button or list row they tapped is words too.
					{
						from: "15557770006",
						id: "l",
						timestamp: "1756720011",
						type: "interactive",
						interactive: { type: "button_reply", button_reply: { id: "opt-out", title: "Stop" } },
					},
					{
						from: "15557770006",
						id: "m",
						timestamp: "1756720012",
						type: "interactive",
						interactive: { type: "list_reply", list_reply: { id: "size-l", title: "Large" } },
					},
					// Quoting their own earlier message is not a reply to a send of yours.
					{
						from: "15557770006",
						id: "n",
						timestamp: "1756720013",
						type: "text",
						text: { body: "still waiting" },
						context: { from: "15557770006", id: "g" },
					},
					{
						from: "15557770006",
						id: "o",
						timestamp: "1756720014",
						type: "text",
						text: { body: "yes please" },
						context: { from: "15551110001", id: "wamid.sent" },
					},
				],
			}),
			secret
		)
		const events = await receive(request, { provider: "meta", secret })
		expect(events.map((event) => [event.message_id, event.type])).toEqual([
			["a", "sent"],
			["b", "delivered"],
			["c", "opened"],
			["d", "failed"],
			["g", "received"],
			["h", "received"],
			["j", "unsubscribed"],
			["k", "unsubscribed"],
			["l", "unsubscribed"],
			["m", "received"],
			["n", "received"],
			["wamid.sent", "received"],
		])
		expect(events[9]).toMatchObject({ body: { text: "Large" } })
		expect(events[3].bounce).toEqual({
			category: "unknown",
			detail: "131026 Message undeliverable",
		})
		expect(events[3].phone).toBe("+15557770007")
		expect(events[3].timestamp?.toISOString()).toBe("2025-09-01T09:46:43.000Z")
		// A picture is a message from a person, with nothing to quote.
		expect(events[5]).toMatchObject({ phone: "+15557770008", body: undefined })
		for (const event of events) expect(event.channel).toBe("whatsapp")
	})

	it("ignores other Meta products and other fields on the account", async () => {
		const secret = "app-secret"
		const other_product = await signed(
			envelope({ statuses: [{ id: "a", status: "sent" }] }, "messages", "page"),
			secret
		)
		expect(await receive(other_product, { provider: "meta", secret })).toEqual([])

		const template_review = await signed(
			envelope({ event: "APPROVED", message_template_id: 1 }, "message_template_status_update"),
			secret
		)
		expect(await receive(template_review, { provider: "meta", secret })).toEqual([])
	})

	it("rejects a wrong app secret, a missing signature, and no secret at all", async () => {
		const { request } = await mock_request({ provider: "meta", type: "delivered" })
		const wrong = await receive(request.clone(), { provider: "meta", secret: "not-it" }).catch(
			(e) => e
		)
		expect(wrong).toBeInstanceOf(WebhookVerificationError)
		expect(wrong.code).toBe("invalid_signature")

		const unsigned = new Request(request.url, {
			method: "POST",
			body: await request.clone().text(),
		})
		const missing = await receive(unsigned, { provider: "meta", secret: "app-secret" }).catch(
			(e) => e
		)
		expect(missing).toBeInstanceOf(WebhookVerificationError)
		expect(missing.code).toBe("invalid_signature")

		delete process.env.META_WEBHOOK_SECRET
		const none = await receive(request, { provider: "meta" }).catch((e) => e)
		expect(none).toBeInstanceOf(WebhookVerificationError)
		expect(none.code).toBe("missing_secret")
	})

	it("reads the verify token from META_WEBHOOK_VERIFY_TOKEN when none is passed", async () => {
		process.env.META_WEBHOOK_VERIFY_TOKEN = "from-env"
		try {
			const url =
				"https://example.com/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=from-env&hub.challenge=42"
			expect(await handshake(new Request(url), { provider: "meta" })).toBe("42")
		} finally {
			delete process.env.META_WEBHOOK_VERIFY_TOKEN
		}
	})

	it("is the default when no email provider is configured but the WhatsApp one pushes", async () => {
		const saved = { ...process.env }
		delete process.env.POSTBOI_PROVIDER
		delete process.env.POSTBOI_TOKEN
		process.env.POSTBOI_WHATSAPP_PROVIDER = "meta"
		try {
			const { request, secret } = await mock_request({ provider: "meta", type: "opened" })
			const [event] = await receive(request, { secret })
			expect(event).toMatchObject({ provider: "meta", type: "opened", channel: "whatsapp" })
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
			Object.assign(process.env, saved)
		}
	})

	it("mock_event knows a text-message event is about a number", () => {
		const event = mock_event("received", { channel: "whatsapp" })
		expect(event).toMatchObject({ channel: "whatsapp", phone: "+15557770006" })
		expect(event.email).toBeUndefined()
		expect(event.subject).toBeUndefined()
		expect(event.body?.text).toBeDefined()
	})
})

describe("receive — review fixes", () => {
	const ctx = { headers: new Headers(), url: new URL("https://example.com/webhooks") }

	it("smtp2go: zone-less timestamps are read as UTC, whatever the host's zone", async () => {
		const { default: adapter } = await import("./webhooks/smtp2go.js")
		const [event] = await adapter.normalize(
			JSON.stringify({
				event: "delivered",
				email_id: "e",
				rcpt: "a@example.com",
				time: "2030-01-01 10:00:00",
			}),
			ctx
		)
		expect(event.timestamp?.toISOString()).toBe("2030-01-01T10:00:00.000Z")
	})

	it("azure: the handler answers the validation code, and sovereign-cloud validation URLs are visited", async () => {
		const fetch_spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
		try {
			const { webhook } = await import("./webhooks/handler.js")
			const handshake = new Request("https://example.com/webhooks?token=s", {
				method: "POST",
				headers: { "content-type": "application/json", "aeg-event-type": "SubscriptionValidation" },
				body: JSON.stringify([
					{
						eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
						data: {
							validationCode: "code-123",
							validationUrl: "https://rp-usgovvirginia.eventgrid.azure.us:553/validate?id=1",
						},
					},
				]),
			})
			const response = await webhook(() => {}, { provider: "azure", secret: "s" })(handshake)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ validationResponse: "code-123" })
			expect(fetch_spy).toHaveBeenCalledWith(
				"https://rp-usgovvirginia.eventgrid.azure.us:553/validate?id=1"
			)
		} finally {
			fetch_spy.mockRestore()
		}
	})

	it("a whsec_ secret that isn't base64 is reported as a misconfiguration, not a forgery", async () => {
		const { request } = await mock_request({ provider: "loops", type: "delivered" })
		const error = await receive(request, { provider: "loops", secret: "whsec_***" }).catch((e) => e)
		expect(error).toBeInstanceOf(WebhookVerificationError)
		expect(error.code).toBe("missing_secret")
		expect(error.message).toContain("LOOPS_WEBHOOK_SECRET")
	})

	it("the handler answers a body that was already read with a 400, not a crash", async () => {
		const { webhook } = await import("./webhooks/handler.js")
		const { request, secret } = await mock_request({ provider: "postmark", type: "delivered" })
		await request.text()
		const response = await webhook(() => {}, { provider: "postmark", secret })(request)
		expect(response.status).toBe(400)
	})
})
