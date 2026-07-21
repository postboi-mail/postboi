import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { postboi } from "$library/vite.js"

const CONFIG_MODULE = "/app/node_modules/postboi/dist/config.js"

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "postboi-vite-"))
	writeFileSync(join(root, "postboi.config.ts"), "export default {}")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Build the plugin and run the hooks Vite would, in order. */
function plugin(options?: Parameters<typeof postboi>[0]) {
	const instance = postboi(options)
	instance.configResolved({ root })
	return instance
}

describe("vite plugin", () => {
	it("bundles the project config into Postboi's config module on the server build", () => {
		const result = plugin().transform("// config module", CONFIG_MODULE, { ssr: true })

		expect(result?.code).toContain(
			`set_bundled_config(() => import("${join(root, "postboi.config.ts")}"))`
		)
	})

	it("leaves the client build alone — the config file can hold secrets and hooks", () => {
		expect(plugin().transform("// config module", CONFIG_MODULE, { ssr: false })).toBeNull()
	})

	it("touches nothing but Postboi's own config module", () => {
		const instance = plugin()
		expect(instance.transform("// app", "/app/src/config.js", { ssr: true })).toBeNull()
		expect(
			instance.transform("// other", "/app/node_modules/other/dist/config.js", { ssr: true })
		).toBeNull()
	})

	it("still matches when Vite appends a query to the module id", () => {
		const result = plugin().transform("// config module", `${CONFIG_MODULE}?v=1`, { ssr: true })
		expect(result).not.toBeNull()
	})

	it("injects nothing when the project has no config file", () => {
		rmSync(join(root, "postboi.config.ts"))
		expect(plugin().transform("// config module", CONFIG_MODULE, { ssr: true })).toBeNull()
	})

	it("takes an explicit path, and skips bundling entirely on `config: false`", () => {
		writeFileSync(join(root, "mail.config.ts"), "export default {}")
		const explicit = plugin({ config: "mail.config.ts" })
		expect(explicit.transform("", CONFIG_MODULE, { ssr: true })?.code).toContain("mail.config.ts")

		expect(plugin({ config: false }).transform("", CONFIG_MODULE, { ssr: true })).toBeNull()
	})

	it("excludes postboi/remote from prebundling, so remote forms reach the transform", () => {
		expect(postboi().config()).toEqual({ optimizeDeps: { exclude: ["postboi/remote"] } })
	})
})
