import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { action, send } from "$library/kit.js"
import Mock from "$library/mock.js"

const fetch = vi.fn()
global.fetch = fetch

function respond(json: unknown = { id: "1" }) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		text: async () => JSON.stringify(json),
		json: async () => json,
	}
}

/** Build a minimal RequestEvent whose `request.formData()` yields the given fields. */
function event(fields: Record<string, string>) {
	const form = new FormData()
	for (const [key, value] of Object.entries(fields)) form.append(key, value)
	return { request: { formData: async () => form } } as never
}

beforeEach(() => {
	fetch.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("postboi/kit action()", () => {
	it("sends with a configured instance and returns { success: true }", async () => {
		const mail = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		const result = await action(mail)(event({ "contact→name": "Ada" }))

		expect(result).toEqual({ success: true })
		expect(mail.sent).toHaveLength(1)
		expect(mail.last?.from.address).toBe("from@test.com")
	})

	it("returns fail(400, { error }) when the send throws", async () => {
		const mail = new Mock() // no default from/to → prepare_send throws PostboiError
		const result = await action(mail)(event({ subject: "Hi" }))

		expect(result).toMatchObject({ status: 400 })
		expect((result as { data: { error: string } }).data.error).toMatch(/recipient|sender/i)
		expect(mail.sent).toHaveLength(0)
	})

	it("honours a custom failure status", async () => {
		const mail = new Mock()
		const result = await action(mail, { status: 422 })(event({ subject: "Hi" }))
		expect(result).toMatchObject({ status: 422 })
	})

	it("merges server-set fields, keeping FormData as the body", async () => {
		const mail = new Mock({ default: { from: "from@test.com" } })
		await action(mail, { fields: { to: "forced@test.com", subject: "Forced" } })(
			event({ message: "hi" })
		)
		expect(mail.last?.to[0].address).toBe("forced@test.com")
		expect(mail.last?.subject).toBe("Forced")
		expect(mail.last?.html).toContain("hi")
	})

	it("the zero-config `send` action dispatches via POSTBOI_PROVIDER", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "resend")
		vi.stubEnv("RESEND_API_KEY", "re_123")
		vi.stubEnv("POSTBOI_FROM", "from@test.com")
		vi.stubEnv("POSTBOI_TO", "to@test.com")
		fetch.mockResolvedValue(respond({ id: "re-1" }))

		const result = await send(event({ message: "hi" }))

		expect(result).toEqual({ success: true })
		expect(fetch.mock.calls.at(-1)![0]).toBe("https://api.resend.com/emails")
	})

	it("the zero-config `send` action fails gracefully with no provider", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "")
		const result = await send(event({ message: "hi" }))
		expect(result).toMatchObject({ status: 400 })
		expect((result as { data: { error: string } }).data.error).toMatch(/postboi init/)
		expect(fetch).not.toHaveBeenCalled()
	})
})
