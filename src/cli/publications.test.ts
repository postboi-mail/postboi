import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { api_command } from "./api.js"
let directory = ""
afterEach(function () {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	if (directory) rmSync(directory, { recursive: true, force: true })
	directory = ""
})
it("CLI requires explicit approval outside JSON before any publication or public-profile request", async function () {
	vi.stubEnv("POSTBOI_TOKEN", "pb_synthetic")
	vi.stubEnv("NODE_ENV", "production")
	vi.spyOn(console, "log").mockImplementation(() => {})
	const network = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }))
	vi.stubGlobal("fetch", network)
	directory = mkdtempSync(join(tmpdir(), "postboi-publication-"))
	const path = join(directory, "publication.json")
	writeFileSync(
		path,
		JSON.stringify({ slug: "example-news", title: "Example", enabled: true, confirm: true })
	)
	await expect(
		api_command("publications", ["configure", "list", "--file", path, "--json"])
	).rejects.toMatchObject({ code: "invalid_args" })
	await expect(
		api_command("publications", [
			"publish",
			"list",
			"campaign",
			"--revision",
			"3",
			"--slug",
			"new-issue",
			"--summary",
			"News",
			"--visibility",
			"listed",
			"--json",
		])
	).rejects.toMatchObject({ code: "invalid_args" })
	expect(network).not.toHaveBeenCalled()
	await api_command("publications", [
		"publish",
		"list/a",
		"campaign/b",
		"--revision",
		"3",
		"--slug",
		"new-issue",
		"--summary",
		"News",
		"--visibility",
		"unlisted",
		"--confirm",
		"--json",
	])
	expect(network.mock.calls[0][0]).toContain("/v1/publications/list%2Fa/issues/campaign%2Fb")
	expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toEqual({
		revision: 3,
		slug: "new-issue",
		summary: "News",
		visibility: "unlisted",
		confirm: true,
	})
	await api_command("publications", ["unpublish", "list/a", "campaign/b", "--json"])
	expect(network.mock.calls[1][1]?.method).toBe("DELETE")
})
it("CLI never sends a local publication request", async function () {
	const network = vi.fn()
	vi.stubGlobal("fetch", network)
	await expect(api_command("publications", ["list", "--local"])).rejects.toMatchObject({
		code: "local_publications_unavailable",
	})
	expect(network).not.toHaveBeenCalled()
})
