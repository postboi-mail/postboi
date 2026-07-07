import { describe, it, expect } from "vitest"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as {
	exports: Record<string, { types: string; default: string }>
}

/** Map an exports target like "./dist/resend.js" or "./dist/resend.d.ts" to "src/library/resend.ts". */
const to_source = (target: string) =>
	target
		.replace("./dist/", "src/library/")
		.replace(/\.d\.ts$/, ".ts")
		.replace(/\.js$/, ".ts")

describe("package exports", () => {
	const entries = Object.entries(pkg.exports)

	it("points every entry at an existing source module and matching types", () => {
		for (const [name, target] of entries) {
			expect(existsSync(root + to_source(target.default)), `${name} default`).toBe(true)
			expect(existsSync(root + to_source(target.types)), `${name} types`).toBe(true)
		}
	})

	it("exports every provider module in src/library", () => {
		const internal = new Set([
			"index.ts",
			"utils.ts",
			"registry.ts",
			"config.ts",
			"env.ts",
			"mail.ts",
			"captcha.ts", // spam protection, reached via the root export
			"register.ts", // generated-types placeholder, reached via the root export
		])
		const providers = readdirSync(`${root}src/library`).filter(
			(f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !internal.has(f)
		)
		const exported = new Set(
			entries.map(([, t]) => to_source(t.default).replace("src/library/", ""))
		)

		for (const file of providers) {
			expect(exported.has(file), `${file} should have a package.json exports entry`).toBe(true)
		}
	})
})
