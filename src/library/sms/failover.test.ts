import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { configure, reset_config } from "../config.js"
import { FailoverError, PostboiError, fails_over } from "../errors.js"
import { provider_keys, scoped_options } from "../registry.js"
import { sms } from "./send.js"
import { push } from "../push/send.js"
import Twilio from "./twilio.js"
import Sns from "./sns.js"
import PureSms from "./puresms.js"

const respond = (status: number, json: unknown) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: new Headers(),
	text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
})

const TWILIO = "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json"
const PURESMS = "https://connect-api.divergent.cloud/sms/send"

/** A fetch answering Twilio and PureSMS from their own queues, recording where it went. */
function route(twilio: Array<unknown>, puresms: Array<unknown>) {
	const fetch = vi.fn(async (url: string) => {
		const answer = url.startsWith(TWILIO) ? twilio.shift() : puresms.shift()
		if (!answer) throw new Error(`unexpected request to ${url}`)
		return answer
	})
	vi.stubGlobal("fetch", fetch)
	return { urls: () => fetch.mock.calls.map(([url]) => url) }
}

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.NODE_ENV
	process.env.POSTBOI_SMS_PROVIDER = "twilio,puresms"
	process.env.POSTBOI_SMS_FROM = "+15551110001"
	process.env.TWILIO_ACCOUNT_SID = "AC1"
	process.env.TWILIO_AUTH_TOKEN = "tok"
	process.env.PURESMS_API_KEY = "pk"
})
afterEach(() => {
	reset_config()
	for (const key of [
		"POSTBOI_SMS_PROVIDER",
		"POSTBOI_SMS_FROM",
		"TWILIO_ACCOUNT_SID",
		"TWILIO_AUTH_TOKEN",
		"PURESMS_API_KEY",
		"POSTBOI_PUSH_PROVIDER",
	])
		delete process.env[key]
})

describe("why a provider refused", () => {
	const twilio = () =>
		new Twilio({ account_sid: "AC1", auth_token: "t", default: { from: "+1555" } })
	const send = (provider: { send(o: object): Promise<unknown> }) =>
		provider.send({ to: "+447700900123", message: "hi" }).catch((e: PostboiError) => e)

	it("reads Twilio's codes, and falls back to the status for the rest", async () => {
		const cases: Array<[number, unknown, string | undefined]> = [
			[400, { code: 21212, message: "Invalid From" }, "sender"],
			[400, { code: 21211, message: "Invalid To" }, "recipient"],
			[400, { code: 21610, message: "Unsubscribed" }, "compliance"],
			[400, { code: 21608, message: "Trial account" }, "account"],
			[429, { code: 20429, message: "Too many requests" }, "rate_limited"],
			[401, { code: 20003, message: "Authenticate" }, "auth"],
			[400, { code: 21602, message: "Body required" }, "request"],
			[401, "", "auth"],
		]
		for (const [status, body, reason] of cases) {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(status, body)))
			const error = await send(twilio())
			expect(error.reason, JSON.stringify(body)).toBe(reason)
			expect(error.outcome_unknown).toBe(false)
		}
	})

	it("gives a 5xx no reason, because nothing was refused", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(503, { message: "down" })))
		const error = await send(twilio())
		expect(error.reason).toBeUndefined()
		expect(error.outcome_unknown).toBe(true)
		expect(fails_over(error)).toBe(false)
	})

	it("reads AWS throttling, which arrives as a 400", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					respond(400, "<Error><Code>Throttling</Code><Message>Rate exceeded</Message></Error>")
				)
		)
		const sns = new Sns({ access_key_id: "a", secret_access_key: "s", region: "eu-west-2" })
		expect((await send(sns)).reason).toBe("rate_limited")
	})

	it("reads Meta's codes, which arrive as 400s, and Twilio's WhatsApp ones", async () => {
		const Meta = (await import("../whatsapp/meta.js")).default
		const TwilioWhatsapp = (await import("../whatsapp/twilio.js")).default
		const meta = new Meta({ access_token: "t", phone_number_id: "1" })
		const wa = new TwilioWhatsapp({
			account_sid: "AC1",
			auth_token: "t",
			default: { from: "+1555" },
		})
		const text = { to: "+447700900123", message: "hi" }
		const cases: Array<[{ send(o: object): Promise<unknown> }, unknown, string]> = [
			[meta, { error: { code: 130429, message: "Throughput reached" } }, "rate_limited"],
			[meta, { error: { code: 131042, message: "Payment issue" } }, "account"],
			[meta, { error: { code: 190, message: "Token expired" } }, "auth"],
			[meta, { error: { code: 131026, message: "Undeliverable" } }, "recipient"],
			[wa, { code: 63007, message: "No WhatsApp channel for From" }, "sender"],
			[wa, { code: 63018, message: "Rate limit exceeded" }, "rate_limited"],
		]
		for (const [provider, body, reason] of cases) {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(400, body)))
			const error = (await provider.send(text).catch((e) => e)) as PostboiError
			expect(error.reason, JSON.stringify(body)).toBe(reason)
		}
	})

	it("says a partly accepted batch may have gone, and never fails it over", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					respond(207, { batchId: "b1", messageCount: 1, errors: [{ recipient: "+447700900002" }] })
				)
		)
		const puresms = new PureSms({ api_key: "k", default: { from: "POSTBOI" } })
		const error = (await puresms
			.send({ to: ["+447700900001", "+447700900002"], message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error).toMatchObject({ code: "partial_batch", outcome_unknown: true })
		expect(error.reason).toBeUndefined()
		expect(fails_over(error)).toBe(false)
	})

	it("calls a 402 an account problem", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(402, { title: "Out of credit" })))
		const puresms = new PureSms({ api_key: "k", default: { from: "POSTBOI" } })
		expect((await send(puresms)).reason).toBe("account")
	})

	it("fails over only on the reasons that are about the provider", () => {
		const error = (reason: string, outcome_unknown = false) =>
			new PostboiError({ provider: "x", message: "m", reason: reason as never, outcome_unknown })
		for (const reason of ["auth", "rate_limited", "sender", "account"])
			expect(fails_over(error(reason)), reason).toBe(true)
		for (const reason of ["recipient", "compliance", "request"])
			expect(fails_over(error(reason)), reason).toBe(false)
		expect(fails_over(error("auth", true))).toBe(false)
		expect(fails_over(new Error("plain"))).toBe(false)
	})
})

