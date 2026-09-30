import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { INBOX_DISCOVERY, INBOX_PATH } from "./inbox.js"
import { create_inbox_store, inbox_middleware, type InboxMiddleware } from "./inbox_server.js"
import type { InboxUiOptions } from "./inbox_ui.js"

/**
 * The slice of Vite's dev server this uses. See {@link VitePlugin} for why it's structural.
 */
export interface ViteDevServer {
	middlewares: { use(handler: InboxMiddleware): unknown }
	httpServer: {
		on(event: string, listener: () => void): unknown
		address(): { port?: number } | string | null
	} | null
	config: {
		root: string
		/** `server.https` is truthy whenever the dev server is serving over TLS. */
		server?: { https?: unknown }
	}
}

/**
 * The slice of Vite's `Plugin` interface this uses, declared locally so importing
 * `postboi/vite` never drags a `vite` dependency into consumers' type-checking.
 */
export interface VitePlugin {
	name: string
	config(): { optimizeDeps: { exclude: Array<string> } }
	configResolved(config: { root: string; plugins?: ReadonlyArray<{ name: string }> }): void
	configureServer(server: ViteDevServer): void
	transform(
		code: string,
		id: string,
		options?: { ssr?: boolean }
	): { code: string; map: null } | null
}

/** Options for the {@link postboi} Vite plugin. */
export interface PluginOptions {
	/**
	 * Path to the project's config file, relative to the Vite root. Defaults to the first
	 * `postboi.config.*` found from the root upward; `false` skips bundling it entirely.
	 */
	config?: string | false
	/**
	 * Serve the local dev inbox at `/__postboi` and capture mail into it instead of sending.
	 * On by default; `false` leaves the dev server alone and sends for real. An object turns
	 * it on and sets what the page starts with — both remain toggleable in the UI, where the
	 * viewer's choice is remembered and wins.
	 *
	 * @example
	 * ```ts
	 * postboi({ inbox: { sounds: false, intro: false } })
	 * ```
	 */
	inbox?: boolean | InboxUiOptions
}

const CONFIG_FILES = [
	"postboi.config.ts",
	"postboi.config.mts",
	"postboi.config.js",
	"postboi.config.mjs",
]

