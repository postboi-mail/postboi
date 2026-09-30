import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { postboi } from "$library/vite.js"
import { INBOX_DISCOVERY } from "$library/inbox.js"

const CONFIG_MODULE = "/app/node_modules/postboi/dist/config.js"
const INBOX_MODULE = "/app/node_modules/postboi/dist/inbox.js"
const MAIL_MODULE = "/app/node_modules/postboi/dist/mail.js"

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "postboi-vite-"))
	writeFileSync(join(root, "postboi.config.ts"), "export default {}")
	mkdirSync(join(root, "node_modules"), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Build the plugin and run the hooks Vite would, in order. */
function plugin(options?: Parameters<typeof postboi>[0]) {
	const instance = postboi(options)
	instance.configResolved({ root })
	return instance
}

/** Stand in for the dev server, listening on `port` and optionally over TLS. */
function fake_server(port: number, https?: boolean) {
	const listeners: Record<string, Array<() => void>> = {}
	return {
		server: {
			middlewares: { use: () => undefined },
			httpServer: {
				on(event: string, listener: () => void) {
					;(listeners[event] ??= []).push(listener)
				},
				address: () => ({ port }),
			},
			config: { root, server: { https } },
		},
		listen: () => listeners.listening?.forEach((fire) => fire()),
	}
}

describe("vite plugin", () => {
	it("tells the app the dev server's scheme, not just its port", () => {
		// The inbox is mounted on the dev server, so it is served however that server is. Told
		// http when it is really https, the capture POSTs plaintext at a TLS port, fails, and
		// falls back to the console — the mail never reaches the inbox and the printed link 404s.
		const secure = plugin()
		const host = fake_server(5173, {})
		secure.configureServer(host.server)
		host.listen()
		expect(secure.transform("// inbox", INBOX_MODULE, { ssr: true })?.code).toContain(
			"set_inbox_port(5173, true)"
		)
		expect(JSON.parse(readFileSync(join(root, INBOX_DISCOVERY), "utf8")).secure).toBe(true)
	})

	it("says so plainly when the dev server is plain http", () => {
		const plain = plugin()
		const host = fake_server(5174)
		plain.configureServer(host.server)
		host.listen()
		expect(plain.transform("// inbox", INBOX_MODULE, { ssr: true })?.code).toContain(
			"set_inbox_port(5174, false)"
		)
		expect(JSON.parse(readFileSync(join(root, INBOX_DISCOVERY), "utf8")).secure).toBe(false)
	})

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

describe("the request hook", () => {
	it("hands mail() SvelteKit's request, on the server, under SvelteKit only", () => {
		const kit = postboi()
		kit.configResolved({ root, plugins: [{ name: "vite-plugin-sveltekit-setup" }] })
		const code = kit.transform("// mail", MAIL_MODULE, { ssr: true })?.code
		expect(code).toContain('from "$app/server"')
		expect(code).toContain("sveltekit.request = __postboi_request")
		expect(kit.transform("// mail", MAIL_MODULE, { ssr: false })).toBeNull()

		// Plain Vite has no $app/server to import.
		expect(plugin().transform("// mail", MAIL_MODULE, { ssr: true })).toBeNull()
	})
})
