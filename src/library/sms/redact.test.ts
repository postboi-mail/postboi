import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { configure, reset_config } from "../config.js"
import { PostboiError } from "../errors.js"
import { mask_phone, redact_deep, redact_phones, withhold_text, withheld_text } from "./phone.js"
import Twilio from "./twilio.js"

const to = "+447700900123"

describe("redact_phones", () => {
	it("masks a number and keeps its country code's first digit and its last two", () => {
		expect(mask_phone(to)).toBe("+4*********23")
		expect(mask_phone("0770 090 0123")).toBe("0********23")
		expect(mask_phone("123")).toBe("***")
	})

	it("masks what looks like a number and leaves codes, dates and prices", () => {
		expect(
			redact_phones(
				"The To number +15005550001 is invalid (21211), sent 2026-10-16T00:35:28Z, code 4291, call 0770 090 0123"
			)
		).toBe(
			"The To number +1********01 is invalid (21211), sent 2026-10-16T00:35:28Z, code 4291, call 0********23"
		)
	})

	it("leaves the digits inside an id or a timestamp, and masks an encoded number", () => {
		const ids =
			"sid SM1234567890abcdef1234567890abcdef, uuid 40385f64-5717-4562-b3fc-2c963f66afa6, uuid 12345678-1234-4562-b3fc-2c963f66afa6, at 2026-10-16 12:30:00"
		expect(redact_phones(ids)).toBe(ids)
		expect(redact_phones("To=%2B447700900123&From=ACME")).toBe("To=+4*********23&From=ACME")
	})

	it("copies plain objects and arrays, and stops at a cycle", () => {
		const raw: Record<string, unknown> = {
			to: [to],
			nested: { from: "+15550001111" },
			at: new Date(0),
		}
		raw.self = raw
		const out = redact_deep(raw)
		expect(out).toMatchObject({ to: ["+4*********23"], nested: { from: "+1********11" } })
		expect(out.at).toBe(raw.at)
		expect(out.self).toBe(out)
		expect(raw.to).toEqual([to])
	})
})

describe("withhold_text", () => {
	const code = "Your Acme code is 482913"

	it("says how long a text was and nothing it said, counting an emoji as one", () => {
		expect(withheld_text(code)).toBe("[text withheld, 24 characters]")
		expect(withheld_text("ok 👍")).toBe("[text withheld, 4 characters]")
	})

	it("hides the text where a string is the text or holds it", () => {
		expect(withhold_text(code, code)).toBe("[text withheld, 24 characters]")
		expect(withhold_text(`Message '${code}' refused`, code)).toBe(
			"Message '[text withheld, 24 characters]' refused"
		)
		// A short text is a common word: only a string that is the whole of it is hidden.
		expect(withhold_text("ok", "ok")).toBe("[text withheld, 2 characters]")
		expect(withhold_text("token is ok", "ok")).toBe("token is ok")
		expect(withhold_text("anything", "")).toBe("anything")
		// A code on its own is the secret however short it is.
		expect(withhold_text("Message '482913' refused", "482913")).toBe(
			"Message '[text withheld, 6 characters]' refused"
		)
	})

	it("counts a character as a person would", () => {
		expect(withheld_text("ok 👍🏽")).toBe("[text withheld, 4 characters]")
	})

	it("goes through objects with the numbers, hiding the text first", () => {
		const text = `Call ${to} for code 482913`
		expect(redact_deep({ body: text, to, other: "kept" }, text)).toEqual({
			body: "[text withheld, 34 characters]",
			to: "+4*********23",
			other: "kept",
		})
	})
})

