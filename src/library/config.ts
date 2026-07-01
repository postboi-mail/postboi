/**
 * Project-wide configuration. Set it once and every send — `send()`, `postboi/kit`, or any
 * provider instance — picks it up, so the 99% case is just calling `send()`.
 *
 * Drop a `postboi.config.ts` at your project root:
 *
 * ```ts
 * import { config } from "postboi"
 *
 * export default config({
 * 	hooks: {
 * 		on: {
 * 			error: (ctx) => Sentry.captureException(ctx.error),
 * 		},
 * 	},
 * })
 * ```
 *
 * It's auto-loaded on the first `send()` (Node/Bun). In runtimes without filesystem access
 * (edge/Workers), call {@link configure} explicitly at startup instead.
 */
import type { Defaults, Hooks } from "./index.js"
import type { ProviderKey } from "./registry.js"

/** Everything you can configure globally via `postboi.config.ts` or {@link configure}. */
export interface PostboiConfig {
	/**
	 * Provider key (`resend`, `mailgun`, …) for the zero-config `send()`. `POSTBOI_PROVIDER` wins.
	 * `"mock"` is also accepted — a credential-free no-op that records instead of sending, handy
	 * as a safe local default you override with `POSTBOI_PROVIDER` in production.
	 */
	provider?: ProviderKey | "mock"
	/** Default fields applied to every send. Merged under `POSTBOI_*` env vars, which win. */
	default?: Defaults
	/**
	 * Non-secret provider constructor options for the zero-config `send()`, keyed by the
	 * provider's option name (e.g. `{ domain: "mg.example.com", region: "us-east-1" }`). Lets
	 * you commit non-secret config and keep only the API key in the environment. The matching
	 * provider env var (e.g. `MAILGUN_DOMAIN`) still wins. Keep secrets out of here — in env.
	 */
	options?: Record<string, string>
	/** Per-request timeout in milliseconds. */
	timeout?: number
	/** Retries on network / 429 / 5xx errors. */
	retries?: number
	/** Base retry backoff in milliseconds (doubles each attempt). */
	retry_delay?: number
	/** Derive a plain-text body from the HTML body when `text` is omitted. */
	auto_text?: boolean
	/** Lifecycle hooks run around every send (the main reason to use a config file). */
	hooks?: Hooks
}

/** Keep only defined entries so a shallow merge never clobbers a value with `undefined`. */
function defined<T extends object>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(obj)) if (value !== undefined) out[key] = value
	return out as Partial<T>
}

/** Deep-merge hook groups so instance overrides don't clobber unrelated global hooks. */
export function merge_hooks(base: Hooks = {}, override: Hooks = {}): Hooks {
	return {
		before: { ...base.before, ...defined(override.before ?? {}) },
		after: { ...base.after, ...defined(override.after ?? {}) },
		on: { ...base.on, ...defined(override.on ?? {}) },
	}
}

/** Merge `override` over `base`, deep-merging the `default` and `hooks` objects. */
function merge(base: PostboiConfig, override: PostboiConfig): PostboiConfig {
	return {
		...base,
		...defined(override),
		default: { ...base.default, ...defined(override.default ?? {}) },
		hooks: merge_hooks(base.hooks, override.hooks),
	}
}

let explicit: PostboiConfig = {}
let disk: PostboiConfig = {}
let disk_loaded = false

/**
 * Register global config imperatively. Useful in runtimes without filesystem access (edge,
 * Cloudflare Workers) where the file auto-load can't run. Calls merge, so it's additive.
 */
export function configure(config: PostboiConfig): void {
	explicit = merge(explicit, config)
}

/**
 * Project config helper for `postboi.config.ts`. Registers them as a side effect (so merely
 * importing the file is enough) and returns them, so it works as a typed `export default`.
 */
export function config(config: PostboiConfig): PostboiConfig {
	configure(config)
	return config
}

/** The current effective config (disk config underneath anything set via {@link configure}). */
export function get_config(): PostboiConfig {
	return merge(disk, explicit)
}

/** Reset all registered config. Intended for tests. */
export function reset_config(): void {
	explicit = {}
	disk = {}
	disk_loaded = false
}

/**
 * Ensure the config file has been read (once), then return the effective config. Called on
 * the `send()` path. Best-effort and Node/Bun-only — any failure falls back to whatever was set
 * via {@link configure}.
 */
export async function load_config(): Promise<PostboiConfig> {
	if (!disk_loaded) {
		disk_loaded = true
		disk = await read_disk()
	}
	return get_config()
}

const CONFIG_FILES = [
	"postboi.config.ts",
	"postboi.config.mts",
	"postboi.config.js",
	"postboi.config.mjs",
]

/** Find and import a `postboi.config.*` file, walking up from the cwd. */
async function read_disk(): Promise<PostboiConfig> {
	if (typeof process === "undefined" || !process.versions?.node) return {}
	try {
		const { existsSync } = await import("node:fs")
		const path = await import("node:path")
		const { pathToFileURL } = await import("node:url")

		let dir = process.cwd()
		for (;;) {
			const file = CONFIG_FILES.map((f) => path.join(dir, f)).find((f) => existsSync(f))
			if (file) {
				const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
					default?: PostboiConfig
					config?: PostboiConfig
				}
				const config = mod.default ?? mod.config
				return config && typeof config === "object" ? config : {}
			}
			const parent = path.dirname(dir)
			if (parent === dir) return {}
			dir = parent
		}
	} catch {
		// No fs, unreadable file, or a `.ts` file on a runtime that can't strip types — fall back.
		return {}
	}
}
