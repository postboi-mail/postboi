import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Postboi, { mail, is_error, PostboiError } from "$library/postboi.js"

const fetch = vi.fn()
global.fetch = fetch

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

const sent_url = () => fetch.mock.calls.at(-1)![0] as string
const sent_init = () =>
	fetch.mock.calls.at(-1)![1] as RequestInit & { headers: Record<string, string> }
const sent_json = () => JSON.parse(sent_init().body as string)

beforeEach(() => fetch.mockReset())
afterEach(() => vi.unstubAllEnvs())

describe("the Postboi provider (zero-config)", () => {
	it("auto-reads POSTBOI_TOKEN from the environment", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "pb_live_123")
		fetch.mockResolvedValue(respond({ json: { id: "abc" } }))

		const provider = new Postboi({ default: { from: "from@test.com" } })
		const result = await provider.send({ to: "to@test.com", subject: "Hi", body: "<p>x</p>" })

		expect(sent_url()).toBe("https://postboi.email/v1/send")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer pb_live_123" })
		const body = sent_json()
		expect(body.from).toEqual({ email: "from@test.com" })
		expect(body.to).toEqual([{ email: "to@test.com" }])
		expect(body.html).toBe("<p>x</p>")
		expect(result).toEqual({ id: "abc" })
	})

	it("sends without a from — the API defaults to the account's sending address", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "pb_live_123")
		fetch.mockResolvedValue(respond({ json: { id: "abc" } }))

		const provider = new Postboi()
		const result = await provider.send({ to: "to@test.com", subject: "Hi", body: "<p>x</p>" })

		expect(sent_json().from).toBeUndefined()
		expect(result).toEqual({ id: "abc" })
	})

	it("an explicit token overrides the environment", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "from_env")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		const provider = new Postboi({ token: "explicit", default: { from: "from@test.com" } })
		await provider.send({ to: "to@test.com", body: "x" })

		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer explicit" })
	})

	it("throws a friendly PostboiError when no token is available", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "")
		const provider = new Postboi({ default: { from: "from@test.com" } })

		const error = await provider.send({ to: "to@test.com", body: "x" }).catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.code).toBe("no_token")
		expect(error.message).toMatch(/postboi init/)
		expect(fetch).not.toHaveBeenCalled()
	})

	it("honours a custom base_url and POSTBOI_API_URL", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))
		await new Postboi({
			token: "t",
			base_url: "https://staging.postboi.email/",
			default: { from: "f@test.com" },
		}).send({
			to: "to@test.com",
			body: "x",
		})
		expect(sent_url()).toBe("https://staging.postboi.email/v1/send")

		vi.stubEnv("POSTBOI_API_URL", "http://localhost:8787")
		await new Postboi({ token: "t", default: { from: "f@test.com" } }).send({
			to: "to@test.com",
			body: "x",
		})
		expect(sent_url()).toBe("http://localhost:8787/v1/send")
	})

	it("forwards headers, tags and attachments", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))
		await new Postboi({ token: "t", default: { from: "f@test.com" } }).send({
			to: "to@test.com",
			body: "x",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome"],
			attachments: new File(["data"], "doc.pdf", { type: "application/pdf" }),
		})
		const body = sent_json()
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.tags).toEqual(["welcome"])
		expect(body.attachments).toEqual([
			{
				content: Buffer.from("data").toString("base64"),
				filename: "doc.pdf",
				type: "application/pdf",
			},
		])
	})

	it("normalizes API errors to PostboiError", async () => {
		fetch.mockResolvedValue(
			respond({ ok: false, status: 401, json: { message: "bad token", code: "unauthorized" } })
		)
		const provider = new Postboi({ token: "t", default: { from: "f@test.com" } })
		const error = await provider.send({ to: "to@test.com", body: "x" }).catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.provider).toBe("postboi")
		expect(error.message).toBe("bad token")
		expect(error.code).toBe("unauthorized")
	})

	it("reads default from/to from POSTBOI_FROM / POSTBOI_TO", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		vi.stubEnv("POSTBOI_FROM", "noreply@test.com")
		vi.stubEnv("POSTBOI_TO", "ops@test.com")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		await new Postboi().send({ body: "<p>x</p>" })
		const body = sent_json()
		expect(body.from).toEqual({ email: "noreply@test.com" })
		expect(body.to).toEqual([{ email: "ops@test.com" }])
	})

	it("forwards the Turnstile token and form flag from FormData sends (managed captcha)", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		const form = new FormData()
		form.append("cf-turnstile-response", "token_1")
		form.append("contact→name", "Ada")
		await new Postboi().send({ to: "to@test.com", body: form })

		const body = sent_json()
		expect(body.captcha_token).toBe("token_1")
		expect(body.form).toBe(true)
		expect(body.html).not.toContain("cf-turnstile-response")
	})

	it("flags form sends even without a token, so the API can gate them", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		const form = new FormData()
		form.append("contact→name", "Ada")
		await new Postboi().send({ to: "to@test.com", body: form })

		const body = sent_json()
		expect(body.captcha_token).toBeUndefined()
		expect(body.form).toBe(true)
	})

	it("string bodies carry no captcha fields", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		await new Postboi().send({ to: "to@test.com", body: "<p>x</p>" })
		const body = sent_json()
		expect(body.form).toBeUndefined()
		expect(body.captcha_token).toBeUndefined()
	})

	it("forwards idempotency_key as the Idempotency-Key header", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))
		await new Postboi({ token: "t" }).send({
			to: "to@test.com",
			body: "x",
			idempotency_key: "order-42",
		})
		expect(sent_init().headers).toMatchObject({ "Idempotency-Key": "order-42" })
	})

	it("sends personalized data batches as one POST /v1/send/batch", async () => {
		fetch.mockResolvedValue(respond({ json: { ids: ["m1", "m2"] } }))

		const results = await new Postboi({ token: "t" }).send({
			to: ["a@test.com", "b@test.com"],
			subject: "Hey {name}",
			body: "<p>Hi {name}</p>",
			data: {
				"a@test.com": { name: "Ada" },
				"b@test.com": { name: "Linus" },
			},
		})

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(sent_url()).toBe("https://postboi.email/v1/send/batch")
		const body = sent_json()
		expect(body).toHaveLength(2)
		expect(body[0].subject).toBe("Hey Ada")
		expect(body[1].html).toBe("<p>Hi Linus</p>")
		expect(results).toEqual([
			{ ok: true, index: 0, response: { id: "m1" } },
			{ ok: true, index: 1, response: { id: "m2" } },
		])
	})
})

