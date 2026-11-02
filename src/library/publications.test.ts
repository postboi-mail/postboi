import { afterEach, expect, it, vi } from "vitest"
import Postboi from "./postboi_provider.js"
import { mail } from "./mail.js"
afterEach(function () {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})
it("publication SDK uses hosted paths, exact public approval and stored-copy reads without sending", async function () {
	vi.stubEnv("NODE_ENV", "production")
	vi.stubEnv("POSTBOI_TOKEN", "pb_synthetic")
	vi.stubEnv("POSTBOI_PROVIDER", "postboi")
	const requests: Array<{ url: string; init?: RequestInit }> = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async function (url: RequestInfo | URL, init?: RequestInit) {
			requests.push({ url: String(url), init })
			return Response.json({ publications: [], ok: true })
		})
	)
	const client = new Postboi({ token: "pb_synthetic" })
	await client.publications.configure("list/a", {
		slug: "example-news",
		title: "Example",
		enabled: true,
		confirm: true,
	})
	await mail.publications.issues.review("list/a", "campaign/b", 3)
	await client.publications.issues.publish("list/a", "campaign/b", {
		revision: 3,
		slug: "new-issue",
		summary: "News",
		visibility: "unlisted",
		confirm: true,
	})
	await client.publications.issues.get("list/a", "campaign/b")
	await client.publications.issues.unpublish("list/a", "campaign/b")
	await client.publications.issues.all("list/a", { offset: 100 })
	expect(await client.publications.all()).toEqual([])
	expect(
		requests.map((item) => [
			new URL(item.url).pathname + new URL(item.url).search,
			item.init?.method,
		])
	).toEqual([
		["/v1/publications/list%2Fa", "PUT"],
		["/v1/publications/list%2Fa/issues/campaign%2Fb/review?revision=3", "GET"],
		["/v1/publications/list%2Fa/issues/campaign%2Fb", "POST"],
		["/v1/publications/list%2Fa/issues/campaign%2Fb", "GET"],
		["/v1/publications/list%2Fa/issues/campaign%2Fb", "DELETE"],
		["/v1/publications/list%2Fa/issues?offset=100", "GET"],
		["/v1/publications", "GET"],
	])
	expect(JSON.parse(String(requests[2].init?.body))).toMatchObject({
		revision: 3,
		confirm: true,
		visibility: "unlisted",
	})
})
it("all hosted-only namespaces refuse explicit or implicit local mode without network or token discovery", async function () {
	const network = vi.fn()
	vi.stubGlobal("fetch", network)
	vi.stubEnv("NODE_ENV", "development")
	vi.stubEnv("POSTBOI_INBOX", "off")
	const client = new Postboi({ newsletter_local: true })
	for (const call of [
		() => client.publications.all(),
		() => client.migrations.list(),
		() => client.postmaster.list(),
		() => mail.publications.all(),
		() => mail.migrations.list(),
		() => mail.postmaster.list(),
	])
		await expect(call()).rejects.toMatchObject({ code: "local_resource_unavailable" })
	expect(network).not.toHaveBeenCalled()
})
