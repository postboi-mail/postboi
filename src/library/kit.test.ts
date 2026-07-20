import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { action, mail, remote_form_data, webhook } from "$library/kit.js"
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
		const provider = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		const result = await action(provider)(event({ "contact→name": "Ada" }))

		expect(result).toEqual({ success: true })
		expect(provider.sent).toHaveLength(1)
		expect(provider.last?.from.address).toBe("from@test.com")
	})

	it("returns fail(400, { error }) when the send throws", async () => {
		const provider = new Mock() // no default from/to → prepare_send throws PostboiError
		const result = await action(provider)(event({ subject: "Hi" }))

		expect(result).toMatchObject({ status: 400 })
		expect((result as { data: { error: string } }).data.error).toMatch(/recipient|sender/i)
		expect(provider.sent).toHaveLength(0)
	})

	it("honours a custom failure status", async () => {
		const provider = new Mock()
		const result = await action(provider, { status: 422 })(event({ subject: "Hi" }))
		expect(result).toMatchObject({ status: 422 })
	})

	it("returns { success: true } on a tripped honeypot without sending (bots learn nothing)", async () => {
		const provider = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		const result = await action(provider)(event({ "🍯": "cheap pills", message: "spam" }))

		expect(result).toEqual({ success: true })
		expect(provider.sent).toHaveLength(0)
	})

	it("returns fail(400) when Turnstile verification fails", async () => {
		vi.stubEnv("TURNSTILE_SECRET_KEY", "secret_1")
		fetch.mockResolvedValue(respond({ success: false, "error-codes": ["invalid-input-response"] }))

		const provider = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		const result = await action(provider)(event({ "cf-turnstile-response": "bad" }))

		expect(result).toMatchObject({ status: 400 })
		expect((result as { data: { error: string } }).data.error).toMatch(/captcha/i)
		expect(provider.sent).toHaveLength(0)
	})

	it("merges server-set fields, keeping FormData as the body", async () => {
		const provider = new Mock({ default: { from: "from@test.com" } })
		await action(provider, { fields: { to: "forced@test.com", subject: "Forced" } })(
			event({ message: "hi" })
		)
		expect(provider.last?.to[0].address).toBe("forced@test.com")
		expect(provider.last?.subject).toBe("Forced")
		expect(provider.last?.html).toContain("hi")
	})

	it("the zero-config `mail` action dispatches via POSTBOI_PROVIDER", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "resend")
		vi.stubEnv("RESEND_API_KEY", "re_123")
		vi.stubEnv("POSTBOI_FROM", "from@test.com")
		vi.stubEnv("POSTBOI_TO", "to@test.com")
		fetch.mockResolvedValue(respond({ id: "re-1" }))

		const result = await mail(event({ message: "hi" }))

		expect(result).toEqual({ success: true })
		expect(fetch.mock.calls.at(-1)![0]).toBe("https://api.resend.com/emails")
	})

	it("the zero-config `mail` action fails gracefully with no provider", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "")
		const result = await mail(event({ message: "hi" }))
		expect(result).toMatchObject({ status: 400 })
		expect((result as { data: { error: string } }).data.error).toMatch(/postboi init/)
		expect(fetch).not.toHaveBeenCalled()
	})
})

describe("postboi/kit webhook()", () => {
	const kit_event = (request: Request) => ({ request }) as never

	it("verifies, normalizes and calls the handler once per event", async () => {
		const { mock_request } = await import("$library/webhooks/index.js")
		const { request, secret } = await mock_request({ provider: "resend", type: "opened" })

		const seen: Array<string> = []
		const handler = webhook(
			(event) => {
				seen.push(`${event.type}:${event.email}:${event.client?.name}`)
			},
			{ provider: "resend", secret }
		)
		const response = await handler(kit_event(request))

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ received: 1 })
		expect(seen).toEqual(["opened:recipient@example.com:Apple Mail"])
	})

	it("returns 401 on a bad signature so the provider knows it was rejected", async () => {
		const { mock_request } = await import("$library/webhooks/index.js")
		const { request } = await mock_request({ provider: "resend", type: "delivered" })

		const handler = webhook(() => {}, { provider: "resend", secret: "whsec_d3JvbmchIQ==" })
		const response = await handler(kit_event(request))
		expect(response.status).toBe(401)
	})

	it("returns 400 on an unparseable payload", async () => {
		const request = new Request("https://example.com/webhooks", {
			method: "POST",
			body: "not json",
		})
		const handler = webhook(() => {}, { provider: "resend", verify: false })
		const response = await handler(kit_event(request))
		expect(response.status).toBe(400)
	})

	it("returns 500 when the handler throws, so the provider retries", async () => {
		const { mock_request } = await import("$library/webhooks/index.js")
		const { request, secret } = await mock_request({ provider: "resend", type: "delivered" })

		const handler = webhook(
			() => {
				throw new Error("database down")
			},
			{ provider: "resend", secret }
		)
		const response = await handler(kit_event(request))
		expect(response.status).toBe(500)
		expect(await response.json()).toEqual({ error: "database down" })
	})
})

describe("postboi/kit remote_form_data()", () => {
	it("flattens nested objects with the → grouping syntax", async () => {
		const data = remote_form_data({
			_subject: "Contact Form",
			contact: { name: "Ada", email: "ada@example.com" },
			details: { message: "Hello" },
		})
		expect(data.get("_subject")).toBe("Contact Form")
		expect(data.get("contact→name")).toBe("Ada")
		expect(data.get("contact→email")).toBe("ada@example.com")
		expect(data.get("details→message")).toBe("Hello")
	})

	it("keeps File values intact and repeats arrays", async () => {
		const file = new File(["hi"], "hi.txt", { type: "text/plain" })
		const data = remote_form_data({
			details: { attachments: [file, file] },
			tags: ["a", "b"],
			skipped: undefined,
		})
		expect(data.getAll("details→attachments")).toEqual([file, file])
		expect(data.getAll("tags")).toEqual(["a", "b"])
		expect(data.has("skipped")).toBe(false)
	})

	it("stringifies the coerced number/boolean values remote forms produce", async () => {
		const data = remote_form_data({ info: { height: 170, likes_dogs: true } })
		expect(data.get("info→height")).toBe("170")
		expect(data.get("info→likes_dogs")).toBe("true")
	})
})