describe("the Postboi provider — account API", () => {
	const provider = () => new Postboi({ token: "t" })

	it("message() retrieves status and content", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "m1", status: "sent", open_count: 2 } }))
		const message = await provider().messages.get("m1")
		expect(sent_url()).toBe("https://postboi.email/v1/messages/m1")
		expect(sent_init().method).toBe("GET")
		expect(sent_init().body).toBeUndefined()
		expect(message.status).toBe("sent")
	})

	it("reschedule() PATCHes scheduled_at, resolving durations", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-07-01T00:00:00Z"))
		fetch.mockResolvedValue(
			respond({ json: { id: "m1", scheduled_at: "2026-07-02T00:00:00.000Z" } })
		)

		const moved = await provider().messages.reschedule("m1", { days: 1 })
		expect(sent_url()).toBe("https://postboi.email/v1/messages/m1")
		expect(sent_init().method).toBe("PATCH")
		expect(sent_json()).toEqual({ scheduled_at: "2026-07-02T00:00:00.000Z" })
		expect(moved.scheduled_at).toBe("2026-07-02T00:00:00.000Z")
		vi.useRealTimers()
	})

	it("lists() unwraps the lists array", async () => {
		fetch.mockResolvedValue(respond({ json: { lists: [{ id: "l1", name: "News" }] } }))
		const lists = await provider().lists.all()
		expect(sent_url()).toBe("https://postboi.email/v1/lists")
		expect(lists).toEqual([{ id: "l1", name: "News" }])
	})

	it("creates, renames and deletes lists", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "l1", name: "News" } }))
		await provider().lists.create("News")
		expect(sent_url()).toBe("https://postboi.email/v1/lists")
		expect(sent_json()).toEqual({ name: "News" })

		await provider().lists.rename("l1", "Newsletter")
		expect(sent_init().method).toBe("PATCH")
		expect(sent_json()).toEqual({ name: "Newsletter" })

		await provider().lists.delete("l1")
		expect(sent_url()).toBe("https://postboi.email/v1/lists/l1")
		expect(sent_init().method).toBe("DELETE")
	})

	it("adds and removes list recipients", async () => {
		fetch.mockResolvedValue(respond({ json: { added: 2 } }))
		const added = await provider().recipients.add("l1", [
			{ email: "a@test.com", name: "Ada", data: { name: "Ada" } },
			{ email: "b@test.com" },
		])
		expect(sent_url()).toBe("https://postboi.email/v1/lists/l1/recipients")
		expect(sent_json()).toHaveLength(2)
		expect(added).toEqual({ added: 2 })

		await provider().recipients.remove("l1", "a+b@test.com")
		expect(sent_url()).toBe("https://postboi.email/v1/lists/l1/recipients?email=a%2Bb%40test.com")
		expect(sent_init().method).toBe("DELETE")
	})

	it("recipients.add takes to-style recipients and a list name", async () => {
		fetch.mockResolvedValue(
			respond({ json: { added: 1, updated: 0, list: { id: "l1", name: "my list" } } })
		)
		await provider().recipients.add("my list", "Acme Inc <hello@acme.example>")
		expect(sent_url()).toBe("https://postboi.email/v1/lists/my%20list/recipients")
		expect(sent_json()).toEqual([{ email: "hello@acme.example", name: "Acme Inc" }])

		await provider().recipients.add("l1", [
			"a@test.com",
			{ email: "b@test.com", data: { plan: "pro" } },
		])
		expect(sent_json()).toEqual([
			{ email: "a@test.com" },
			{ email: "b@test.com", data: { plan: "pro" } },
		])
	})

	it("lists.update toggles confirmation and renames; lists.create takes options", async () => {
		fetch.mockResolvedValue(
			respond({ json: { id: "l1", name: "my list", confirmation: { enabled: true } } })
		)
		await provider().lists.update("my list", { confirmation: true })
		expect(sent_url()).toBe("https://postboi.email/v1/lists/my%20list")
		expect(sent_init().method).toBe("PATCH")
		expect(sent_json()).toEqual({ confirmation: true })

		await provider().lists.update("l1", {
			name: "News",
			confirmation: { enabled: true, from: "Bot <bot@test.com>" },
		})
		expect(sent_json()).toEqual({
			name: "News",
			confirmation: { enabled: true, from: { email: "bot@test.com", name: "Bot" } },
		})

		await provider().lists.create("Fresh", { confirmation: true })
		expect(sent_url()).toBe("https://postboi.email/v1/lists")
		expect(sent_json()).toEqual({ name: "Fresh", confirmation: true })
	})

	it("manages notifications: create with shorthand schedule, list, update, delete", async () => {
		fetch.mockResolvedValue(
			respond({ json: { id: "ntf_1", schedule: { frequency: "subscribe" } } })
		)
		await provider().notifications.create("my list", {
			recipients: "Darby <darby@uilo.co>",
			schedule: "subscribe",
		})
		expect(sent_url()).toBe("https://postboi.email/v1/lists/my%20list/notifications")
		expect(sent_json()).toEqual({
			recipients: [{ email: "darby@uilo.co", name: "Darby" }],
			schedule: "subscribe",
		})

		fetch.mockResolvedValue(respond({ json: { notifications: [{ id: "ntf_1" }] } }))
		const rows = await provider().notifications.all("my list")
		expect(sent_init().method).toBe("GET")
		expect(rows).toEqual([{ id: "ntf_1" }])

		fetch.mockResolvedValue(respond({ json: { id: "ntf_1" } }))
		await provider().notifications.update("l1", "ntf_1", {
			schedule: { frequency: "weekly", days: [1, 4], send_time: "17:30" },
		})
		expect(sent_url()).toBe("https://postboi.email/v1/lists/l1/notifications/ntf_1")
		expect(sent_init().method).toBe("PATCH")
		expect(sent_json().schedule).toEqual({ frequency: "weekly", days: [1, 4], send_time: "17:30" })
		expect(sent_json().recipients).toBeUndefined()

		fetch.mockResolvedValue(respond({ json: { id: "ntf_1", deleted: true } }))
		await provider().notifications.delete("l1", "ntf_1")
		expect(sent_init().method).toBe("DELETE")
	})

	it("broadcast() maps body → html and normalizes addresses", async () => {
		fetch.mockResolvedValue(respond({ json: { ids: ["m1"], recipients: 1, scheduled_at: "now" } }))
		await provider().lists.broadcast("l1", {
			from: "Ada <ada@test.com>",
			subject: "Hey {name}",
			body: "<p>Hi {name}</p>",
		})
		expect(sent_url()).toBe("https://postboi.email/v1/lists/l1/send")
		const body = sent_json()
		expect(body.from).toEqual({ email: "ada@test.com", name: "Ada" })
		expect(body.html).toBe("<p>Hi {name}</p>")
		expect(body.body).toBeUndefined()
	})

	it("manages suppressions", async () => {
		fetch.mockResolvedValue(respond({ json: { suppressions: [{ email: "x@test.com" }] } }))
		const rows = await provider().suppressions.all()
		expect(sent_url()).toBe("https://postboi.email/v1/suppressions")
		expect(rows).toEqual([{ email: "x@test.com" }])

		await provider().suppressions.add("x@test.com")
		expect(sent_json()).toEqual({ email: "x@test.com" })

		await provider().suppressions.remove("x@test.com")
		expect(sent_url()).toBe("https://postboi.email/v1/suppressions?email=x%40test.com")
		expect(sent_init().method).toBe("DELETE")
	})

	it("normalizes API errors from account methods", async () => {
		fetch.mockResolvedValue(
			respond({ ok: false, status: 404, json: { message: "No message.", code: "not_found" } })
		)
		const error = await provider()
			.messages.get("missing")
			.catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.code).toBe("not_found")
		expect(error.status).toBe(404)
	})
})

