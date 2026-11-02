import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Postboi from "./postboi_provider.js"
import { mail } from "./mail.js"
let requests: Array<{ url: string; init?: RequestInit }>
beforeEach(() => {
	requests = []
	vi.stubEnv("NODE_ENV", "production")
	vi.stubEnv("POSTBOI_TOKEN", "pb_synthetic")
	vi.stubEnv("POSTBOI_PROVIDER", "postboi")
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(url), init })
			return String(url).endsWith("/preview")
				? new Response("<h1>Rendered</h1>")
				: Response.json({
						campaigns: [],
						newsletters: [],
						tags: [],
						newsletter: { list_id: "list" },
						ok: true,
						id: "saved",
					})
		})
	)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})
describe("typed hosted newsletter resources", () => {
	it("encodes resource IDs, retains explicit test routing, and reads HTML previews", async () => {
		const client = new Postboi({ token: "pb_synthetic" })
		expect(await client.campaigns.preview("a/b")).toBe("<h1>Rendered</h1>")
		expect(requests[0].url).toBe("https://postboi.app/v1/campaigns/a%2Fb/preview")
		await client.campaigns.test("a/b", "reviewer@example.test", { sample_contact_id: "member" })
		expect(JSON.parse(String(requests[1].init?.body))).toEqual({
			email: "reviewer@example.test",
			sample_contact_id: "member",
		})
		expect(new Headers(requests[1].init?.headers).get("authorization")).toBe("Bearer pb_synthetic")
	})
	it("exposes nested zero-config resources and actual confirmation request contract", async () => {
		await mail.newsletters.tags.create("list", "Events", { contact_ids: ["c1"], event_id: "event" })
		expect(requests[0].url).toContain("/v1/newsletters/list/tags")
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({
			name: "Events",
			contact_ids: ["c1"],
			event_id: "event",
		})
		await mail.newsletters.signup("list", { email: "reader@example.test", consent: true })
		expect(requests[1].url).toContain("/v1/newsletters/list/signups")
		expect(await mail.campaigns.all()).toEqual([])
	})
	it("does not replace hosted account paths outside development", async () => {
		const client = new Postboi({ base_url: "https://api.example.test" })
		await client.newsletters.audience("space/a", { search: "a+b@example.test", offset: 25 })
		expect(requests[0].url).toBe(
			"https://api.example.test/v1/newsletters/space%2Fa/audience?search=a%2Bb%40example.test&offset=25"
		)
		expect((await client.newsletters.configure({ list_id: "list", slug: "news" })).list_id).toBe(
			"list"
		)
	})
})

it("automation SDK uses reviewed REST methods and explicit current-revision approval", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(url), init })
			return Response.json({ rules: [], id: "rule", subject: "Preview", html: "<p>Preview</p>" })
		})
	)
	const client = new Postboi({ token: "pb_synthetic" })
	const input = {
		name: "Welcome",
		trigger_tag_id: "tag",
		subject: "Hi",
		body: "<p>Hi</p>",
		sender: "news@example.test",
	}
	await client.newsletters.rules.create("list/a", input)
	await client.newsletters.rules.update("list/a", "rule/b", { ...input, revision: 2 })
	await mail.newsletters.rules.review("list/a", "rule/b")
	expect(
		await client.newsletters.rules.preview("list/a", "rule/b", { sample_contact_id: "reader" })
	).toMatchObject({ subject: "Preview", html: "<p>Preview</p>" })
	await client.newsletters.rules.enable("list/a", "rule/b", { revision: 2, confirm: true })
	await client.newsletters.rules.pause("list/a", "rule/b", { revision: 2 })
	expect(await client.newsletters.rules.all("list/a")).toEqual([])
	expect(requests.map((request) => [new URL(request.url).pathname, request.init?.method])).toEqual([
		["/v1/newsletters/list%2Fa/rules", "POST"],
		["/v1/newsletters/list%2Fa/rules/rule%2Fb", "PATCH"],
		["/v1/newsletters/list%2Fa/rules/rule%2Fb/review", "GET"],
		["/v1/newsletters/list%2Fa/rules/rule%2Fb/preview", "POST"],
		["/v1/newsletters/list%2Fa/rules/rule%2Fb/enable", "POST"],
		["/v1/newsletters/list%2Fa/rules/rule%2Fb/pause", "POST"],
		["/v1/newsletters/list%2Fa/rules", "GET"],
	])
	expect(JSON.parse(String(requests[4].init?.body))).toEqual({ revision: 2, confirm: true })
})
