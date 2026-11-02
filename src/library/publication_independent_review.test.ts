import { afterEach, expect, it, vi } from "vitest"
import Postboi from "./postboi_provider.js"
import { api_command } from "../cli/api.js"
afterEach(function () {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})
it("a stale public-copy approval is refused once without fetching a newer revision or retrying publication", async function () {
	vi.stubEnv("NODE_ENV", "production")
	vi.stubEnv("POSTBOI_TOKEN", "pb_synthetic_publication_review")
	vi.stubEnv("POSTBOI_INBOX", "off")
	const requests: Array<{ url: URL; init?: RequestInit }> = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async function (input: RequestInfo | URL, init?: RequestInit) {
			requests.push({ url: new URL(input instanceof Request ? input.url : String(input)), init })
			return Response.json(
				{ code: "publication_refused", message: "Review the current campaign revision." },
				{ status: 409 }
			)
		})
	)
	const client = new Postboi({ token: "pb_synthetic_publication_review" }),
		approval = {
			revision: 3,
			slug: "first-issue",
			summary: "Approved summary",
			visibility: "unlisted" as const,
			confirm: true as const,
		}
	await expect(
		client.publications.issues.publish("list/a", "campaign/b", approval)
	).rejects.toMatchObject({ status: 409, code: "publication_refused" })
	await expect(
		api_command("publications", [
			"publish",
			"list/a",
			"campaign/b",
			"--revision",
			"3",
			"--slug",
			"first-issue",
			"--summary",
			"Approved summary",
			"--visibility",
			"unlisted",
			"--confirm",
			"--json",
		])
	).rejects.toMatchObject({ code: "publication_refused" })
	expect(requests).toHaveLength(2)
	for (const request of requests) {
		expect(request.url.pathname).toBe("/v1/publications/list%2Fa/issues/campaign%2Fb")
		expect(request.init?.method).toBe("POST")
		expect(JSON.parse(String(request.init?.body))).toEqual(approval)
	}
})
it("local publication writes fail before discovering or forwarding a hosted token", async function () {
	vi.stubEnv("NODE_ENV", "development")
	vi.stubEnv("POSTBOI_TOKEN", "")
	vi.stubGlobal("fetch", vi.fn())
	const client = new Postboi({ newsletter_local: true })
	for (const action of [
		() =>
			client.publications.configure("list", {
				slug: "example-news",
				title: "News",
				enabled: true,
				confirm: true,
			}),
		() =>
			client.publications.issues.publish("list", "campaign", {
				revision: 1,
				slug: "first-issue",
				summary: "News",
				visibility: "listed",
				confirm: true,
			}),
		() => client.publications.issues.unpublish("list", "campaign"),
	])
		await expect(action()).rejects.toMatchObject({ code: "local_resource_unavailable" })
	await expect(
		api_command("publications", ["publish", "list", "campaign", "--local", "--confirm"])
	).rejects.toMatchObject({ code: "local_publications_unavailable" })
	expect(fetch).not.toHaveBeenCalled()
})
