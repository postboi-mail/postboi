import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { check_captcha, HONEYPOT_FIELD, TURNSTILE_FIELD } from "$library/captcha.js"
import { SpamError, is_spam, is_error, configure } from "$library/index.js"
import { reset_config } from "$library/config.js"
import Mock from "$library/mock.js"

const fetch = vi.fn()
global.fetch = fetch

function siteverify(body: { success: boolean; "error-codes"?: Array<string> }) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		text: async () => JSON.stringify(body),
		json: async () => body,
	}
}

function form(fields: Record<string, string>) {
	const data = new FormData()
	for (const [key, value] of Object.entries(fields)) data.append(key, value)
	return data
}

beforeEach(() => {
	fetch.mockReset()
	reset_config()
})
afterEach(() => vi.unstubAllEnvs())

describe("check_captcha — honeypot", () => {
	it("passes and strips an empty honeypot field", async () => {
		const data = form({ [HONEYPOT_FIELD]: "", name: "Ada" })
		expect(await check_captcha(data)).toEqual({ ok: true })
		expect(data.has(HONEYPOT_FIELD)).toBe(false)
		expect(data.get("name")).toBe("Ada")
	})

	it("flags a filled honeypot as spam", async () => {
		const verdict = await check_captcha(form({ [HONEYPOT_FIELD]: "buy now" }))
		expect(verdict).toMatchObject({ ok: false, code: "spam" })
	})

	it("passes when no honeypot field is present", async () => {
		expect(await check_captcha(form({ name: "Ada" }))).toEqual({ ok: true })
	})

	it("supports a custom field name", async () => {
		const verdict = await check_captcha(form({ nectar: "spam" }), { honeypot: "nectar" })
		expect(verdict).toMatchObject({ ok: false, code: "spam" })
		// The default name is no longer special when renamed.
		expect(await check_captcha(form({ [HONEYPOT_FIELD]: "spam" }), { honeypot: "nectar" })).toEqual(
			{ ok: true }
		)
	})

	it("can be disabled", async () => {
		const data = form({ [HONEYPOT_FIELD]: "filled" })
		expect(await check_captcha(data, { honeypot: false })).toEqual({ ok: true })
		// Disabled = the field is ordinary form content again.
		expect(data.get(HONEYPOT_FIELD)).toBe("filled")
	})
})

describe("check_captcha — Turnstile", () => {
	it("is inert with no secret and no token", async () => {
		expect(await check_captcha(form({ name: "Ada" }))).toEqual({ ok: true })
		expect(fetch).not.toHaveBeenCalled()
	})

	it("verifies and strips the token when a secret is set", async () => {
		vi.stubEnv("TURNSTILE_SECRET_KEY", "secret_1")
		fetch.mockResolvedValue(siteverify({ success: true }))

		const data = form({ [TURNSTILE_FIELD]: "token_1", name: "Ada" })
		expect(await check_captcha(data)).toEqual({ ok: true })
		expect(data.has(TURNSTILE_FIELD)).toBe(false)

		const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
		expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify")
		expect(JSON.parse(init.body as string)).toEqual({ secret: "secret_1", response: "token_1" })
	})

	it("fails when the token is invalid", async () => {
		vi.stubEnv("TURNSTILE_SECRET_KEY", "secret_1")
		fetch.mockResolvedValue(
			siteverify({ success: false, "error-codes": ["invalid-input-response"] })
		)

		const verdict = await check_captcha(form({ [TURNSTILE_FIELD]: "bad" }))
		expect(verdict).toMatchObject({ ok: false, code: "captcha_failed" })
		expect((verdict as { message: string }).message).toContain("invalid-input-response")
	})

	it("fails when a secret is set but the form has no token (direct-POST bots)", async () => {
		vi.stubEnv("TURNSTILE_SECRET_KEY", "secret_1")
		const verdict = await check_captcha(form({ name: "Ada" }))
		expect(verdict).toMatchObject({ ok: false, code: "captcha_failed" })
		expect(fetch).not.toHaveBeenCalled()
	})

	it("flags a token with no secret as misconfiguration", async () => {
		const verdict = await check_captcha(form({ [TURNSTILE_FIELD]: "token_1" }))
		expect(verdict).toMatchObject({ ok: false, code: "captcha_misconfigured" })
	})

	it("accepts an explicit secret_key (Workers, no ambient env)", async () => {
		fetch.mockResolvedValue(siteverify({ success: true }))
		const verdict = await check_captcha(form({ [TURNSTILE_FIELD]: "token_1" }), {
			turnstile: { secret_key: "explicit" },
		})
		expect(verdict).toEqual({ ok: true })
		const [, init] = fetch.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(init.body as string).secret).toBe("explicit")
	})

	it("turnstile: true requires verification even with nothing configured", async () => {
		const verdict = await check_captcha(form({ name: "Ada" }), { turnstile: true })
		expect(verdict).toMatchObject({ ok: false, code: "captcha_misconfigured" })
	})

	it("turnstile: false skips verification but still strips the token", async () => {
		vi.stubEnv("TURNSTILE_SECRET_KEY", "secret_1")
		const data = form({ [TURNSTILE_FIELD]: "token_1" })
		expect(await check_captcha(data, { turnstile: false })).toEqual({ ok: true })
		expect(data.has(TURNSTILE_FIELD)).toBe(false)
		expect(fetch).not.toHaveBeenCalled()
	})

	it("fails closed when the verifier is unreachable", async () => {
		vi.stubEnv("TURNSTILE_SECRET_KEY", "secret_1")
		fetch.mockRejectedValue(new Error("network down"))
		const verdict = await check_captcha(form({ [TURNSTILE_FIELD]: "token_1" }))
		expect(verdict).toMatchObject({ ok: false, code: "captcha_failed" })
	})
})

