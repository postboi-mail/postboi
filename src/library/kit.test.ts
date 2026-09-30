import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { fail } from "@sveltejs/kit"
import * as v from "valibot"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { action, mail, remote, remote_form_data, webhook } from "$library/kit.js"
import Postboi from "$library/postboi_provider.js"
import { mail as send } from "$library/mail.js"
import Mock from "$library/mock.js"

// The request SvelteKit would be handling: `getRequestEvent()` answers with it inside one,
// and throws outside, as the real one does.
const request = vi.hoisted(() => ({
	event: undefined as { getClientAddress(): string } | undefined,
}))
vi.mock("$app/server", async (original) => ({
	...(await original<Record<string, unknown>>()),
	// What remote() hands SvelteKit, kept so a test can validate and submit like SvelteKit does.
	form: (validate: unknown, fn: unknown) => ({ validate, fn }),
	getRequestEvent: () => {
		if (!request.event) throw new Error("Can only read the current request event inside handle")
		return request.event
	},
}))

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
	vi.stubEnv("POSTBOI_INBOX", "off")
})
afterEach(() => {
	vi.unstubAllEnvs()
	request.event = undefined
})

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
		const result = await action(provider)(event({ _honey: "cheap pills", message: "spam" }))

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
		await action(provider, { to: "forced@test.com", subject: "Forced" })(event({ message: "hi" }))
		expect(provider.last?.to[0].address).toBe("forced@test.com")
		expect(provider.last?.subject).toBe("Forced")
		expect(provider.last?.html).toContain("hi")
	})

	it("takes form: true, so a posted _form can't pick the form", async () => {
		const provider = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		const result = await action(provider, { form: true })(event({ _form: "Made Up", name: "Ada" }))
		expect(result).toEqual({ success: true })
		expect(provider.last?.html).not.toContain("Made Up")
	})

	it("keeps `status` out of the send — it configures the failure, not the email", async () => {
		const provider = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		const result = await action(provider, { status: 422, subject: "Hi" })(event({ message: "hi" }))

		expect(result).toEqual({ success: true })
		expect(provider.last?.subject).toBe("Hi")
		expect(provider.last).not.toHaveProperty("status")
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

describe("postboi/kit action() with a resolver", () => {
	const defaults = { default: { from: "from@test.com", to: "to@test.com" } }

	it("hands the resolver the parsed post and the request, and its options win", async () => {
		const provider = new Mock(defaults)
		const seen: Array<unknown> = []
		const result = await action(provider, ({ event, data }) => {
			seen.push(event, data.get("name"))
			return {
				subject: `New enquiry from ${data.get("name")}`,
				reply_to: data.get("email") as string,
			}
		})(event({ _subject: "Posted subject", name: "Ada", email: "ada@example.com" }))

		expect(result).toEqual({ success: true })
		expect(seen[1]).toBe("Ada")
		expect(seen[0]).toHaveProperty("request")
		expect(provider.last?.subject).toBe("New enquiry from Ada")
		expect(provider.last?.reply_to?.[0].address).toBe("ada@example.com")
	})

	it("reads a field as a trimmed string, or undefined when it's missing or blank", async () => {
		const provider = new Mock(defaults)
		const seen: Array<unknown> = []
		await action(provider, ({ field }) => {
			seen.push(field("email"), field("missing"), field("blank"), field("_blok"))
			return { reply_to: field("missing") }
		})(event({ email: " ada@example.com ", blank: "  ", _blok: "b1", name: "Ada" }))

		expect(seen).toEqual(["ada@example.com", undefined, undefined, "b1"])
		// never the string "null": the default reply-to stands
		expect(provider.last?.reply_to).toBeUndefined()
		// a routing id read through field() is consumed like one read off data
		expect(provider.last?.html).not.toContain("b1")
	})

	it("reads every value of a repeated field with field.all", async () => {
		const provider = new Mock(defaults)
		const post = new FormData()
		for (const [key, value] of [
			["interest", " web "],
			["interest", ""],
			["interest", "print"],
			["cv", new File(["x"], "cv.txt")],
		] as const) {
			post.append(key, value)
		}
		const seen: Array<unknown> = []
		await action(provider, ({ field }) => {
			seen.push(field.all("interest"), field.all("missing"), field.all("cv"))
		})({ request: { formData: async () => post } } as never)
		expect(seen).toEqual([["web", "print"], [], []])
	})

	it("drops a reply-to that isn't an address, so a typo doesn't fail the form", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const provider = new Mock(defaults)
		const result = await action(provider, ({ field }) => ({ reply_to: field("email") }))(
			event({ email: "asdf", name: "Ada" })
		)
		expect(result).toEqual({ success: true })
		expect(provider.last?.reply_to).toBeUndefined()

		// in a list, only the bad one goes
		await provider.send({ body: "<p>x</p>", reply_to: ["Ada <ada@example.com>", "nope"] })
		expect(provider.last?.reply_to?.map((a) => a.address)).toEqual(["ada@example.com"])
		expect(warn.mock.calls.filter(([m]) => String(m).includes("reply-to"))).toHaveLength(1)
		warn.mockRestore()
	})

	it("passes a returned fail() straight through, without sending", async () => {
		const provider = new Mock(defaults)
		const result = await action(provider, ({ data }) =>
			data.get("email") ? {} : fail(422, { missing: "email" })
		)(event({ name: "Ada" }))

		expect(result).toMatchObject({ status: 422, data: { missing: "email" } })
		expect(provider.sent).toHaveLength(0)
	})

	it("keeps a _ field the resolver read out of the email, and only that one", async () => {
		const provider = new Mock(defaults)
		await action(provider, async ({ data }) => ({ to: await lookup(data.get("_blok")) }))(
			event({ _blok: "blok_123", _note: "left alone", name: "Ada" })
		)
		async function lookup(blok: FormDataEntryValue | null) {
			return blok === "blok_123" ? "housing@test.com" : undefined
		}

		expect(provider.last?.to[0].address).toBe("housing@test.com")
		expect(provider.last?.html).not.toContain("blok_123")
		// Unread, so it renders as before: only a consumed routing id leaves the table.
		expect(provider.last?.html).toContain("left alone")
		expect(provider.last?.html).toContain("Ada")
	})

	it("reads postboi's own fields without taking them out", async () => {
		const provider = new Mock(defaults)
		await action(provider, ({ data }) => ({ tags: [String(data.get("_subject"))] }))(
			event({ _subject: "Quote", name: "Ada" })
		)
		expect(provider.last?.subject).toBe("Quote")
	})

	it("short-circuits a filled honeypot before the resolver runs", async () => {
		const provider = new Mock(defaults)
		const resolver = vi.fn(() => ({}))
		const result = await action(provider, resolver)(event({ _honey: "cheap pills", name: "x" }))

		expect(result).toEqual({ success: true })
		expect(resolver).not.toHaveBeenCalled()
		expect(provider.sent).toHaveLength(0)
	})

	it("follows the configured honeypot, and leaves the post's own methods alone", async () => {
		const { configure, reset_config } = await import("$library/config.js")
		const provider = new Mock(defaults)
		const resolver = vi.fn(({ data }: { data: FormData }) => ({ tags: [String(data.get("_hp"))] }))
		try {
			configure({ captcha: { honeypot: "_hp" } })
			expect(await action(provider, resolver)(event({ _hp: "bot", name: "x" }))).toEqual({
				success: true,
			})
			expect(resolver).not.toHaveBeenCalled()

			// Off means off: a filled `_honey` is just a field then.
			configure({ captcha: { honeypot: false } })
			const unguarded = new Mock(defaults)
			const post = event({ _honey: "not a trap", name: "Ada" })
			await action(unguarded, resolver)(post)
			expect(resolver).toHaveBeenCalledOnce()
			expect(unguarded.sent).toHaveLength(1)
			const form = await (post as { request: Request }).request.formData()
			expect(Object.hasOwn(form, "get")).toBe(false)
		} finally {
			reset_config()
		}
	})

	it("lets the resolver swap posted URLs for attachments", async () => {
		const provider = new Mock(defaults)
		await action(provider, ({ data }) => {
			const urls = data.getAll("Images").map(String)
			data.delete("Images")
			return { attachments: urls.map((url) => new File([url], url.split("/").at(-1)!)) }
		})(event({ name: "Ada", Images: "https://cdn.test/a.jpg" }))

		expect(provider.last?.attachments.map((a) => a.name)).toEqual(["a.jpg"])
		expect(provider.last?.html).not.toContain("cdn.test")
	})

	it("treats a blank CMS string as unset, so the defaults apply", async () => {
		const provider = new Mock(defaults)
		const block = { to: "", from: "", subject: " " }
		await action(provider, () => block)(event({ name: "Ada" }))

		expect(provider.last?.to[0].address).toBe("to@test.com")
		expect(provider.last?.from.address).toBe("from@test.com")
		expect(provider.last?.subject).toBe("Mail sent from website")

		// the same on a plain send
		await provider.send({ to: "", body: "<p>x</p>" })
		expect(provider.last?.to[0].address).toBe("to@test.com")
	})

	it("types: CMS strings fit without casts", () => {
		// Compile-time only: these are the casts sites wrote around 0.56.
		function never_called(block: { to?: string; from?: string; subject?: string }, name: string) {
			void action(() => ({
				to: block.to,
				from: block.from,
				subject: block.subject,
				form: `Register Your Interest: ${name}`,
			}))
			void action({ form: "Products Order", from: block.from })
		}
		expect(typeof never_called).toBe("function")
	})
})

describe("postboi/kit remote(schema)", () => {
	/** What SvelteKit does with a remote form: validate the post against its schema, then call it. */
	async function submit(built: unknown, post: Record<string, string>) {
		const { validate, fn } = built as {
			validate: StandardSchemaV1
			fn: (value: unknown) => Promise<unknown>
		}
		const checked = await validate["~standard"].validate(post)
		if (checked.issues) return { issues: checked.issues.map((i) => i.message) }
		return fn(checked.value)
	}

	// Written for the form's own fields, with no _honey or _captcha: valibot drops them.
	const schema = v.object({
		name: v.pipe(v.string(), v.minLength(1)),
		email: v.pipe(v.string(), v.email()),
	})

	it("keeps the honeypot and the captcha token the schema doesn't declare", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ id: "1" }))
		request.event = { getClientAddress: () => "203.0.113.7" }
		const post = { name: "Ada", email: "ada@example.com", _honey: "", _captcha: "tok_1" }
		expect(await v.parseAsync(schema, post)).not.toHaveProperty("_captcha")

		const result = await submit(
			remote(new Postboi(), schema, ({ value }) => ({
				to: "team@test.com",
				reply_to: value.email,
				after: async () => ({ subscribed: true, success: false }),
			})),
			post
		)

		expect(result).toEqual({ success: true, subscribed: true })
		const sent = JSON.parse(fetch.mock.calls.at(-1)![1].body)
		expect(sent.captcha_token).toBe("tok_1")
		expect(sent.captcha_ip).toBe("203.0.113.7")
		expect(sent.reply_to).toEqual({ email: "ada@example.com" })
		expect(sent.html).not.toContain("tok_1")
	})

	it("drops a bot on the honeypot without sending or running after", async () => {
		const provider = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		const after = vi.fn()
		const result = await submit(
			remote(provider, schema, () => ({ after })),
			{
				name: "Ada",
				email: "ada@example.com",
				_honey: "cheap pills",
			}
		)
		expect(result).toEqual({ success: true })
		expect(provider.sent).toHaveLength(0)
		expect(after).not.toHaveBeenCalled()
	})

	it("leaves the schema's own issues alone", async () => {
		const provider = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		const result = await submit(remote(provider, schema), {
			name: "Ada",
			email: "nope",
			_captcha: "t",
		})
		expect(result).toHaveProperty("issues")
		expect(provider.sent).toHaveLength(0)
	})
})

