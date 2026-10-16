import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { reset_config } from "../config.js"
import Twilio from "./twilio.js"
import Vonage from "./vonage.js"
import SmsWorks from "./smsworks.js"
import { sms } from "./send.js"

const fetch = vi.fn()

beforeEach(() => {
	reset_config()
	vi.stubGlobal("fetch", fetch)
	fetch.mockReset()
	delete process.env.NODE_ENV
})
afterEach(() => {
	vi.unstubAllGlobals()
	for (const key of [
		"POSTBOI_SMS_PROVIDER",
		"TWILIO_ACCOUNT_SID",
		"TWILIO_AUTH_TOKEN",
		"TWILIO_MESSAGING_SERVICE_SID",
		"VONAGE_API_KEY",
		"VONAGE_API_SECRET",
		"VONAGE_APPLICATION_ID",
		"VONAGE_PRIVATE_KEY",
	])
		delete process.env[key]
})

const twilio = (options = {}) =>
	new Twilio({ account_sid: "AC1", auth_token: "t", default: { from: "+15550001111" }, ...options })

describe("validate()", () => {
	it("says what a good text costs, and sends nothing", async () => {
		const check = await twilio().validate({
			to: "07788 223344",
			country: "GB",
			message: "Your code is 4291",
		})
		expect(check).toEqual({
			ok: true,
			provider: "twilio",
			to: ["+447788223344"],
			encoding: "gsm7",
			segments: 1,
			units: 17,
			ucs2_characters: [],
			issues: [],
		})
		expect(fetch).not.toHaveBeenCalled()
	})

	it("names the characters that forced UCS-2", async () => {
		const check = await twilio().validate({
			to: "+447788223344",
			message: "Your code is “4291” — see you soon",
		})
		expect(check.encoding).toBe("ucs2")
		expect(check.ucs2_characters).toEqual(["“", "”", "—"])
		expect(check.ok).toBe(true)
	})

	it("lists every problem, not only the first a send would throw", async () => {
		const check = await new Vonage({ api_key: "k", api_secret: "s" }).validate({
			to: ["+123", "+447700900123", "+45"],
			message: " ",
			scheduled_at: { days: 1 },
		})
		expect(check.ok).toBe(false)
		expect(check.issues.map((i) => i.code)).toEqual([
			"no_sender",
			"empty_message",
			"scheduling_not_supported",
			"invalid_number",
			"invalid_number",
		])
		// The number that was fine is still read.
		expect(check.to).toEqual(["+447700900123"])
	})

	it("says what this provider in particular would refuse", async () => {
		const check = await twilio().validate({
			to: ["+447700900001", "+447700900002"],
			message: "hi",
			scheduled_at: { days: 1 },
		})
		expect(check.issues.map((i) => i.code)).toEqual([
			"single_recipient_only",
			"scheduling_needs_service",
		])
	})

	it("catches an alphanumeric sender a carrier would refuse", async () => {
		const works = new SmsWorks({ api_key: "k" })
		const long = await works.validate({
			to: "+447700900123",
			from: "ACMECORPORATION",
			message: "hi",
		})
		expect(long.issues).toEqual([
			{ code: "invalid_sender", message: expect.stringContaining("carriers allow 11") },
		])
		const odd = await works.validate({ to: "+447700900123", from: "ACME-CO", message: "hi" })
		expect(odd.issues[0].code).toBe("invalid_sender")
		const fine = await works.validate({ to: "+447700900123", from: "ACME CO", message: "hi" })
		expect(fine.ok).toBe(true)
	})

	it("throws on a send what validate lists first", async () => {
		const provider = new Vonage({ api_key: "k", api_secret: "s" })
		const options = { to: "123", message: "hi" }
		const [first] = (await provider.validate(options)).issues
		await expect(provider.send(options)).rejects.toMatchObject({ code: first.code })
	})

	it("checks a chain against each provider in it, from sms.validate", async () => {
		process.env.POSTBOI_SMS_PROVIDER = "twilio,vonage"
		process.env.TWILIO_ACCOUNT_SID = "AC1"
		process.env.TWILIO_AUTH_TOKEN = "t"
		process.env.TWILIO_MESSAGING_SERVICE_SID = ""
		process.env.VONAGE_API_KEY = "k"
		process.env.VONAGE_API_SECRET = "s"
		process.env.VONAGE_APPLICATION_ID = ""
		process.env.VONAGE_PRIVATE_KEY = ""
		const check = await sms.validate({
			to: "+447700900123",
			from: "ACME",
			message: "hi",
			scheduled_at: { days: 1 },
		})
		expect(check.provider).toBe("twilio")
		expect(check.chain?.map((c) => [c.provider, c.issues.map((i) => i.code)])).toEqual([
			["twilio", ["scheduling_needs_service"]],
			["vonage", ["scheduling_not_supported"]],
		])
		expect(fetch).not.toHaveBeenCalled()
	})
})
