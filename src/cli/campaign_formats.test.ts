import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { api_command } from "./api.js"
let directory = ""
afterEach(function () {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	if (directory) rmSync(directory, { recursive: true, force: true })
	directory = ""
})
it("campaign CLI preserves explicit source format and never guesses a format on an older update file", async function () {
	directory = mkdtempSync(join(tmpdir(), "postboi-source-format-"))
	const path = join(directory, "draft.json"),
		calls: Array<{ url: string; body: Record<string, unknown> }> = []
	vi.stubEnv("POSTBOI_TOKEN", "pb_synthetic")
	vi.stubEnv("NODE_ENV", "production")
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.stubGlobal(
		"fetch",
		vi.fn(async function (url: RequestInfo | URL, init?: RequestInit) {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
			return Response.json({ id: "draft", revision: 2 })
		})
	)
	writeFileSync(
		path,
		JSON.stringify({
			name: "News",
			list_id: "list",
			body_format: "markdown",
			body: "# A source edition",
		})
	)
	await api_command("campaigns", ["create", "--file", path, "--json"])
	expect(calls[0].body).toMatchObject({ body_format: "markdown", body: "# A source edition" })
	writeFileSync(path, JSON.stringify({ name: "News", list_id: "list", body: "# Revised source" }))
	await api_command("campaigns", ["update", "draft", "--file", path, "--revision", "2", "--json"])
	expect(calls[1].body).toMatchObject({ body: "# Revised source", revision: 2 })
	expect(calls[1].body).not.toHaveProperty("body_format")
	expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
		"/v1/campaigns",
		"/v1/campaigns/draft",
	])
})
