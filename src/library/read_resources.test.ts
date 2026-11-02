import { expect, it } from "vitest"
import { migration_resources, postmaster_resources } from "./read_resources.js"
import type { NewsletterRequest } from "./newsletters.js"
it("migration and Postmaster resources use read-only paths with exact IDs and cursors", async () => {
	const calls: Array<{ path: string; init: unknown }> = [],
		review = { job: { id: "migration/a" }, warnings: ["Review original source"] }
	const request: NewsletterRequest = async function <T>(
		path: string,
		init?: { method?: string; body?: unknown }
	): Promise<T> {
		calls.push({ path, init })
		return (path === "/migrations/migration%2Fa" ? { migration: review } : {}) as T
	}
	const migrations = migration_resources(request),
		postmaster = postmaster_resources(request)
	await migrations.list({ offset: 50 })
	expect(await migrations.review("migration/a")).toBe(review)
	await migrations.export("migration/a", { after: "42" })
	await postmaster.list({ offset: 25 })
	await postmaster.report("domain/a?x")
	await postmaster.feedback({ offset: 25 })
	expect(calls.map((c) => c.path)).toEqual([
		"/migrations?offset=50",
		"/migrations/migration%2Fa",
		"/migrations/migration%2Fa/export?after=42",
		"/postmaster?offset=25",
		"/postmaster/domain%2Fa%3Fx",
		"/postmaster/feedback?offset=25",
	])
	for (const call of calls) expect(call.init).toEqual({ method: "GET" })
})

import { afterEach, vi } from "vitest"
import Postboi from "./postboi_provider.js"
import { api_command } from "../cli/api.js"
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})
it("registered SDK and CLI use the hosted read routes and never send bodies", async () => {
	vi.stubEnv("NODE_ENV", "production")
	vi.stubEnv("POSTBOI_TOKEN", "pb_synthetic_reads")
	vi.stubEnv("POSTBOI_INBOX", "off")
	const calls: Array<{ url: URL; init?: RequestInit }> = [],
		output: Array<string> = []
	vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)))
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			calls.push({ url, init })
			return Response.json(
				url.pathname.endsWith("/export")
					? { resources: [], next: null }
					: url.pathname.endsWith("/migration%2Fa")
						? { migration: { job: { id: "migration/a" } } }
						: { domains: [], next_offset: null }
			)
		})
	)
	const client = new Postboi({ token: "pb_synthetic_reads" })
	await client.migrations.list({ offset: 50 })
	expect(await client.migrations.review("migration/a")).toEqual({ job: { id: "migration/a" } })
	await client.migrations.export("migration/a", { after: "50" })
	await client.postmaster.list()
	await client.postmaster.report("domain/a")
	await client.postmaster.feedback({ offset: 25 })
	await api_command("migrations", ["export", "migration/a", "--after", "50", "--json"])
	await api_command("postmaster", ["feedback", "--offset", "25", "--json"])
	expect(calls).toHaveLength(8)
	for (const call of calls) {
		expect(call.url.origin).toBe("https://postboi.app")
		expect(call.init?.method ?? "GET").toBe("GET")
		expect(call.init?.body).toBeUndefined()
	}
	expect(calls[6].url.pathname).toBe("/v1/migrations/migration%2Fa/export")
	expect(calls[6].url.searchParams.get("after")).toBe("50")
	expect(calls[7].url.pathname).toBe("/v1/postmaster/feedback")
	expect(calls[7].url.searchParams.get("offset")).toBe("25")
	expect(JSON.parse(output[0])).toEqual({ resources: [], next: null })
})
it("local and default development read resources refuse before any token or network fallback", async () => {
	vi.stubEnv("NODE_ENV", "development")
	vi.stubEnv("POSTBOI_TOKEN", "")
	vi.stubGlobal("fetch", vi.fn())
	for (const client of [new Postboi({ newsletter_local: true }), new Postboi()]) {
		for (const operation of [
			() => client.migrations.list(),
			() => client.migrations.review("job"),
			() => client.migrations.export("job"),
			() => client.postmaster.list(),
			() => client.postmaster.report("domain"),
			() => client.postmaster.feedback(),
		])
			await expect(operation()).rejects.toMatchObject({ code: "local_resource_unavailable" })
	}
	for (const command of ["migrations", "postmaster"])
		await expect(api_command(command, ["list", "--local", "--json"])).rejects.toMatchObject({
			code: "local_operation_unavailable",
		})
	expect(fetch).not.toHaveBeenCalled()
})
it("CLI refuses malformed cursors and misplaced options without network access", async () => {
	vi.stubEnv("NODE_ENV", "production")
	vi.stubGlobal("fetch", vi.fn())
	for (const [command, args] of [
		["migrations", ["export", "job", "--after", "1e3"]],
		["migrations", ["list", "--after", "2"]],
		["postmaster", ["report", "domain", "--offset", "1"]],
		["postmaster", ["feedback", "--offset", "10000001"]],
	] as const)
		await expect(api_command(command, [...args])).rejects.toMatchObject({ code: "invalid_args" })
	expect(fetch).not.toHaveBeenCalled()
})
