import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { github_init, github_workflow } from "./github.js"

describe("keyless GitHub workflow setup", () => {
	it("writes a workflow with OIDC permission and a public selector, without a credential file", () => {
		const root = mkdtempSync(join(tmpdir(), "postboi-github-"))
		github_init(["--workload", "wl_public", "--run", "bun run test"], { root, out: () => {} })
		const text = readFileSync(join(root, ".github/workflows/postboi.yml"), "utf8")
		expect(text).toContain("id-token: write")
		expect(text).toContain("POSTBOI_WORKLOAD_ID: wl_public")
		expect(text).not.toContain("POSTBOI_TOKEN")
		expect(existsSync(join(root, ".env"))).toBe(false)
		expect(() => github_init(["--workload", "wl_public"], { root, out: () => {} })).toThrow(
			"already exists"
		)
	})
	it("requires valid public IDs and safe workflow filenames", () => {
		expect(() => github_workflow("pb_secret")).toThrow("public workload ID")
		const root = mkdtempSync(join(tmpdir(), "postboi-github-"))
		expect(() =>
			github_init(["--workload", "wl_public", "--workflow", "../../escape.yml"], {
				root,
				out: () => {},
			})
		).toThrow("workflow filename")
	})
})
