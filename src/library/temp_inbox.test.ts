import { describe, it, expect, afterEach } from "vitest"
import {
	temp,
	Inbox,
	InboxError,
	InboxTimeoutError,
	duration_ms,
	filter_mail,
} from "./temp_inbox.js"
import { PostboiError } from "./errors.js"
import { fake_tempboi } from "../testing/fake_tempboi.js"

const ENV = ["POSTBOI_INBOX", "POSTBOI_INBOX_TOKEN", "POSTBOI_INBOX_URL", "POSTBOI_TOKEN"]
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]))
afterEach(() => {
	for (const key of ENV) {
		if (saved[key] === undefined) delete process.env[key]
		else process.env[key] = saved[key]
	}
})

function setup() {
	const server = fake_tempboi()
	return {
		server,
		make: (options = {}) => temp({ base: server.base, fetch: server.fetch, ...options }),
	}
}

describe("duration_ms", () => {
	it("reads the server's spellings and treats numbers as milliseconds", () => {
		expect(duration_ms("90s")).toBe(90_000)
		expect(duration_ms("15m")).toBe(900_000)
		expect(duration_ms("2h")).toBe(7_200_000)
		expect(duration_ms("1d")).toBe(86_400_000)
		expect(duration_ms("250ms")).toBe(250)
		expect(duration_ms("60")).toBe(60_000)
		expect(duration_ms(1500)).toBe(1500)
		expect(() => duration_ms("soon")).toThrow(/Invalid duration/)
	})
})

describe("filter_mail", () => {
	const mail = {
		tag: "run-1",
		from: "no-reply@acme.com",
		name: "Acme",
		subject: "Your code is 123",
	}
	it("matches strings case-insensitively and tests RegExps", () => {
		expect(filter_mail(mail, { subject: "YOUR CODE" })).toBe(true)
		expect(filter_mail(mail, { subject: /code is \d+/ })).toBe(true)
		expect(filter_mail(mail, { subject: /^Welcome/ })).toBe(false)
		expect(filter_mail(mail, { from: "acme" })).toBe(true)
		expect(filter_mail(mail, { from: /^Acme </ })).toBe(true)
		expect(filter_mail(mail, { tag: "run-1" })).toBe(true)
		expect(filter_mail(mail, { tag: "run" })).toBe(false)
	})
})

describe("temp()", () => {
	it("creates an inbox with the ttl in seconds and a name", async () => {
		const { server, make } = setup()
		const inbox = await make({ ttl: "15m", name: "signup" })
		expect(inbox).toBeInstanceOf(Inbox)
		expect(inbox.address).toBe("signup-k001@tempboi.email")
		expect(inbox.token).toMatch(/^tb_/)
		expect(inbox.expires).toBeInstanceOf(Date)
		expect(inbox.expires.getTime() - Date.now()).toBeGreaterThan(14 * 60_000)
		expect(server.requests[0]).toMatchObject({
			method: "POST",
			path: "/v1/inboxes",
			body: { name: "signup", ttl: 900 },
			auth: null,
		})
	})

	it("sends the account key for an inbox on the account's own domain", async () => {
		const { server, make } = setup()
		process.env.POSTBOI_TOKEN = "pb_live_test"
		const inbox = await make({ domain: "reply.acme.com" })
		expect(inbox.address).toMatch(/@reply\.acme\.com$/)
		expect(server.requests[0].auth).toBe("Bearer pb_live_test")
	})

	it("turns a refusal into an InboxError with the server's code", async () => {
		const { make } = setup()
		const error = await make({ name: "Not Valid!" }).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(InboxError)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error).toMatchObject({ status: 400, code: "invalid_name", provider: "tempboi" })
	})

	it("tags an address with a plus", async () => {
		const { make } = setup()
		const inbox = await make()
		expect(inbox.tag("signup")).toBe(inbox.address.replace("@", "+signup@"))
	})
})

describe("inbox.wait()", () => {
	it("sends string filters to /wait and maps the wire onto single words", async () => {
		const { server, make } = setup()
		const inbox = await make()
		setTimeout(() => {
			server.deliver(inbox.tag("signup"), {
				from: "no-reply@acme.com",
				from_name: "Acme",
				subject: "Verify your email",
				text: "Your code is 482913",
				html: "<p>Your code is <b>482913</b></p>",
				code: "482913",
				link: "https://acme.com/verify?t=1",
			})
		}, 10)
		const mail = await inbox.wait({ subject: "verify", tag: "signup", timeout: "5s" })
		const call = server.requests.find((r) => r.path.endsWith("/wait"))
		expect(call?.query).toMatchObject({ subject: "verify", tag: "signup" })
		expect(call?.auth).toBe(`Bearer ${inbox.token}`)
		expect(mail.code).toBe("482913")
		expect(mail.codes).toEqual(["482913"])
		expect(mail.link).toBe("https://acme.com/verify?t=1")
		expect(mail.name).toBe("Acme")
		expect(mail.from).toBe("no-reply@acme.com")
		expect(mail.tag).toBe("signup")
		expect(mail.html).toContain("<b>482913</b>")
		expect(mail.received).toBeInstanceOf(Date)
		expect(mail.header("subject")).toBe("Verify your email")
		expect(mail.partial).toBe(false)
		expect("from_name" in mail).toBe(false)
		expect(new TextDecoder().decode(await mail.raw())).toContain("Subject: Verify your email")
	})

	it("counts mail that already arrived unless `after` says otherwise", async () => {
		const { server, make } = setup()
		const inbox = await make()
		server.deliver(inbox.address, { subject: "Old" })
		expect((await inbox.wait({ timeout: 200 })).subject).toBe("Old")
		const cursor = (await inbox.info()).cursor
		expect(cursor).toBe(1)
		setTimeout(() => server.deliver(inbox.address, { subject: "New" }), 10)
		expect((await inbox.wait({ after: cursor, timeout: "5s" })).subject).toBe("New")
	})

	it("long-polls and tests a RegExp here, since the server only does substrings", async () => {
		const { server, make } = setup()
		const inbox = await make()
		server.deliver(inbox.address, { subject: "Welcome aboard" })
		setTimeout(() => server.deliver(inbox.address, { subject: "Your code is 1234" }), 10)
		const mail = await inbox.wait({ subject: /code is \d{4}/, timeout: "5s" })
		expect(mail.subject).toBe("Your code is 1234")
		expect(mail.partial).toBe(false)
		expect(server.requests.some((r) => r.path.endsWith("/wait"))).toBe(false)
		const polls = server.requests.filter((r) => r.path.endsWith("/messages"))
		expect(polls.length).toBeGreaterThan(0)
		expect(polls.every((r) => r.query.subject === undefined)).toBe(true)
	})

	it("rejects with an InboxTimeoutError carrying the cursor", async () => {
		const { server, make } = setup()
		const inbox = await make()
		server.deliver(inbox.address, { subject: "Something else" })
		const error = await inbox.wait({ subject: "never", timeout: 50 }).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(InboxTimeoutError)
		expect(error).toMatchObject({ code: "timeout", cursor: 1 })
		const regex_error = await inbox.wait({ subject: /never/, timeout: 50 }).catch((e: unknown) => e)
		expect(regex_error).toBeInstanceOf(InboxTimeoutError)
	})
})

