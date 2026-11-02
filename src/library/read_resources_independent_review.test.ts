import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { api_command } from "../cli/api.js"
let directory = ""
afterEach(function () {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	if (directory) rmSync(directory, { recursive: true, force: true })
	directory = ""
})
it("independent source export creates a private new file, preserves evidence and cannot overwrite an existing file", async function () {
	vi.stubEnv("NODE_ENV", "production")
	vi.stubEnv("POSTBOI_TOKEN", "pb_synthetic")
	vi.spyOn(console, "log").mockImplementation(() => {})
	const original = {
		resources: [
			{
				cursor: 1,
				kind: "contact",
				scope: "list",
				source_id: "reader",
				value: { email: "private@example.invalid", opt_out: "yes" },
			},
		],
		next: "1",
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json(original))
	)
	directory = mkdtempSync(join(tmpdir(), "postboi-private-export-"))
	const file = join(directory, "source.json")
	await api_command("migrations", ["export", "job", "--out", file, "--json"])
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original)
	expect(statSync(file).mode & 0o777).toBe(0o600)
	writeFileSync(file, "Keep this evidence")
	await expect(
		api_command("migrations", ["export", "job", "--out", file, "--json"])
	).rejects.toThrow()
	expect(readFileSync(file, "utf8")).toBe("Keep this evidence")
})