describe("top-level mail() — provider-agnostic dispatch", () => {
	it("dispatches to whichever provider POSTBOI_PROVIDER names", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "resend")
		vi.stubEnv("RESEND_API_KEY", "re_123")
		vi.stubEnv("POSTBOI_FROM", "from@test.com")
		fetch.mockResolvedValue(respond({ json: { id: "re-1" } }))

		const result = await mail({ to: "to@test.com", subject: "Hi", body: "<p>x</p>" })

		expect(sent_url()).toBe("https://api.resend.com/emails")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer re_123" })
		const body = sent_json()
		expect(body.from).toBe("from@test.com")
		expect(body.to).toEqual(["to@test.com"])
		expect(result).toEqual({ id: "re-1" })
	})

	it("passes provider-specific fields (e.g. Mailgun domain) through", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "mailgun")
		vi.stubEnv("MAILGUN_API_KEY", "key-abc")
		vi.stubEnv("MAILGUN_DOMAIN", "mg.example.com")
		vi.stubEnv("POSTBOI_FROM", "from@test.com")
		fetch.mockResolvedValue(respond({ json: { id: "<mg-1>" } }))

		await mail({ to: "to@test.com", subject: "Hi", body: "<p>x</p>" })

		expect(sent_url()).toContain("mg.example.com")
	})

	it("supports the array (bulk) form", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "resend")
		vi.stubEnv("RESEND_API_KEY", "re_123")
		vi.stubEnv("POSTBOI_FROM", "from@test.com")
		fetch.mockResolvedValue(respond({ json: { id: "x" } }))

		const results = await mail([
			{ to: "a@test.com", body: "x" },
			{ to: "b@test.com", body: "x" },
		])
		expect(results.every((r) => r.ok)).toBe(true)
		expect(results).toHaveLength(2)
	})

	it("falls back to the Postboi provider when only POSTBOI_TOKEN is set", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "")
		vi.stubEnv("POSTBOI_TOKEN", "pb_zero_config")
		vi.stubEnv("POSTBOI_FROM", "from@test.com")
		fetch.mockResolvedValue(respond({ json: { id: "cloud-1" } }))

		const result = await mail({ to: "to@test.com", subject: "Hi", body: "<p>x</p>" })

		expect(sent_url()).toBe("https://postboi.email/v1/send")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer pb_zero_config" })
		expect(result).toEqual({ id: "cloud-1" })
	})

	it("throws a friendly PostboiError when no provider is configured", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "")
		const error = await mail({ to: "to@test.com", body: "x" }).catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.code).toBe("no_provider")
		expect(error.message).toMatch(/postboi init/)
		expect(fetch).not.toHaveBeenCalled()
	})

	it("throws when the provider's required env var is missing", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "resend")
		vi.stubEnv("RESEND_API_KEY", "")
		const error = await mail({ to: "to@test.com", body: "x" }).catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.code).toBe("missing_env")
		expect(error.message).toMatch(/RESEND_API_KEY/)
		expect(fetch).not.toHaveBeenCalled()
	})

	it("re-exports is_error from the root", () => {
		expect(is_error(new PostboiError({ provider: "postboi", message: "x" }))).toBe(true)
		expect(is_error(new Error("nope"))).toBe(false)
	})
})
