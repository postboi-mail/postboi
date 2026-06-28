import { describe, it, expect, vi, beforeEach } from "vitest"
import Postboi, { type SendParams } from "$library/zepto.js"
import { PostboiError } from "$library/index.js"

// mock fetch globally
const fetch = vi.fn()
global.fetch = fetch

/** Build a mock Response whose body is exposed via both text() and json(). */
function respond(opts: { ok?: boolean; status?: number; json?: unknown } = {}) {
	const body = opts.json !== undefined ? JSON.stringify(opts.json) : ""
	return {
		ok: opts.ok ?? true,
		status: opts.status ?? 200,
		headers: new Headers(),
		text: async () => body,
		json: async () => opts.json,
	}
}

// mock env vars
vi.mock("$env/static/private", () => ({
	ZEPTO_TOKEN: "test-token",
	EMAIL_FROM_ADDRESS: "from@test.com",
	EMAIL_TO_ADDRESS: "to@test.com",
}))

describe("zepto", () => {
	describe("Postboi class", () => {
		let mail: InstanceType<typeof Postboi>

		beforeEach(() => {
			vi.clearAllMocks()
			fetch.mockReset()

			mail = new Postboi({
				token: "test-token",
				default: { from: "default@test.com", to: "default-to@test.com" },
			})
		})

		it("should create a Postboi instance with defaults", () => {
			expect(mail).toBeInstanceOf(Postboi)
		})

		it("should send email with string body", async () => {
			const response = { data: [{ message: "success" }] }
			fetch.mockResolvedValue(respond({ json: response }))

			const result = await mail.send({
				to: "recipient@test.com",
				from: "sender@test.com",
				subject: "Test Subject",
				body: "Test body",
			})

			expect(fetch).toHaveBeenCalledOnce()
			expect(fetch).toHaveBeenCalledWith(
				"https://api.zeptomail.com/v1.1/email",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						Authorization: "test-token",
						"Content-Type": "application/json",
					}),
				})
			)
			const body = JSON.parse(fetch.mock.calls[0][1].body as string) as SendParams
			expect(body.to).toEqual([{ email_address: { address: "recipient@test.com" } }])
			expect(body.from).toEqual({ address: "sender@test.com" })
			expect(body.subject).toBe("Test Subject")
			expect(body.htmlbody).toBe("Test body")
			expect(result).toEqual(response)
		})

		it("should use defaults when to/from are omitted", async () => {
			fetch.mockResolvedValue(respond({ json: { data: [] } }))

			await mail.send({ subject: "Test", body: "Body" })

			expect(fetch).toHaveBeenCalledOnce()
			const body = JSON.parse(fetch.mock.calls[0][1].body as string) as SendParams
			expect(body.to).toEqual([{ email_address: { address: "default-to@test.com" } }])
			expect(body.from).toEqual({ address: "default@test.com" })
		})

		it("should handle FormData body", async () => {
			fetch.mockResolvedValue(respond({ json: { data: [] } }))

			const form_data = new FormData()
			form_data.append("name", "Darbo")
			form_data.append("email", "darbo@test.com")
			form_data.append("_subject", "Test Subject")
			form_data.append("_to", "custom@test.com")

			await mail.send({ body: form_data })

			expect(fetch).toHaveBeenCalled()
			const args = JSON.parse(fetch.mock.calls[0][1].body as string) as SendParams
			expect(args.to).toEqual([{ email_address: { address: "custom@test.com" } }])
			expect(args.subject).toBe("Test Subject")
			expect(args.htmlbody).toContain("Darbo")
			expect(args.htmlbody).toContain("darbo@test.com")
		})

		it("should handle multiple recipients", async () => {
			fetch.mockResolvedValue(respond({ json: { data: [] } }))

			await mail.send({
				to: ["one@test.com", "two@test.com"],
				from: "sender@test.com",
				subject: "Test",
				body: "Body",
			})

			const args = JSON.parse(fetch.mock.calls[0][1].body as string) as SendParams
			expect(args.to).toEqual([
				{ email_address: { address: "one@test.com" } },
				{ email_address: { address: "two@test.com" } },
			])
		})

		it("should handle cc and bcc", async () => {
			fetch.mockResolvedValue(respond({ json: { data: [] } }))

			await mail.send({
				to: "to@test.com",
				from: "from@test.com",
				cc: ["cc1@test.com", "cc2@test.com"],
				bcc: "bcc@test.com",
				subject: "Test",
				body: "Body",
			})

			const args = JSON.parse(fetch.mock.calls[0][1].body as string) as SendParams
			expect(args.cc).toEqual([
				{ email_address: { address: "cc1@test.com" } },
				{ email_address: { address: "cc2@test.com" } },
			])
			expect(args.bcc).toEqual([{ email_address: { address: "bcc@test.com" } }])
		})

		it("should handle reply_to", async () => {
			fetch.mockResolvedValue(respond({ json: { data: [] } }))

			await mail.send({
				to: "to@test.com",
				from: "from@test.com",
				reply_to: "reply@test.com",
				subject: "Test",
				body: "Body",
			})

			const args = JSON.parse(fetch.mock.calls[0][1].body as string) as SendParams
			expect(args.reply_to).toEqual([{ address: "reply@test.com" }])
		})

		it("should handle attachments", async () => {
			fetch.mockResolvedValue(respond({ json: { data: [] } }))

			const attachments = new File(["content"], "test.txt", { type: "text/plain" })
			await mail.send({
				to: "to@test.com",
				from: "from@test.com",
				subject: "Test",
				body: "Body",
				attachments,
			})

			const args = JSON.parse(fetch.mock.calls[0][1].body as string) as SendParams
			expect(args.attachments).toBeDefined()
			expect(args.attachments).toHaveLength(1)
			expect(args.attachments![0]).toHaveProperty("name", "test.txt")
			expect(args.attachments![0]).toHaveProperty("content")
		})

		it("should use default subject when not provided", async () => {
			fetch.mockResolvedValue(respond({ json: { data: [] } }))

			await mail.send({ to: "to@test.com", from: "from@test.com", body: "Body" })

			const args = JSON.parse(fetch.mock.calls[0][1].body as string) as SendParams
			expect(args.subject).toBe("Mail sent from website")
		})

		it("includes a plain-text body when auto_text is enabled", async () => {
			fetch.mockResolvedValue(respond({ json: { data: [] } }))
			const auto = new Postboi({ token: "t", default: { from: "a@test.com" }, auto_text: true })

			await auto.send({ to: "to@test.com", body: "<p>Hello</p><p>World</p>" })

			const args = JSON.parse(fetch.mock.calls[0][1].body as string) as SendParams
			expect(args.textbody).toBe("Hello\nWorld")
		})

		describe("error handling", () => {
			it("throws a normalized PostboiError on a zepto error response", async () => {
				const raw = {
					error: {
						code: "INVALID_EMAIL",
						message: "Invalid email address",
						request_id: "req-123",
						details: [],
					},
				}
				fetch.mockResolvedValue(respond({ ok: true, status: 200, json: raw }))

				const error = await mail
					.send({ to: "to@test.com", from: "from@test.com", body: "x" })
					.catch((e) => e)

				expect(error).toBeInstanceOf(PostboiError)
				expect(mail.is_error(error)).toBe(true)
				expect(error.provider).toBe("zeptomail")
				expect(error.message).toBe("Invalid email address")
				expect(error.code).toBe("INVALID_EMAIL")
				expect(error.raw).toEqual(raw)
			})

			it("is_error returns false for non-Postboi values", () => {
				expect(mail.is_error(new Error("nope"))).toBe(false)
				expect(mail.is_error({ error: { message: "x" } })).toBe(false)
				expect(mail.is_error(null)).toBe(false)
			})
		})
	})

	describe("server action", () => {
		beforeEach(() => {
			vi.clearAllMocks()
			vi.resetModules()
			fetch.mockReset()
		})

		it("should return success when email is sent", async () => {
			fetch.mockResolvedValue(respond({ json: { data: [{ message: "success" }] } }))

			const { actions } = await import("./+page.server.js")

			const form_data = new FormData()
			form_data.append("test", "value")

			const request = new Request("http://localhost", { method: "POST", body: form_data })
			const result = await actions.default({ request })

			expect(result).toEqual({ success: true })
			expect(fetch).toHaveBeenCalledOnce()
		})

		it("should return the normalized message when a zepto error occurs", async () => {
			fetch.mockResolvedValue(
				respond({
					json: {
						error: {
							code: "INVALID_EMAIL",
							message: "Invalid email address",
							request_id: "req-123",
							details: [],
						},
					},
				})
			)

			const { actions } = await import("./+page.server.js")

			const form_data = new FormData()
			const request = new Request("http://localhost", { method: "POST", body: form_data })
			const result = await actions.default({ request })

			expect(result).toHaveProperty("status", 400)
			if ("status" in result) expect(result.data).toEqual({ error: "Invalid email address" })
		})

		it("should return a generic error for network failures", async () => {
			fetch.mockRejectedValue(new Error("something went wrong"))

			const { actions } = await import("./+page.server.js")

			const form_data = new FormData()
			const request = new Request("http://localhost", { method: "POST", body: form_data })
			const result = await actions.default({ request })

			expect(result).toHaveProperty("status", 400)
			if ("status" in result) {
				expect(result.data.error).toContain("something went wrong")
			}
		})
	})
})
