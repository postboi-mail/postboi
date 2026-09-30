import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { render_types } from "./typegen.js"

const root = fileURLToPath(new URL("../../", import.meta.url))

/**
 * Type-check `source` against the library as a site sees it after `bunx postboi sync`: the
 * generated `register.d.ts` beside it, `postboi` and `postboi/kit` resolved to the source.
 */
function typecheck(source: string): string {
	const dir = mkdtempSync(join(tmpdir(), "postboi-typegen-"))
	try {
		const generated = render_types(
			"hello@acme.example",
			[{ domain: "acme.example", status: "verified" }],
			[],
			{},
			[],
			[{ id: "form_1", name: "Contact" }],
			[],
			"postboi"
		)
		writeFileSync(join(dir, "register.d.ts"), generated!)
		writeFileSync(join(dir, "site.ts"), source)
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					skipLibCheck: true,
					target: "es2022",
					module: "esnext",
					moduleResolution: "bundler",
					lib: ["es2022", "dom", "dom.iterable"],
					types: ["node", "@sveltejs/kit"],
					typeRoots: [join(root, "node_modules/@types"), join(root, "node_modules")],
					paths: {
						postboi: [join(root, "src/library/postboi.ts")],
						"postboi/kit": [join(root, "src/library/kit_base.ts")],
						"@sveltejs/kit": [join(root, "node_modules/@sveltejs/kit/types/index.d.ts")],
					},
				},
				files: ["register.d.ts", "site.ts"],
			})
		)
		try {
			execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", dir], { encoding: "utf8" })
			return ""
		} catch (error) {
			return String((error as { stdout?: string }).stdout ?? error)
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

describe("generated types at the postboi/kit boundary", () => {
	it("take CMS strings for form and from without casts, and still narrow a plain send", () => {
		const errors = typecheck(`
			import { action, type ActionFields } from "postboi/kit"
			import type { FormName, SendOptions } from "postboi"

			declare const development: string
			declare const block: { to?: string; from?: string; subject?: string } | undefined

			// bd-reside, bedales, lighthouse and emmaus cast every one of these around 0.56
			export const register = action(() => ({ form: \`Register Your Interest: \${development}\` }))
			export const order: ActionFields["form"] = "Products Order"
			export const cms = action(() => ({ to: block?.to, from: block?.from, subject: block?.subject }))

			// the generated names still autocomplete, and a plain send is still narrowed
			export const named: FormName = "Contact"
			export const ok: SendOptions = { body: "", from: "Acme <hi@acme.example>" }
			// @ts-expect-error a domain the account doesn't have
			export const foreign: SendOptions = { body: "", from: "giving@elsewhere.example" }
		`)
		expect(errors).toBe("")
	}, 60_000)
})