describe("inbox.watch()", () => {
	it("yields only new mail by default and advances the cursor", async () => {
		const { server, make } = setup()
		const inbox = await make()
		server.deliver(inbox.address, { subject: "Before" })
		const controller = new AbortController()
		const seen: Array<string | null> = []
		setTimeout(() => {
			server.deliver(inbox.address, { subject: "One" })
			server.deliver(inbox.address, { subject: "Two" })
		}, 10)
		setTimeout(() => server.deliver(inbox.address, { subject: "Three" }), 60)
		for await (const mail of inbox.watch({ signal: controller.signal })) {
			seen.push(mail.subject)
			expect(mail.partial).toBe(false)
			if (seen.length === 3) controller.abort()
		}
		expect(seen).toEqual(["One", "Two", "Three"])
		const afters = server.requests
			.filter((r) => r.path.endsWith("/messages") && r.query.wait === "25")
			.map((r) => Number(r.query.after))
		expect(afters[0]).toBe(1)
		expect(afters).toContain(3)
		for (let i = 1; i < afters.length; i++) expect(afters[i]).toBeGreaterThanOrEqual(afters[i - 1])
	})

	it("replays what's there first with `all`, and filters", async () => {
		const { server, make } = setup()
		const inbox = await make()
		server.deliver(inbox.address, { subject: "Receipt" })
		server.deliver(inbox.address, { subject: "Code 1" })
		const controller = new AbortController()
		const seen: Array<string | null> = []
		setTimeout(() => server.deliver(inbox.address, { subject: "Code 2" }), 10)
		for await (const mail of inbox.watch({
			all: true,
			subject: /^Code/,
			signal: controller.signal,
		})) {
			seen.push(mail.subject)
			if (seen.length === 2) controller.abort()
		}
		expect(seen).toEqual(["Code 1", "Code 2"])
	})
})

describe("lifetime", () => {
	it("extends, lists and deletes", async () => {
		const { server, make } = setup()
		const inbox = await make({ ttl: "5m" })
		const later = await inbox.extend("2h")
		expect(later.getTime() - Date.now()).toBeGreaterThan(110 * 60_000)
		expect(server.requests.at(-1)).toMatchObject({ method: "PATCH", body: { ttl: 7200 } })
		server.deliver(inbox.address, { subject: "A" })
		server.deliver(inbox.address, { subject: "B" })
		const list = await inbox.list()
		expect(list.map((m) => m.subject)).toEqual(["A", "B"])
		expect(list[0].partial).toBe(true)
		expect(list[0].html).toBeNull()
		await inbox.delete()
		expect(server.inboxes.has(inbox.address)).toBe(false)
		await inbox.delete() // already gone is fine
	})

	it("deletes itself on asyncDispose", async () => {
		const { server, make } = setup()
		const inbox = await make()
		await inbox[Symbol.asyncDispose]()
		expect(server.inboxes.has(inbox.address)).toBe(false)
		expect(server.requests.at(-1)?.method).toBe("DELETE")
	})
})

describe("temp.attach()", () => {
	it("reads the address, token and base from the environment and checks the token", async () => {
		const { server, make } = setup()
		const made = await make()
		process.env.POSTBOI_INBOX = made.address
		process.env.POSTBOI_INBOX_TOKEN = made.token
		process.env.POSTBOI_INBOX_URL = server.base
		const inbox = await temp.attach({ fetch: server.fetch })
		expect(inbox.address).toBe(made.address)
		expect(inbox.expires.getTime()).toBe(made.expires.getTime())
		expect(server.requests.at(-1)).toMatchObject({ method: "GET", auth: `Bearer ${made.token}` })

		process.env.POSTBOI_INBOX_TOKEN = "tb_wrong"
		await expect(temp.attach({ fetch: server.fetch })).rejects.toMatchObject({
			code: "invalid_token",
		})
	})

	it("says what's missing", async () => {
		delete process.env.POSTBOI_INBOX
		await expect(temp.attach()).rejects.toMatchObject({ code: "missing_address" })
	})
})
