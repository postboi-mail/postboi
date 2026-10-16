import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { reset_config } from "../config.js"
import { fails_over, type PostboiError } from "../errors.js"
import { from_base64url } from "../encoding.js"
import Telnyx from "./telnyx.js"
import Vonage from "./vonage.js"
import { sms } from "./send.js"

const respond = (status: number, json: unknown) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: new Headers(),
	text: async () => JSON.stringify(json),
})

function stub(status: number, json: unknown) {
	const fetch = vi.fn().mockResolvedValue(respond(status, json))
	vi.stubGlobal("fetch", fetch)
	return fetch
}

const sent = (fetch: ReturnType<typeof vi.fn>) => {
	const [url, init] = fetch.mock.calls[0]
	return { url: url as string, headers: init.headers, body: JSON.parse(init.body as string) }
}

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.NODE_ENV
})
afterEach(() => {
	for (const key of [
		"POSTBOI_SMS_PROVIDER",
		"TELNYX_API_KEY",
		"VONAGE_API_KEY",
		"VONAGE_API_SECRET",
		"VONAGE_APPLICATION_ID",
		"VONAGE_PRIVATE_KEY",
	])
		delete process.env[key]
})

describe("telnyx", () => {
	const telnyx = (options = {}) =>
		new Telnyx({ api_key: "KEY", default: { from: "+15550001111" }, ...options })

	it("posts JSON with a Bearer key and reads the message id", async () => {
		const fetch = stub(200, { data: { id: "msg-1", to: [{ status: "queued" }] } })
		const result = await telnyx({ messaging_profile_id: "prof-1" }).send({
			to: "+447700900123",
			message: "Your code is 4291",
		})
		expect(result).toEqual({
			id: "msg-1",
			ids: ["msg-1"],
			provider: "telnyx",
			delivery: "queued",
			status: "queued",
		})
		const { url, headers, body } = sent(fetch)
		expect(url).toBe("https://api.telnyx.com/v2/messages")
		expect(headers.Authorization).toBe("Bearer KEY")
		expect(body).toEqual({
			to: "+447700900123",
			from: "+15550001111",
			text: "Your code is 4291",
			messaging_profile_id: "prof-1",
		})
	})

	it("schedules with send_at", async () => {
		const fetch = stub(200, { data: { id: "msg-2", to: [{ status: "scheduled" }] } })
		const when = new Date("2030-01-01T09:00:00Z")
		await telnyx().send({ to: "+447700900123", message: "hi", scheduled_at: when })
		expect(sent(fetch).body.send_at).toBe(when.toISOString())
	})

	it("lets a messaging profile choose the sender", async () => {
		const fetch = stub(200, { data: { id: "m" } })
		await new Telnyx({ api_key: "K", messaging_profile_id: "p" }).send({
			to: "+447700900123",
			message: "hi",
		})
		expect(sent(fetch).body.from).toBeUndefined()
	})

	it("reads why from Telnyx's string codes", async () => {
		const cases: Array<[number, string, string]> = [
			[400, "40310", "recipient"],
			[400, "40300", "compliance"],
			[400, "40305", "sender"],
			[402, "20100", "account"],
			[429, "10011", "rate_limited"],
			[401, "10009", "auth"],
			[400, "10015", "request"],
		]
		for (const [status, code, reason] of cases) {
			stub(status, { errors: [{ code, title: "Refused", detail: "Because" }] })
			const error = (await telnyx()
				.send({ to: "+447700900123", message: "hi" })
				.catch((e) => e)) as PostboiError
			expect(error.reason, code).toBe(reason)
			expect(error).toMatchObject({ code, message: "Refused: Because" })
		}
	})

	it("refuses several recipients on one send", async () => {
		vi.stubGlobal("fetch", vi.fn())
		await expect(
			telnyx().send({ to: ["+447700900001", "+447700900002"], message: "hi" })
		).rejects.toMatchObject({ code: "single_recipient_only" })
	})

	it("is reachable from sms() with only its key", async () => {
		process.env.POSTBOI_SMS_PROVIDER = "telnyx"
		process.env.TELNYX_API_KEY = "env-key"
		const fetch = stub(200, { data: { id: "m" } })
		await sms({ to: "+447700900123", from: "+15550001111", message: "hi" })
		expect(sent(fetch).headers.Authorization).toBe("Bearer env-key")
	})
})

