import { describe, it, expect, vi, afterEach } from "vitest"
import { map_events, migrate_command } from "./migrate.js"

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

/** A Resend account and an empty Postboi one, with every call recorded. */
function stub_accounts(options: { postboi?: Record<string, unknown> } = {}) {
	const calls: Array<{ url: string; method: string; body?: unknown }> = []
	const lines: Array<string> = []
	vi.stubEnv("POSTBOI_TOKEN", "pb_test")
	vi.stubEnv("RESEND_API_KEY", "re_test")
	const resend: Record<string, unknown> = {
		"/domains": { data: [{ id: "d1", name: "Acme.example", status: "verified" }] },
		"/audiences": { data: [{ id: "a1", name: "Newsletter" }] },
		"/audiences/a1/contacts": {
			data: [
				{ id: "c1", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace" },
				{ id: "c2", email: "gone@example.com", unsubscribed: true },
			],
		},
		"/webhooks": {
			data: [
				{
					id: "w1",
					endpoint: "https://app.example/hooks",
					events: ["email.delivered", "email.delivery_delayed", "email.bounced"],
					status: "enabled",
				},
				{
					id: "w2",
					endpoint: "https://app.example/old",
					events: ["email.sent"],
					status: "disabled",
				},
			],
		},
	}
	const postboi: Record<string, unknown> = {
		"GET /v1/domains": { domains: [] },
		"POST /v1/domains": {
			id: "dom_1",
			domain: "acme.example",
			status: "pending",
			records: [
				{ type: "CNAME", name: "x._domainkey.acme.example", value: "x.dkim.amazonses.com" },
			],
		},
		"GET /v1/lists": { lists: [] },
		"POST /v1/lists": { id: "list_1", name: "Newsletter" },
		"POST /v1/lists/list_1/recipients": { added: 2, updated: 0, pending: 0 },
		"GET /v1/webhooks": { webhooks: [] },
		"POST /v1/webhooks": { id: "wh_1", url: "https://app.example/hooks", secret: "whsec_new" },
		...options.postboi,
	}
	const fetch_fn = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? "GET"
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		calls.push({ url, method, body })
		const { pathname, search } = new URL(url)
		if (url.startsWith("https://api.resend.com")) {
			if (
				init?.headers &&
				(init.headers as Record<string, string>).Authorization !== "Bearer re_test"
			) {
				return new Response(JSON.stringify({ message: "nope" }), { status: 401 })
			}
			const answer = resend[pathname]
			return new Response(JSON.stringify(answer ?? { data: [] }), { status: 200 })
		}
		const answer = postboi[`${method} ${pathname}`] as
			| { status: number; body: unknown }
			| Record<string, unknown>
			| undefined
		if (!answer)
			return new Response(
				JSON.stringify({ message: `no stub for ${method} ${pathname}${search}` }),
				{ status: 500 }
			)
		// A stub shaped `{ status, body }` is a refusal; anything else is the 200 body.
		if (typeof answer.status === "number" && "body" in answer) {
			return new Response(JSON.stringify(answer.body), { status: answer.status })
		}
		return new Response(JSON.stringify(answer), { status: 200 })
	})
	vi.stubGlobal("fetch", fetch_fn)
	const log = (line: string) => void lines.push(line)
	// The domain records table and the plan are printed by api.ts's own helpers.
	vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
	return { calls, lines, log, fetch_fn }
}

describe("map_events", () => {
	it("keeps the events Postboi emits, in its names, and says which were dropped", () => {
		expect(
			map_events(["email.delivered", "email.delivery_delayed", "email.opened", "contact.created"])
		).toEqual({
			events: ["email.delivered", "email.opened"],
			dropped: ["email.delivery_delayed", "contact.created"],
		})
	})
})