describe("provider integration", () => {
	const defaults = { from: "from@test.com", to: "to@test.com" }

	it("a filled honeypot throws SpamError and sends nothing", async () => {
		const mail = new Mock({ default: defaults })
		const error = await mail
			.send({ body: form({ [HONEYPOT_FIELD]: "spam", name: "Bot" }) })
			.then(() => undefined)
			.catch((e: unknown) => e)

		expect(error).toBeInstanceOf(SpamError)
		expect(is_spam(error)).toBe(true)
		expect(is_error(error) && error.code).toBe("spam")
		expect(mail.sent).toHaveLength(0)
	})

	it("an empty honeypot sends, without the field in the body", async () => {
		const mail = new Mock({ default: defaults })
		await mail.send({ body: form({ [HONEYPOT_FIELD]: "", name: "Ada" }) })

		expect(mail.sent).toHaveLength(1)
		expect(mail.last?.html).toContain("Ada")
		expect(mail.last?.html).not.toContain(HONEYPOT_FIELD)
	})

	it("spam never reaches the on.error hook", async () => {
		const on_error = vi.fn()
		const mail = new Mock({ default: defaults, hooks: { on: { error: on_error } } })
		await expect(mail.send({ body: form({ [HONEYPOT_FIELD]: "spam" }) })).rejects.toThrow(SpamError)
		expect(on_error).not.toHaveBeenCalled()
	})

	it("checks plain-object bodies (Express req.body) too", async () => {
		const mail = new Mock({ default: defaults })
		await expect(mail.send({ body: { [HONEYPOT_FIELD]: "spam" } })).rejects.toThrow(SpamError)
	})

	it("a valid Turnstile token verifies before the send", async () => {
		vi.stubEnv("TURNSTILE_SECRET_KEY", "secret_1")
		fetch.mockResolvedValue(siteverify({ success: true }))

		const mail = new Mock({ default: defaults })
		await mail.send({ body: form({ [TURNSTILE_FIELD]: "token_1", name: "Ada" }) })

		expect(mail.sent).toHaveLength(1)
		expect(mail.last?.html).not.toContain(TURNSTILE_FIELD)
	})

	it("a failed Turnstile check throws captcha_failed", async () => {
		vi.stubEnv("TURNSTILE_SECRET_KEY", "secret_1")
		fetch.mockResolvedValue(siteverify({ success: false, "error-codes": ["timeout-or-duplicate"] }))

		const mail = new Mock({ default: defaults })
		const error = await mail
			.send({ body: form({ [TURNSTILE_FIELD]: "stale" }) })
			.then(() => undefined)
			.catch((e: unknown) => e)

		expect(is_error(error) && error.code).toBe("captcha_failed")
		expect(mail.sent).toHaveLength(0)
	})

	it("string bodies are untouched by the spam checks", async () => {
		vi.stubEnv("TURNSTILE_SECRET_KEY", "secret_1")
		const mail = new Mock({ default: defaults })
		await mail.send({ body: "<p>rendered html</p>" })
		expect(mail.sent).toHaveLength(1)
		expect(fetch).not.toHaveBeenCalled()
	})

	it("per-send captcha overrides instance and global config", async () => {
		configure({ captcha: { honeypot: "nectar" } })
		const mail = new Mock({ default: defaults })
		// Global rename applies…
		await expect(mail.send({ body: form({ nectar: "spam" }) })).rejects.toThrow(SpamError)
		// …and a per-send override can turn the check off entirely.
		await mail.send({ body: form({ nectar: "spam" }), captcha: { honeypot: false } })
		expect(mail.sent).toHaveLength(1)
	})
})