describe("sms redact", () => {
	const refuse = () =>
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				headers: new Headers(),
				text: async () =>
					JSON.stringify({
						code: 21211,
						message: `The 'To' number ${to} is not a valid phone number.`,
					}),
			})
		)
	const accept = () =>
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 201,
				headers: new Headers(),
				text: async () =>
					JSON.stringify({ sid: "SM1", status: "queued", to, body: "Your Acme code is 482913" }),
			})
		)

	beforeEach(() => {
		reset_config()
		vi.unstubAllGlobals()
	})
	afterEach(() => {
		delete process.env.POSTBOI_SMS_REDACT
	})

	const twilio = (options = {}) =>
		new Twilio({
			account_sid: "AC1",
			auth_token: "t",
			default: { from: "+15550001111" },
			...options,
		})

	it("masks by default, with nothing set", async () => {
		refuse()
		const error = (await twilio()
			.send({ to, message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error.message).not.toContain(to)
		expect(error.message).toContain("+4*********23")
	})

	it("masks the error's message, stack and raw, and keeps its class and code", async () => {
		refuse()
		const seen: Array<unknown> = []
		const error = (await twilio({
			redact: true,
			hooks: { on: { error: (ctx: { message?: unknown; error: unknown }) => void seen.push(ctx) } },
		})
			.send({ to, message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.code).toBe(21211)
		expect(error.message).not.toContain(to)
		expect(error.message).toContain("+4*********23")
		expect(error.stack).not.toContain(to)
		expect(JSON.stringify(error.raw)).not.toContain(to)
		expect(JSON.stringify(seen)).not.toContain(to)
	})

	it("shows after.send a masked copy, and sends the real number", async () => {
		accept()
		let seen: unknown
		await twilio({
			redact: true,
			hooks: { after: { send: (ctx: unknown) => void (seen = ctx) } },
		}).send({
			to,
			message: "hi",
		})
		expect(JSON.stringify(seen)).not.toContain(to)
		const body = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
		expect(body).toContain(encodeURIComponent(to))
	})

	it("withholds the text from after.send, on.error and the error, and sends it", async () => {
		const message = "Your Acme code is 482913"
		accept()
		let sent: unknown
		await twilio({ hooks: { after: { send: (ctx: unknown) => void (sent = ctx) } } }).send({
			to,
			message,
		})
		expect(JSON.stringify(sent)).not.toContain("482913")
		expect(sent).toMatchObject({ message: { message: "[text withheld, 24 characters]" } })
		const body = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
		expect(body).toContain(encodeURIComponent(message).replace(/%20/g, "+"))

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				headers: new Headers(),
				text: async () =>
					JSON.stringify({ code: 30044, message: `Message '${message}' refused`, body: message }),
			})
		)
		let failed: unknown
		const error = (await twilio({
			hooks: { on: { error: (ctx: unknown) => void (failed = ctx) } },
		})
			.send({ to, message })
			.catch((e) => e)) as PostboiError
		for (const shown of [
			error.message,
			error.stack,
			JSON.stringify(error.raw),
			JSON.stringify(failed),
		]) {
			expect(shown).not.toContain("482913")
		}
		expect(error.message).toContain("[text withheld, 24 characters]")

		// Turned off, everything is shown as it was.
		const open = (await twilio({ redact: false })
			.send({ to, message })
			.catch((e) => e)) as PostboiError
		expect(JSON.stringify(open.raw)).toContain(message)
	})

	it("withholds a short text that is the whole error from its stack too", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				headers: new Headers(),
				text: async () => JSON.stringify({ code: 30044, message: "ok" }),
			})
		)
		const short = (await twilio()
			.send({ to, message: "ok" })
			.catch((e) => e)) as PostboiError
		expect(short.message).toBe("[text withheld, 2 characters]")
		expect(short.stack?.split("\n")[0]).not.toMatch(/: ok$/)
	})

	it("is turned off by the environment, the config, or the instance", async () => {
		refuse()
		const message = async (options = {}) =>
			(
				(await twilio(options)
					.send({ to, message: "hi" })
					.catch((e) => e)) as PostboiError
			).message
		for (const off of ["0", "false", "off"]) {
			process.env.POSTBOI_SMS_REDACT = off
			expect(await message(), off).toContain(to)
		}
		// An empty variable says nothing, so the default stands.
		process.env.POSTBOI_SMS_REDACT = ""
		expect(await message()).not.toContain(to)
		delete process.env.POSTBOI_SMS_REDACT

		configure({ sms: { redact: false } })
		expect(await message()).toContain(to)
		// An instance's own answer wins over the config.
		expect(await message({ redact: true })).not.toContain(to)
		reset_config()
		expect(await message({ redact: false })).toContain(to)
	})

	it("masks a number refused before any request", async () => {
		vi.stubGlobal("fetch", vi.fn())
		const error = (await twilio({ redact: true })
			.send({ to: "+999 1234 5678", message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error.message).not.toMatch(/1234\s?5678/)
	})
})