describe("migrate resend", () => {
	it("registers the domain, imports the audience without re-confirming, and re-registers the webhook", async () => {
		const { calls, lines, log } = stub_accounts()
		await migrate_command(["resend"], { log })

		const postboi = calls.filter((c) => !c.url.startsWith("https://api.resend.com"))
		const writes = postboi
			.filter((c) => c.method !== "GET")
			.map((c) => [c.method, new URL(c.url).pathname + new URL(c.url).search, c.body])
		expect(writes).toEqual([
			["POST", "/v1/domains", { domain: "acme.example" }],
			["POST", "/v1/lists", { name: "Newsletter" }],
			[
				"POST",
				"/v1/lists/list_1/recipients?status=subscribed",
				[
					{ email: "ada@example.com", name: "Ada Lovelace" },
					{ email: "gone@example.com", name: undefined, status: "unsubscribed" },
				],
			],
			[
				"POST",
				"/v1/webhooks",
				{
					url: "https://app.example/hooks",
					name: "Imported from Resend",
					events: ["email.delivered", "email.bounced"],
				},
			],
		])
		const text = lines.join("\n")
		expect(text).toContain("x._domainkey.acme.example")
		expect(text).toContain("whsec_new")
		expect(text).toContain("dropped: email.delivery_delayed")
		expect(text).toContain("disabled on Resend")
	})

	it("skips what is already here, so running it twice is safe", async () => {
		const { calls, log } = stub_accounts({
			postboi: {
				"GET /v1/domains": { domains: [{ domain: "acme.example", status: "verified" }] },
				"GET /v1/lists": { lists: [{ id: "list_1", name: "Newsletter" }] },
				"GET /v1/webhooks": { webhooks: [{ url: "https://app.example/hooks" }] },
			},
		})
		await migrate_command(["resend"], { log })
		const writes = calls.filter(
			(c) => !c.url.startsWith("https://api.resend.com") && c.method !== "GET"
		)
		// Recipients still upsert; nothing else is created again.
		expect(writes.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"POST /v1/lists/list_1/recipients",
		])
	})

	it("--dry-run reads Resend and writes nothing, and --json prints the plan", async () => {
		const { calls, lines, log } = stub_accounts()
		await migrate_command(["resend", "--dry-run", "--json"], { log })
		expect(calls.every((c) => c.url.startsWith("https://api.resend.com"))).toBe(true)
		expect(lines).toHaveLength(1)
		expect(JSON.parse(lines[0])).toEqual({
			dry_run: true,
			plan: {
				domains: [{ name: "acme.example", status: "verified" }],
				lists: [{ name: "Newsletter", subscribed: 1, unsubscribed: 1 }],
				webhooks: [
					{
						url: "https://app.example/hooks",
						events: ["email.delivered", "email.bounced"],
						dropped: ["email.delivery_delayed"],
						disabled: false,
					},
					{ url: "https://app.example/old", events: ["email.sent"], dropped: [], disabled: true },
				],
			},
			domains: [],
			lists: [],
			webhooks: [],
		})
	})

	it("matches a list the way the app does, trimmed and without case", async () => {
		const { calls, log } = stub_accounts({
			postboi: { "GET /v1/lists": { lists: [{ id: "list_1", name: "newsletter" }] } },
		})
		await migrate_command(["resend", "--only", "lists"], { log })
		const writes = calls.filter(
			(c) => !c.url.startsWith("https://api.resend.com") && c.method !== "GET"
		)
		expect(writes.map((c) => `${c.method} ${new URL(c.url).pathname}`)).not.toContain(
			"POST /v1/lists"
		)
	})

	it("a refused item goes on its row and the rest still moves", async () => {
		const { calls, lines, log } = stub_accounts({
			postboi: {
				"POST /v1/domains": {
					status: 409,
					body: { code: "domain_taken", message: "Another account owns acme.example." },
				},
			},
		})
		await migrate_command(["resend", "--json"], { log })
		const writes = calls.filter(
			(c) => !c.url.startsWith("https://api.resend.com") && c.method !== "GET"
		)
		expect(writes.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toContain(
			"POST /v1/webhooks"
		)
		const summary = JSON.parse(lines.at(-1) ?? "")
		expect(summary.domains).toEqual([
			{ domain: "acme.example", existed: false, error: "Another account owns acme.example." },
		])
		expect(summary.webhooks[0].id).toBe("wh_1")
		expect(process.exitCode).toBe(1)
		process.exitCode = undefined
	})

	it("--only narrows what is read", async () => {
		const { calls, log } = stub_accounts()
		await migrate_command(["resend", "--only", "webhooks", "--dry-run"], { log })
		expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/webhooks"])
	})

	it("refuses a key Resend refuses, by code", async () => {
		const { log } = stub_accounts()
		await expect(migrate_command(["resend", "--key", "re_wrong"], { log })).rejects.toMatchObject({
			code: "resend_unauthorized",
		})
	})

	it("needs a provider it knows and a key", async () => {
		const { log } = stub_accounts()
		await expect(migrate_command(["sendgrid"], { log })).rejects.toThrow(/Usage/)
		vi.stubEnv("RESEND_API_KEY", "")
		await expect(migrate_command(["resend"], { log })).rejects.toMatchObject({
			code: "no_resend_key",
		})
	})
})
