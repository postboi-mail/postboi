import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { api_command } from "./api.js"

let directory: string, calls: Array<{ url: string; init?: RequestInit }>, output: Array<string>
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "postboi-newsletter-"))
	calls = []
	output = []
	vi.stubEnv("POSTBOI_TOKEN", "pb_synthetic")
	vi.stubEnv("POSTBOI_INBOX", "off")
	vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)))
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init })
			return Response.json({
				id: "campaign_test",
				revision: 2,
				status: "draft",
				blocking: [],
				warnings: [],
			})
		})
	)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})
function file(name: string, body: unknown) {
	const path = join(directory, name)
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body))
	return path
}
function sent() {
	return JSON.parse(String(calls.at(-1)?.init?.body))
}

describe("newsletter CLI uses actual hosted operations", () => {
	it("saves draft JSON without sending and updates only with an explicit revision", async () => {
		const path = file("draft.json", {
			name: "News",
			list_id: "list",
			sender: "news@example.test",
			subject: "Hello",
			body: "<p>News</p>",
		})
		await api_command("campaigns", ["create", "--file", path, "--json"])
		expect(calls[0].url).toContain("/v1/campaigns")
		expect(sent()).toMatchObject({ name: "News", list_id: "list" })
		await expect(
			api_command("campaigns", ["update", "campaign_test", "--file", path])
		).rejects.toMatchObject({ code: "invalid_args" })
		expect(calls).toHaveLength(1)
		await api_command("campaigns", [
			"update",
			"campaign_test",
			"--file",
			path,
			"--revision",
			"2",
			"--json",
		])
		expect(calls[1].init?.method).toBe("PUT")
		expect(sent().revision).toBe(2)
		expect(output.map((line) => JSON.parse(line))).toHaveLength(2)
	})
	it("requires absolute schedules and an IANA display zone before making launch requests", async () => {
		await expect(
			api_command("campaigns", [
				"launch",
				"a",
				"--revision",
				"2",
				"--at",
				"2027-01-12T09:00",
				"--timezone",
				"UTC",
			])
		).rejects.toMatchObject({ code: "invalid_args" })
		expect(calls).toHaveLength(0)
		await api_command("campaigns", [
			"launch",
			"a/b",
			"--revision",
			"2",
			"--at",
			"2027-01-12T09:00:00Z",
			"--timezone",
			"Europe/London",
			"--json",
		])
		expect(calls[0].url).toContain("/v1/campaigns/a%2Fb/launch")
		expect(sent()).toEqual({
			revision: 2,
			scheduled_at: "2027-01-12T09:00:00Z",
			timezone: "Europe/London",
		})
	})
	it("sends tests only to the explicit email and clones non-opener drafts with a supplied key", async () => {
		await api_command("campaigns", [
			"test",
			"a",
			"--email",
			"reviewer@example.test",
			"--sample-contact",
			"sample",
			"--json",
		])
		expect(sent()).toEqual({ email: "reviewer@example.test", sample_contact_id: "sample" })
		await expect(api_command("campaigns", ["resend", "a"])).rejects.toMatchObject({
			code: "invalid_args",
		})
		await api_command("campaigns", ["resend", "a", "--key", "same-draft", "--json"])
		expect(sent()).toEqual({ idempotency_key: "same-draft" })
	})
	it("returns preview HTML as valid JSON and passes export pagination through", async () => {
		vi.mocked(globalThis.fetch).mockImplementation(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ url: String(url), init })
				return new Response("<h1>Preview</h1>", { headers: { "content-type": "text/html" } })
			}
		)
		await api_command("campaigns", ["preview", "a", "--json"])
		expect(JSON.parse(output[0])).toEqual({ html: "<h1>Preview</h1>" })
		await api_command("campaigns", [
			"export",
			"a",
			"--offset",
			"1000",
			"--limit",
			"25",
			"--out",
			join(directory, "report.csv"),
			"--json",
		])
		expect(calls[1].url).toContain("/export?offset=1000&limit=25")
	})
	it("requires consent, stages raw CSV without applying, and never invents hosted run/confirmation endpoints", async () => {
		await expect(
			api_command("newsletters", ["signup", "list", "--email", "reader@example.test"])
		).rejects.toMatchObject({ code: "consent_required" })
		expect(calls).toHaveLength(0)
		await api_command("newsletters", [
			"signup",
			"list",
			"--email",
			"reader@example.test",
			"--consent",
			"--json",
		])
		expect(sent()).toEqual({ email: "reader@example.test", consent: true })
		const csv = "Email Address,Email Marketing Status\nreader@example.test,subscribed\n"
		await api_command("newsletters", [
			"imports",
			"list",
			"preview",
			"--file",
			file("audience.csv", csv),
			"--consent",
			"--json",
		])
		expect(calls[1].url).toContain("/v1/newsletters/list/imports")
		expect(sent()).toMatchObject({ csv, default_status: "pending", consent_confirmed: true })
		await expect(api_command("campaigns", ["run", "a"])).rejects.toMatchObject({
			code: "invalid_args",
		})
		await expect(api_command("newsletters", ["confirm", "list"])).rejects.toMatchObject({
			code: "invalid_args",
		})
		expect(calls).toHaveLength(2)
	})
	it("local mode refuses an absent inbox without fetching or consuming a hosted token", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "")
		await expect(api_command("campaigns", ["list", "--local", "--json"])).rejects.toMatchObject({
			code: "local_inbox_unavailable",
		})
		expect(calls).toHaveLength(0)
	})
})

it("automation CLI refuses enable without confirmation and never invents a hosted runner", async () => {
	await expect(
		api_command("newsletters", ["rules", "list/a", "enable", "rule/b", "--revision", "2", "--json"])
	).rejects.toMatchObject({ code: "confirmation_required" })
	await expect(
		api_command("newsletters", ["rules", "list/a", "run", "rule/b", "--json"])
	).rejects.toMatchObject({ code: "invalid_args" })
	expect(calls).toHaveLength(0)
	await api_command("newsletters", [
		"rules",
		"list/a",
		"enable",
		"rule/b",
		"--revision",
		"2",
		"--confirm",
		"--json",
	])
	expect(calls[0].url).toContain("/newsletters/list%2Fa/rules/rule%2Fb/enable")
	expect(sent()).toEqual({ revision: 2, confirm: true })
	const path = file("rule.json", {
		name: "Follow-up",
		trigger_tag_id: "tag",
		subject: "Hello",
		body: "<p>Hello</p>",
		sender: "news@example.test",
	})
	await api_command("newsletters", ["rules", "list/a", "create", "--file", path, "--json"])
	expect(sent()).not.toHaveProperty("enabled")
	await api_command("newsletters", [
		"rules",
		"list/a",
		"update",
		"rule/b",
		"--revision",
		"3",
		"--file",
		path,
		"--json",
	])
	expect(calls.at(-1)?.init?.method).toBe("PATCH")
	expect(sent().revision).toBe(3)
})