describe("vonage", () => {
	const vonage = (options = {}) =>
		new Vonage({ api_key: "k", api_secret: "s", default: { from: "ACME" }, ...options })

	it("posts the Messages API's SMS shape, numbers without their +", async () => {
		const fetch = stub(202, { message_uuid: "aaaaaaaa-bbbb" })
		const result = await vonage().send({ to: "+447700900123", message: "hi", tags: ["otp"] })
		expect(result).toEqual({
			message_uuid: "aaaaaaaa-bbbb",
			id: "aaaaaaaa-bbbb",
			ids: ["aaaaaaaa-bbbb"],
			provider: "vonage",
			delivery: "queued",
		})
		const { url, headers, body } = sent(fetch)
		expect(url).toBe("https://api.nexmo.com/v1/messages")
		expect(headers.Authorization).toBe(`Basic ${btoa("k:s")}`)
		expect(body).toEqual({
			message_type: "text",
			channel: "sms",
			to: "447700900123",
			from: "ACME",
			text: "hi",
			client_ref: "otp",
		})
	})

	it("uses the region's host", async () => {
		const fetch = stub(202, { message_uuid: "u" })
		await vonage({ region: "api-eu" }).send({ to: "+447700900123", message: "hi" })
		expect(sent(fetch).url).toBe("https://api-eu.nexmo.com/v1/messages")
	})

	it("signs an RS256 JWT for an application, and reuses it", async () => {
		const pair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"]
		)) as CryptoKeyPair
		const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
		const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`

		const fetch = vi.fn().mockImplementation(async () => respond(202, { message_uuid: "u" }))
		vi.stubGlobal("fetch", fetch)
		const provider = new Vonage({
			api_key: "k",
			application_id: "app-1",
			private_key: pem.replace(/\n/g, "\\n"),
			default: { from: "ACME" },
		})
		await provider.send({ to: "+447700900123", message: "hi" })
		await provider.send({ to: "+447700900123", message: "again" })

		const tokens = fetch.mock.calls.map(([, init]) => init.headers.Authorization as string)
		expect(tokens[0]).toBe(tokens[1])
		const [header, payload, signature] = tokens[0].replace(/^Bearer /, "").split(".")
		const verified = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			pair.publicKey,
			from_base64url(signature) as BufferSource,
			new TextEncoder().encode(`${header}.${payload}`)
		)
		expect(verified).toBe(true)
		const claims = JSON.parse(new TextDecoder().decode(from_base64url(payload)))
		expect(claims).toMatchObject({ application_id: "app-1" })
		expect(claims.exp - claims.iat).toBe(900)
	})

	it("reads why from the problem type's fragment", async () => {
		const cases: Array<[number, string, string]> = [
			[422, "https://developer.vonage.com/api-errors/messages#1420", "sender"],
			[422, "https://developer.vonage.com/api-errors/messages#1430", "recipient"],
			[422, "https://developer.vonage.com/api-errors/messages#1240", "compliance"],
			[422, "https://developer.vonage.com/api-errors/messages#1290", "recipient"],
			[429, "https://developer.vonage.com/api-errors#throttled", "rate_limited"],
			[402, "https://developer.vonage.com/api-errors/#low-balance", "account"],
			[401, "https://developer.vonage.com/api-errors#unauthorized", "auth"],
		]
		for (const [status, type, reason] of cases) {
			stub(status, { type, title: "Refused", detail: "Because" })
			const error = (await vonage()
				.send({ to: "+447700900123", message: "hi" })
				.catch((e) => e)) as PostboiError
			expect(error.reason, type).toBe(reason)
		}
	})

	it("refuses to schedule rather than sending now", async () => {
		vi.stubGlobal("fetch", vi.fn())
		await expect(
			vonage().send({ to: "+447700900123", message: "hi", scheduled_at: { days: 1 } })
		).rejects.toMatchObject({ code: "scheduling_not_supported" })
	})

	it("says what it needs beside the key", () => {
		expect(() => new Vonage({ api_key: "k" })).toThrow(/VONAGE_API_SECRET/)
	})

	it("fails over from a throttle and not from a bad number", async () => {
		stub(429, { type: "https://developer.vonage.com/api-errors#throttled", title: "Throttled" })
		expect(
			fails_over(
				await vonage()
					.send({ to: "+447700900123", message: "hi" })
					.catch((e) => e)
			)
		).toBe(true)
		stub(422, { type: "https://developer.vonage.com/api-errors/messages#1170", title: "Invalid" })
		expect(
			fails_over(
				await vonage()
					.send({ to: "+447700900123", message: "hi" })
					.catch((e) => e)
			)
		).toBe(false)
	})

	it("is reachable from sms() with a key and secret", async () => {
		process.env.POSTBOI_SMS_PROVIDER = "vonage"
		process.env.VONAGE_API_KEY = "ek"
		process.env.VONAGE_API_SECRET = "es"
		// An application, where one is set, outranks the key and secret (a linked number
		// needs it), so this test says there is none rather than trusting the machine.
		process.env.VONAGE_APPLICATION_ID = ""
		process.env.VONAGE_PRIVATE_KEY = ""
		const fetch = stub(202, { message_uuid: "u" })
		await sms({ to: "+447700900123", from: "ACME", message: "hi" })
		expect(sent(fetch).headers.Authorization).toBe(`Basic ${btoa("ek:es")}`)
	})
})
