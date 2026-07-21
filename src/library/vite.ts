import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

/**
 * The slice of Vite's `Plugin` interface this uses, declared locally so importing
 * `postboi/vite` never drags a `vite` dependency into consumers' type-checking.
 */
export interface VitePlugin {
	name: string
	config(): { optimizeDeps: { exclude: Array<string> } }
	configResolved(config: { root: string }): void
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

	return {
		name: "postboi",

		config: () => ({ optimizeDeps: { exclude: ["postboi/remote"] } }),

		configResolved(config) {
			if (options.config === false) return
			file = options.config
				? isAbsolute(options.config)
					? options.config
					: resolve(config.root, options.config)
				: find_config(config.root)
		},

		transform(code, id, transform_options) {
			// Server builds only: the config file can hold secrets and hooks, and inlining it
			// into a client bundle would ship them to the browser.
			if (!file || !transform_options?.ssr || !is_config_module(id)) return null
			return {
				code: `${code}\nset_bundled_config(() => import(${JSON.stringify(file)}))\n`,
				map: null,
			}
		},
	}
}

export default postboi