describe("a provider chain", () => {
	it("moves on when the first refuses for a reason that is about it", async () => {
		const sent = route(
			[respond(400, { code: 21606, message: "From is not SMS-capable" })],
			[respond(200, { id: "357551956102758401" })]
		)
		const result = await sms({ to: "+447700900123", message: "hi" })
		expect(result).toEqual({ id: "357551956102758401", kind: "message" })
		expect(sent.urls()).toEqual([TWILIO, PURESMS])
	})

	it("doesn't move on for a refusal any provider would give", async () => {
		const sent = route([respond(400, { code: 21211, message: "Invalid To" })], [])
		const error = await sms({ to: "+447700900123", message: "hi" }).catch((e) => e)
		expect(error).not.toBeInstanceOf(FailoverError)
		expect(error).toMatchObject({ provider: "twilio", reason: "recipient" })
		expect(sent.urls()).toEqual([TWILIO])
	})

	it("never moves on after an unknown outcome: the text may be on its way", async () => {
		const sent = route([respond(502, "Bad Gateway")], [])
		const error = await sms({ to: "+447700900123", message: "hi" }).catch((e) => e)
		expect(error).toMatchObject({ provider: "twilio", outcome_unknown: true })
		expect(sent.urls()).toEqual([TWILIO])
	})

	it("says every provider's answer when all of them refused", async () => {
		route(
			[respond(401, { code: 20003, message: "Authenticate" })],
			[respond(429, { title: "Slow down" })]
		)
		const error = await sms({ to: "+447700900123", message: "hi" }).catch((e) => e)
		expect(error).toBeInstanceOf(FailoverError)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.errors.map((e: PostboiError) => [e.provider, e.reason])).toEqual([
			["twilio", "auth"],
			["puresms", "rate_limited"],
		])
		// The answer the chain ended on is the error's own.
		expect(error).toMatchObject({ provider: "puresms", status: 429, reason: "rate_limited" })
		expect(error.message).toContain("twilio: Authenticate (auth)")
	})

	it("sends a batch on to the next provider only for the messages that need it", async () => {
		const sent = route(
			[
				respond(400, { code: 21612, message: "Not reachable from this From" }),
				respond(201, { sid: "SM2", status: "queued" }),
				respond(400, { code: 21211, message: "Invalid To" }),
			],
			[respond(200, { id: "9" })]
		)
		const results = await sms(
			[
				{ to: "+447700900001", message: "a" },
				{ to: "+447700900002", message: "b" },
				{ to: "+447700900003", message: "c" },
			],
			{ concurrency: 1 }
		)
		expect(results.map((r) => [r.index, r.ok])).toEqual([
			[0, true],
			[1, true],
			[2, false],
		])
		expect(results[0]).toMatchObject({ ok: true, response: { id: "9" } })
		expect(results[1]).toMatchObject({ ok: true, response: { sid: "SM2" } })
		expect(results[2]).toMatchObject({ ok: false, error: { reason: "recipient" } })
		expect(sent.urls().filter((url) => url === PURESMS)).toHaveLength(1)
	})

	it("needs every provider in it configured, not just the first", async () => {
		delete process.env.PURESMS_API_KEY
		vi.stubGlobal("fetch", vi.fn())
		await expect(sms({ to: "+447700900123", message: "hi" })).rejects.toMatchObject({
			code: "missing_env",
			provider: "puresms",
		})
	})

	it("is refused on a channel that can't carry one", async () => {
		process.env.POSTBOI_PUSH_PROVIDER = "webpush,fcm"
		await expect(push({ to: "t", title: "hi" } as never)).rejects.toMatchObject({
			code: "provider_chain_not_supported",
		})
	})

	it("can be named in the config file", async () => {
		delete process.env.POSTBOI_SMS_PROVIDER
		configure({ sms: { provider: ["twilio", "puresms"] } })
		const sent = route(
			[respond(400, { code: 21606, message: "Not SMS-capable" })],
			[respond(200, { id: "1" })]
		)
		await sms({ to: "+447700900123", message: "hi" })
		expect(sent.urls()).toEqual([TWILIO, PURESMS])
	})
})

describe("naming several providers", () => {
	it("reads a comma list or a list, and nothing as nothing", () => {
		expect(provider_keys("twilio, puresms")).toEqual(["twilio", "puresms"])
		expect(provider_keys(["twilio"])).toEqual(["twilio"])
		expect(provider_keys(" , ")).toBeUndefined()
		expect(provider_keys(undefined)).toBeUndefined()
	})

	it("gives config options to the first provider in a chain only", () => {
		const section = { provider: ["twilio", "puresms"], options: { sender: "X" } }
		expect(scoped_options(section, "twilio")).toEqual({ sender: "X" })
		expect(scoped_options(section, "puresms")).toBeUndefined()
	})
})