/** Find a `postboi.config.*`, walking up from the Vite root. */
function find_config(root: string): string | undefined {
	let dir = root
	for (;;) {
		const file = CONFIG_FILES.map((f) => join(dir, f)).find((f) => existsSync(f))
		if (file) return file
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

/** Is this module id Postboi's own config module — the one that holds the loader hook? */
function is_config_module(id: string): boolean {
	return id.replace(/\\/g, "/").split("?")[0].endsWith("/postboi/dist/config.js")
}

/** Is this Postboi's zero-config `mail()` module — the one that holds the request hook? */
function is_mail_module(id: string): boolean {
	return id.replace(/\\/g, "/").split("?")[0].endsWith("/postboi/dist/mail.js")
}

/** Is this Postboi's inbox module — the one that holds the port hook? */
function is_inbox_module(id: string): boolean {
	return id.replace(/\\/g, "/").split("?")[0].endsWith("/postboi/dist/inbox.js")
}

/**
 * Tell the running app where the inbox is, two ways, because one of them is always wrong.
 *
 * The discovery file is read at send time, so it survives whatever order things started in
 * — but it needs a filesystem, which a Worker doesn't have. The injected port needs no
 * filesystem, but it's baked in when the module is first transformed. Between them every
 * runtime is covered.
 */
function advertise(root: string, port: number, secure: boolean): () => void {
	const file = join(root, INBOX_DISCOVERY)
	try {
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, JSON.stringify({ port, pid: process.pid, secure }))
	} catch {
		// Read-only or no node_modules — the injected port still covers the common case.
	}
	return () => {
		try {
			rmSync(file, { force: true })
		} catch {
			// Best-effort: a leftover file just means one failed POST, which falls back to the console.
		}
	}
}

/**
 * Vite plugin. Two jobs, both of them ceremony you'd otherwise write by hand:
 *
 * 1. Bundles your `postboi.config.*` into the server build. Edge runtimes (Cloudflare
 *    Workers, Deno Deploy, …) have no filesystem for the usual auto-load to read, so
 *    without this the config file has to be imported manually from an entry point.
 * 2. Excludes `postboi/remote` from dependency prebundling, which remote form functions
 *    need in order to reach the SvelteKit transform.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { postboi } from "postboi/vite"
 *
 * export default defineConfig({ plugins: [sveltekit(), postboi()] })
 * ```
 */
export function postboi(options: PluginOptions = {}): VitePlugin {
	let file: string | undefined
	let inbox_port: number | null = null
	let inbox_secure = false
	let sveltekit = false

	return {
		name: "postboi",

		config: () => ({ optimizeDeps: { exclude: ["postboi/remote"] } }),

		configResolved(config) {
			sveltekit = !!config.plugins?.some((p) => p.name.startsWith("vite-plugin-sveltekit"))
			if (options.config === false) return
			file = options.config
				? isAbsolute(options.config)
					? options.config
					: resolve(config.root, options.config)
				: find_config(config.root)
		},

		// Dev only, by construction — Vite never calls this for a build, so the inbox cannot
		// leak into production no matter how the plugin is configured.
		configureServer(server) {
			if (options.inbox === false) return
			const store = create_inbox_store()
			const ui = typeof options.inbox === "object" ? options.inbox : {}
			server.middlewares.use(inbox_middleware(store, INBOX_PATH, ui))

			const http = server.httpServer
			// Middleware mode (a custom Express/Hono dev server) owns its own listener, so
			// there's no port to read here. `postboi dev` is the answer for those.
			if (!http) return
			http.on("listening", () => {
				const address = http.address()
				if (!address || typeof address === "string" || !address.port) return
				inbox_port = address.port
				// The inbox is mounted on this server, so it is served however this server is. Get
				// this wrong and the printed link 404s in the browser and, worse, the capture POSTs
				// plaintext at a TLS port and quietly falls back to the console.
				inbox_secure = !!server.config.server?.https
				const cleanup = advertise(server.config.root, address.port, inbox_secure)
				http.on("close", cleanup)
				process.once("exit", cleanup)
				const scheme = inbox_secure ? "https" : "http"
				console.log(
					`  \x1b[33m➜\x1b[0m  \x1b[1mPostboi\x1b[0m:  dev inbox at ${scheme}://localhost:${address.port}${INBOX_PATH}`
				)
			})
		},

		transform(code, id, transform_options) {
			// Server builds only: the config file can hold secrets and hooks, and inlining it
			// into a client bundle would ship them to the browser.
			if (!transform_options?.ssr) return null
			if (file && is_config_module(id)) {
				return {
					code: `${code}\nset_bundled_config(() => import(${JSON.stringify(file)}))\n`,
					map: null,
				}
			}
			// Under SvelteKit, hand the zero-config `mail()` the request, so a hand-written send
			// in an action or remote function passes the visitor's IP to Turnstile like
			// `postboi/kit` does. Only SvelteKit has `$app/server` to import.
			if (sveltekit && is_mail_module(id)) {
				return {
					code: `${code}\nimport { getRequestEvent as __postboi_request } from "$app/server"\nsveltekit.request = __postboi_request\n`,
					map: null,
				}
			}
			// The port goes in the module because the plugin and the app's server code live in
			// different module registries — see `set_inbox_port`. Runtimes with a filesystem
			// would find the discovery file anyway; Workers only have this.
			if (inbox_port !== null && is_inbox_module(id)) {
				return { code: `${code}\nset_inbox_port(${inbox_port}, ${inbox_secure})\n`, map: null }
			}
			return null
		},
	}
}

export default postboi
