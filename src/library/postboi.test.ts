import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Postboi, {
	escape_html,
	mail,
	is_error,
	PostboiError,
	SkipSendError,
} from "$library/postboi.js"

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

beforeEach(() => {
	fetch.mockReset()
	// No inbox unless a test asks for one. Discovery falls back to
	// node_modules/.postboi/inbox.json, which a dev server on this machine leaves behind —
	// so without this the dev-mail tests deliver to a port from last week and see a `fetch`
	// they assert never happens. Passing on CI and failing on a laptop is the worst way for
	// a test to be wrong. Tests that want an inbox stub their own port inside the test body,
	// which runs after this and wins.
	vi.stubEnv("POSTBOI_INBOX", "off")
})
afterEach(() => vi.unstubAllEnvs())

describe("the Postboi provider (zero-config)", () => {
	it("auto-reads POSTBOI_TOKEN from the environment", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "pb_live_123")
		fetch.mockResolvedValue(respond({ json: { id: "abc" } }))

		const provider = new Postboi({ default: { from: "from@test.com" } })
		const result = await provider.send({ to: "to@test.com", subject: "Hi", body: "<p>x</p>" })

		expect(sent_url()).toBe("https://postboi.app/v1/send")
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

	it("sends the submission's fields as data beside the rendered table", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		const form = new FormData()
		form.append("_subject", "Quote")
		form.append("_honey", "")
		form.append("name", "Ada")
		form.append("interest", "web")
		form.append("interest", "print")
		await new Postboi().send({ to: "to@test.com", body: form })

		const body = sent_json()
		expect(body.subject).toBe("Quote")
		expect(body.html).toContain("Ada")
		// the table's source, in order — specials and the honeypot never appear in it
		expect(body.fields).toEqual([
			["name", "Ada"],
			["interest", "web"],
			["interest", "print"],
		])
	})

	it("names the form on the wire, on FormData and string bodies alike", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		const form = new FormData()
		form.append("name", "Ada")
		await new Postboi().send({ to: "to@test.com", body: form, form: "Home Ownership Query" })
		expect(sent_json().form).toBe("Home Ownership Query")

		// a hand-rolled body can still be filed under a form — and is a form send for captcha
		await new Postboi().send({ to: "to@test.com", body: "<p>x</p>", form: "form_abc123" })
		const body = sent_json()
		expect(body.form).toBe("form_abc123")
		expect(body.fields).toBeUndefined()
	})

	it("asks for the letterhead only when told to, and hands it the unsubscribe link", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		await new Postboi().send({ to: "to@test.com", body: "<p>x</p>" })
		expect(sent_json().letterhead).toBeUndefined()

		await new Postboi().send({
			to: "to@test.com",
			body: "<p>x</p>",
			letterhead: true,
			unsubscribe_url: "https://postboi.app/u/abc",
		})
		const body = sent_json()
		expect(body.letterhead).toBe(true)
		// What the API fills a footer's {unsubscribe_url} from.
		expect(body.headers["List-Unsubscribe"]).toBe("<https://postboi.app/u/abc>")
	})

	it("asks for the shell and the cut it is set in, and neither by default", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		await new Postboi().send({ to: "to@test.com", body: "<p>x</p>" })
		expect(sent_json().shell).toBeUndefined()
		expect(sent_json().style).toBeUndefined()

		await new Postboi().send({
			to: "to@test.com",
			body: "<p>x</p>",
			letterhead: true,
			shell: true,
			style: "plain",
		})
		const body = sent_json()
		expect(body.shell).toBe(true)
		// One cut for everything the send asks to be drawn — never one each.
		expect(body.style).toBe("plain")
		expect(body.letterhead).toBe(true)
	})

	it("string bodies carry no captcha fields", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		await new Postboi().send({ to: "to@test.com", body: "<p>x</p>" })
		const body = sent_json()
		expect(body.form).toBeUndefined()
		expect(body.captcha_token).toBeUndefined()
		expect(body.fields).toBeUndefined()
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

	it("gives each batch recipient its own idempotency key, derived from the batch's", async () => {
		fetch.mockResolvedValue(respond({ json: { ids: ["m1", "m2"] } }))

		await new Postboi({ token: "t" }).send({
			to: ["a@test.com", "b@test.com"],
			subject: "Hi",
			body: "x",
			data: { "a@test.com": {}, "b@test.com": {} },
			idempotency_key: "order-42",
		})

		// One key names one message, so the batch's key can't be sent as-is on every
		// item — the API rejects a batch whose items share a key.
		const body = sent_json()
		expect(body.map((item: { idempotency_key?: string }) => item.idempotency_key)).toEqual([
			"order-42:0",
			"order-42:1",
		])
		// And no whole-batch header, which would have to name a hundred messages at once.
		expect(sent_init().headers).not.toHaveProperty("Idempotency-Key")
	})

	it("derives the same keys on a retry, even if a recipient drops out", async () => {
		fetch.mockResolvedValue(respond({ json: { ids: ["m1", "m2"] } }))

		await new Postboi({
			token: "t",
			hooks: {
				// A hook skips the middle recipient — on a retry it might skip a different
				// one, and the survivors' keys must not shift onto each other's messages.
				before: {
					send: (ctx) => {
						if (String(ctx.message.to).includes("b@test.com")) throw new SkipSendError("skip")
					},
				},
			},
		}).send({
			to: ["a@test.com", "b@test.com", "c@test.com"],
			subject: "Hi",
			body: "x",
			data: { "a@test.com": {}, "b@test.com": {}, "c@test.com": {} },
			idempotency_key: "order-42",
		})

		const body = sent_json()
		expect(body.map((item: { idempotency_key?: string }) => item.idempotency_key)).toEqual([
			"order-42:0",
			"order-42:2",
		])
	})

	it("refuses a base key too long to carry a suffix, rather than sending a truncated one", async () => {
		fetch.mockResolvedValue(respond({ json: { ids: ["m1", "m2"] } }))

		const results = await new Postboi({ token: "t" }).send({
			to: ["a@test.com", "b@test.com"],
			subject: "Hi",
			body: "x",
			data: { "a@test.com": {}, "b@test.com": {} },
			idempotency_key: "x".repeat(256),
		})

		expect(results.every((r) => !r.ok)).toBe(true)
		expect(String((results[0] as { error: Error }).error.message)).toContain("too long for a batch")
		expect(fetch).not.toHaveBeenCalled()
	})

	it("sends no key at all when the batch was given none", async () => {
		fetch.mockResolvedValue(respond({ json: { ids: ["m1"] } }))
		await new Postboi({ token: "t" }).send({
			to: ["a@test.com"],
			subject: "Hi",
			body: "x",
			data: { "a@test.com": {} },
		})
		expect(sent_json()[0].idempotency_key).toBeUndefined()
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
		expect(sent_url()).toBe("https://postboi.app/v1/send/batch")
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
		expect(sent_url()).toBe("https://postboi.app/v1/messages/m1")
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
		expect(sent_url()).toBe("https://postboi.app/v1/messages/m1")
		expect(sent_init().method).toBe("PATCH")
		expect(sent_json()).toEqual({ scheduled_at: "2026-07-02T00:00:00.000Z" })
		expect(moved.scheduled_at).toBe("2026-07-02T00:00:00.000Z")
		vi.useRealTimers()
	})

	it("clamps month arithmetic to the target month's last day", async () => {
		vi.useFakeTimers()
		// Jan 31 + 1 month must land in February, not overflow setMonth into March 3.
		vi.setSystemTime(new Date("2026-01-31T12:00:00Z"))
		fetch.mockResolvedValue(respond({ json: { id: "m1", scheduled_at: "x" } }))

		await provider().messages.reschedule("m1", { months: 1 })
		const body = sent_json() as { scheduled_at: string }
		expect(body.scheduled_at.startsWith("2026-02-28")).toBe(true)
		vi.useRealTimers()
	})

	it("lists() unwraps the lists array", async () => {
		fetch.mockResolvedValue(respond({ json: { lists: [{ id: "l1", name: "News" }] } }))
		const lists = await provider().lists.all()
		expect(sent_url()).toBe("https://postboi.app/v1/lists")
		expect(lists).toEqual([{ id: "l1", name: "News" }])
	})

	it("creates, renames and deletes lists", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "l1", name: "News" } }))
		await provider().lists.create("News")
		expect(sent_url()).toBe("https://postboi.app/v1/lists")
		expect(sent_json()).toEqual({ name: "News" })

		await provider().lists.rename("l1", "Newsletter")
		expect(sent_init().method).toBe("PATCH")
		expect(sent_json()).toEqual({ name: "Newsletter" })

		await provider().lists.delete("l1")
		expect(sent_url()).toBe("https://postboi.app/v1/lists/l1")
		expect(sent_init().method).toBe("DELETE")
	})

	it("adds and removes list recipients", async () => {
		fetch.mockResolvedValue(respond({ json: { added: 2 } }))
		const added = await provider().recipients.add("l1", [
			{ email: "a@test.com", name: "Ada", data: { name: "Ada" } },
			{ email: "b@test.com" },
		])
		expect(sent_url()).toBe("https://postboi.app/v1/lists/l1/recipients")
		expect(sent_json()).toHaveLength(2)
		expect(added).toEqual({ added: 2 })

		await provider().recipients.remove("l1", "a+b@test.com")
		expect(sent_url()).toBe("https://postboi.app/v1/lists/l1/recipients?email=a%2Bb%40test.com")
		expect(sent_init().method).toBe("DELETE")
	})

	it("recipients.add takes to-style recipients and a list name", async () => {
		fetch.mockResolvedValue(
			respond({ json: { added: 1, updated: 0, list: { id: "l1", name: "my list" } } })
		)
		await provider().recipients.add("my list", "Acme Inc <hello@acme.example>")
		expect(sent_url()).toBe("https://postboi.app/v1/lists/my%20list/recipients")
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

	it("recipients.all returns a list's members via lists.get", async () => {
		fetch.mockResolvedValue(
			respond({ json: { id: "l1", name: "News", recipients: [{ email: "a@test.com" }] } })
		)
		const members = await provider().recipients.all("News")
		expect(sent_url()).toBe("https://postboi.app/v1/lists/News")
		expect(members).toEqual([{ email: "a@test.com" }])
	})

	it("contacts: upsert, get, update, remove, lists", async () => {
		fetch.mockResolvedValue(respond({ json: { email: "ada@test.com", name: "Ada" } }))
		await provider().contacts.add("ada@test.com", { name: "Ada", data: { plan: "pro" } })
		expect(sent_url()).toBe("https://postboi.app/v1/contacts")
		expect(sent_init().method).toBe("POST")
		expect(sent_json()).toEqual({ email: "ada@test.com", name: "Ada", data: { plan: "pro" } })

		// The delivery profile: a phone rides along on add and update, and null clears it.
		await provider().contacts.add("ada@test.com", { phone: "+447788223344" })
		expect(sent_json()).toEqual({ email: "ada@test.com", phone: "+447788223344" })
		await provider().contacts.update("ada@test.com", { phone: null })
		expect(sent_json()).toEqual({ phone: null })

		await provider().contacts.get("a+b@test.com")
		expect(sent_url()).toBe("https://postboi.app/v1/contacts/a%2Bb%40test.com")
		expect(sent_init().method).toBe("GET")

		await provider().contacts.update("ada@test.com", { data: null })
		expect(sent_init().method).toBe("PATCH")
		expect(sent_json()).toEqual({ data: null })

		await provider().contacts.remove("ada@test.com")
		expect(sent_url()).toBe("https://postboi.app/v1/contacts/ada%40test.com")
		expect(sent_init().method).toBe("DELETE")

		fetch.mockResolvedValue(
			respond({ json: { email: "ada@test.com", lists: [{ status: "subscribed" }] } })
		)
		const lists = await provider().contacts.lists("ada@test.com")
		expect(sent_url()).toBe("https://postboi.app/v1/contacts/ada%40test.com/lists")
		expect(lists).toEqual([{ status: "subscribed" }])
	})

	it("suppressions: an email is a string, a number is per channel", async () => {
		fetch.mockResolvedValue(respond({ json: { suppressions: [] } }))
		await provider().suppressions.all()
		expect(sent_url()).toBe("https://postboi.app/v1/suppressions")
		await provider().suppressions.all({ channel: "sms" })
		expect(sent_url()).toBe("https://postboi.app/v1/suppressions?channel=sms")

		fetch.mockResolvedValue(respond({ json: { suppressed: true } }))
		await provider().suppressions.add("noisy@test.com")
		expect(sent_init().method).toBe("POST")
		expect(sent_json()).toEqual({ email: "noisy@test.com" })
		await provider().suppressions.add({ phone: "+447788223344" })
		expect(sent_json()).toEqual({ phone: "+447788223344", channel: "sms" })
		await provider().suppressions.add({ phone: "+447788223344", channel: "whatsapp" })
		expect(sent_json()).toEqual({ phone: "+447788223344", channel: "whatsapp" })

		fetch.mockResolvedValue(respond({ json: { deleted: true } }))
		await provider().suppressions.remove("noisy@test.com")
		expect(sent_url()).toBe("https://postboi.app/v1/suppressions?email=noisy%40test.com")
		expect(sent_init().method).toBe("DELETE")
		await provider().suppressions.remove({ phone: "+447788223344", channel: "whatsapp" })
		expect(sent_url()).toBe(
			"https://postboi.app/v1/suppressions?phone=%2B447788223344&channel=whatsapp"
		)
	})

	it("contacts.all follows the cursor and unwraps contacts", async () => {
		fetch
			.mockResolvedValueOnce(
				respond({ json: { contacts: [{ email: "a@test.com" }], cursor: "c1" } })
			)
			.mockResolvedValueOnce(
				respond({ json: { contacts: [{ email: "b@test.com" }], cursor: null } })
			)
		const all = await provider().contacts.all({ list: "News", status: "subscribed" })
		expect(fetch).toHaveBeenCalledTimes(2)
		expect(all).toEqual([{ email: "a@test.com" }, { email: "b@test.com" }])
		// First page carries the filters; the second appends the cursor.
		expect(fetch.mock.calls[0][0]).toBe(
			"https://postboi.app/v1/contacts?list=News&status=subscribed"
		)
		expect(fetch.mock.calls[1][0]).toBe(
			"https://postboi.app/v1/contacts?list=News&status=subscribed&cursor=c1"
		)
	})

	it("contacts.all passes a search term", async () => {
		fetch.mockResolvedValueOnce(respond({ json: { contacts: [], cursor: null } }))
		await provider().contacts.all({ search: "ada lovelace" })
		expect(sent_url()).toBe("https://postboi.app/v1/contacts?search=ada+lovelace")
	})

	it("lists.update toggles confirmation and renames; lists.create takes options", async () => {
		fetch.mockResolvedValue(
			respond({ json: { id: "l1", name: "my list", confirmation: { enabled: true } } })
		)
		await provider().lists.update("my list", { confirmation: true })
		expect(sent_url()).toBe("https://postboi.app/v1/lists/my%20list")
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
		expect(sent_url()).toBe("https://postboi.app/v1/lists")
		expect(sent_json()).toEqual({ name: "Fresh", confirmation: true })
	})

	it("lists forms, and manages scheduled exports", async () => {
		fetch.mockResolvedValue(respond({ json: { forms: [{ id: "form_1", name: "Contact" }] } }))
		expect(await provider().forms.all()).toEqual([{ id: "form_1", name: "Contact" }])
		expect(sent_url()).toBe("https://postboi.app/v1/forms")
		expect(sent_init().method).toBe("GET")

		fetch.mockResolvedValue(respond({ json: { id: "sxp_1" } }))
		await provider().exports.create({
			name: "Weekly",
			recipients: "Ops <ops@acme.com>",
			filter: { form: "Contact", status: "delivered" },
			schedule: "weekly",
		})
		expect(sent_url()).toBe("https://postboi.app/v1/exports")
		expect(sent_json()).toEqual({
			name: "Weekly",
			recipients: [{ email: "ops@acme.com", name: "Ops" }],
			filter: { form: "Contact", status: "delivered" },
			schedule: "weekly",
		})

		fetch.mockResolvedValue(respond({ json: { id: "sxp_1", paused: true } }))
		await provider().exports.update("sxp_1", { paused: true, from: null })
		expect(sent_init().method).toBe("PATCH")
		expect(sent_json()).toEqual({ paused: true, from: null })

		fetch.mockResolvedValue(respond({ json: { id: "sxp_1", queued: true } }))
		expect(await provider().exports.run("sxp_1")).toEqual({ id: "sxp_1", queued: true })
		expect(sent_url()).toBe("https://postboi.app/v1/exports/sxp_1/run")

		fetch.mockResolvedValue(respond({ json: { exports: [{ id: "sxp_1" }] } }))
		expect(await provider().exports.all()).toEqual([{ id: "sxp_1" }])

		fetch.mockResolvedValue(respond({ json: { id: "sxp_1", deleted: true } }))
		await provider().exports.delete("sxp_1")
		expect(sent_init().method).toBe("DELETE")
		expect(sent_url()).toBe("https://postboi.app/v1/exports/sxp_1")
	})

	it("downloads an export now: the filter as a query string, the file as bytes and text", async () => {
		const csv = "\uFEFFSent at,Subject\r\n2026-09-12T08:00:00.000Z,Query\r\n"
		fetch.mockResolvedValue(
			new Response(csv, {
				status: 200,
				headers: {
					"Content-Type": "text/csv; charset=utf-8",
					"Content-Disposition": 'attachment; filename="acme-messages.csv"',
				},
			})
		)
		const file = await provider().exports.download({
			filter: { form: "Contact", status: ["delivered", "bounced"], since: "2026-09-01" },
			columns: ["created_at", "subject"],
			fields: false,
		})
		expect(sent_url()).toBe(
			"https://postboi.app/v1/exports/download?form=Contact&since=2026-09-01&status=delivered%2Cbounced&columns=created_at%2Csubject&fields=0"
		)
		expect(sent_init().method).toBe("GET")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer t" })
		expect(file.filename).toBe("acme-messages.csv")
		expect(file.type).toContain("text/csv")
		expect(file.text()).toBe(csv.slice(1)) // decoded, minus the BOM
		expect(file.bytes.length).toBe(new TextEncoder().encode(csv).length)

		// no options at all is the whole log, with no query string
		fetch.mockResolvedValue(new Response("", { status: 200 }))
		const bare = await provider().exports.download()
		expect(sent_url()).toBe("https://postboi.app/v1/exports/download")
		expect(bare.filename).toBe("export.csv")

		// a refusal is the API's own message and code
		fetch.mockResolvedValue(
			new Response(
				JSON.stringify({ message: "No form with that name.", code: "invalid_request" }),
				{
					status: 400,
				}
			)
		)
		await expect(provider().exports.download({ filter: { form: "Nope" } })).rejects.toThrow(
			"No form with that name."
		)
	})

	it("manages notifications: create with shorthand schedule, list, update, delete", async () => {
		fetch.mockResolvedValue(
			respond({ json: { id: "ntf_1", schedule: { frequency: "subscribe" } } })
		)
		await provider().notifications.create("my list", {
			recipients: "Darby <darby@uilo.co>",
			schedule: "subscribe",
		})
		expect(sent_url()).toBe("https://postboi.app/v1/lists/my%20list/notifications")
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
		expect(sent_url()).toBe("https://postboi.app/v1/lists/l1/notifications/ntf_1")
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
		expect(sent_url()).toBe("https://postboi.app/v1/lists/l1/send")
		const body = sent_json()
		expect(body.from).toEqual({ email: "ada@test.com", name: "Ada" })
		expect(body.html).toBe("<p>Hi {name}</p>")
		expect(body.body).toBeUndefined()
	})

	it("manages suppressions", async () => {
		fetch.mockResolvedValue(respond({ json: { suppressions: [{ email: "x@test.com" }] } }))
		const rows = await provider().suppressions.all()
		expect(sent_url()).toBe("https://postboi.app/v1/suppressions")
		expect(rows).toEqual([{ email: "x@test.com" }])

		await provider().suppressions.add("x@test.com")
		expect(sent_json()).toEqual({ email: "x@test.com" })

		await provider().suppressions.remove("x@test.com")
		expect(sent_url()).toBe("https://postboi.app/v1/suppressions?email=x%40test.com")
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

		expect(sent_url()).toBe("https://postboi.app/v1/send")
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

	it("logs instead of sending when NODE_ENV=development and nothing is configured", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "")
		vi.stubEnv("POSTBOI_TOKEN", "")
		vi.stubEnv("POSTBOI_FROM", "from@test.com")
		vi.stubEnv("NODE_ENV", "development")
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const result = await mail({ to: "to@test.com", subject: "Sign in", body: "<p>link</p>" })

		expect(fetch).not.toHaveBeenCalled()
		expect(result).toMatchObject({ id: "mock-1" })
		// The body must survive to the terminal — it is the reason to read a dev mail at all.
		expect(log.mock.calls.at(-1)![0]).toMatch(/Sign in[\s\S]*link/)
		expect(warn.mock.calls.at(-1)![0]).toMatch(/logging mail to the console/)
		log.mockRestore()
		warn.mockRestore()
	})

	it("logs when a token is missing but the config names the postboi provider", async () => {
		vi.stubEnv("POSTBOI_PROVIDER", "postboi")
		vi.stubEnv("POSTBOI_TOKEN", "")
		vi.stubEnv("POSTBOI_FROM", "from@test.com")
		vi.stubEnv("NODE_ENV", "development")
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "warn").mockImplementation(() => {})

		await mail({ to: "to@test.com", subject: "Hi", body: "x" })

		expect(fetch).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalled()
		vi.restoreAllMocks()
	})

	it("still throws without a token outside development", async () => {
		for (const node_env of ["production", "staging", ""]) {
			vi.stubEnv("POSTBOI_PROVIDER", "postboi")
			vi.stubEnv("POSTBOI_TOKEN", "")
			vi.stubEnv("NODE_ENV", node_env)

			const error = await mail({ to: "to@test.com", body: "x" }).catch((e) => e)

			expect(error, `NODE_ENV=${node_env} must not silently log`).toBeInstanceOf(PostboiError)
			expect(error.code).toBe("no_token")
			expect(fetch).not.toHaveBeenCalled()
		}
	})

	it("logs when the mock is chosen explicitly, in any environment", async () => {
		// Choosing the mock is choosing not to send — printing is the only way to observe it.
		for (const node_env of ["development", "production", ""]) {
			vi.stubEnv("POSTBOI_PROVIDER", "mock")
			vi.stubEnv("POSTBOI_FROM", "from@test.com")
			vi.stubEnv("NODE_ENV", node_env)
			const log = vi.spyOn(console, "log").mockImplementation(() => {})

			await mail({ to: "to@test.com", subject: "Explicit mock", body: "x" })

			expect(log.mock.calls.at(-1)![0], `NODE_ENV=${node_env}`).toMatch(/Explicit mock/)
			expect(fetch).not.toHaveBeenCalled()
			log.mockRestore()
		}
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

describe("the dev inbox", () => {
	/** Configure a real, fully-credentialled provider — the case interception has to beat. */
	function configure_real_provider() {
		vi.stubEnv("POSTBOI_PROVIDER", "")
		vi.stubEnv("POSTBOI_TOKEN", "pb_live_token")
		vi.stubEnv("POSTBOI_FROM", "from@test.com")
	}

	beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}))
	afterEach(() => vi.restoreAllMocks())

	it("captures mail that a configured provider would otherwise have sent for real", async () => {
		configure_real_provider()
		vi.stubEnv("NODE_ENV", "development")
		vi.stubEnv("POSTBOI_INBOX", "4599")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		await mail({ to: "to@test.com", subject: "Local only", body: "<p>x</p>" })

		// The one thing that must never happen in dev: a real send to a real address.
		expect(sent_url()).toBe("http://127.0.0.1:4599/__postboi/api/messages")
		expect(sent_json()).toMatchObject({ subject: "Local only" })
	})

	it("never intercepts outside development, however loudly the env asks", async () => {
		for (const node_env of ["production", "staging", ""]) {
			configure_real_provider()
			vi.stubEnv("NODE_ENV", node_env)
			vi.stubEnv("POSTBOI_INBOX", "4599")
			fetch.mockResolvedValue(respond({ json: { id: "cloud-1" } }))

			await mail({ to: "to@test.com", subject: "Real", body: "<p>x</p>" })

			expect(sent_url(), `NODE_ENV=${node_env}`).toBe("https://postboi.app/v1/send")
		}
	})

	it("sends for real when POSTBOI_INBOX is off", async () => {
		configure_real_provider()
		vi.stubEnv("NODE_ENV", "development")
		vi.stubEnv("POSTBOI_INBOX", "off")
		fetch.mockResolvedValue(respond({ json: { id: "cloud-1" } }))

		await mail({ to: "to@test.com", subject: "Real", body: "<p>x</p>" })

		expect(sent_url()).toBe("https://postboi.app/v1/send")
	})

	it("stands in front of sending only — lists still reach the real API", async () => {
		configure_real_provider()
		vi.stubEnv("NODE_ENV", "development")
		vi.stubEnv("POSTBOI_INBOX", "4599")
		fetch.mockResolvedValue(respond({ json: { lists: [] } }))

		await mail.lists.all()

		expect(sent_url()).toBe("https://postboi.app/v1/lists")
	})

	// The stopped-inbox fallback lives in inbox.test.ts instead, against a socket that has
	// genuinely been closed — a truer test than a rejecting fetch mock, and it stays clear of
	// this file's mocked-fetch setup.
})

describe("escape_html", () => {
	it("is reachable from the package root for hand-rolled HTML bodies", () => {
		// the FormData table escapes itself; this is for callers interpolating user
		// input into their own `body` string, so they don't reinvent it badly
		expect(escape_html('<a href="x">hi</a>')).toBe("&lt;a href=&quot;x&quot;&gt;hi&lt;/a&gt;")
	})
})