describe("a hand-written mail() under SvelteKit", () => {
	it("passes the visitor's IP to Turnstile, as action() does", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ id: "1" }))
		request.event = { getClientAddress: () => "203.0.113.7" }

		const body = new FormData()
		body.append("name", "Ada")
		await send({ to: "to@test.com", body })
		expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).captcha_ip).toBe("203.0.113.7")

		// an explicit remoteip still wins
		await send({ to: "to@test.com", body: new FormData(), captcha: { remoteip: "198.51.100.1" } })
		expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).captcha_ip).toBe("198.51.100.1")
	})

	it("is a no-op outside a request", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "t")
		fetch.mockResolvedValue(respond({ id: "1" }))
		await send({ to: "to@test.com", body: new FormData() })
		expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).captcha_ip).toBeUndefined()
	})
})

describe("postboi/kit outside Vite", () => {
	const root = fileURLToPath(new URL("../../", import.meta.url))

	it("resolves to a build that never imports $app/server", () => {
		const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"))
		expect(pkg.exports["./kit"].svelte).toBe("./dist/kit.js")
		expect(pkg.exports["./kit"].default).toBe("./dist/kit_base.js")
		// kit.js exists only to hand $app/server over. Every export it has is kit_base's, so
		// without this a bundler drops it as unused and remote() finds no SvelteKit.
		expect(pkg.sideEffects).toContain("./dist/kit.js")
	})

	it("imports action under plain bun, with no mock", () => {
		// What a site's `bun test` does: no Vite, so no `$app/server` to resolve.
		const script = `
			const kit = await import(${JSON.stringify(`${root}src/library/kit_base.ts`)})
			let remote_error = ""
			try { kit.remote() } catch (e) { remote_error = e.message }
			console.log(JSON.stringify({ action: typeof kit.action, remote_error }))
		`
		const out = JSON.parse(execFileSync("bun", ["-e", script], { encoding: "utf8" }).trim())
		expect(out.action).toBe("function")
		expect(out.remote_error).toMatch(/needs SvelteKit/)
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

	it("stringifies numbers, says Yes for a ticked box and leaves an unticked one out", async () => {
		const data = remote_form_data({ info: { height: 170, likes_dogs: true, updates: false } })
		expect(data.get("info→height")).toBe("170")
		expect(data.get("info→likes_dogs")).toBe("Yes")
		expect(data.has("info→updates")).toBe(false)
	})
})
