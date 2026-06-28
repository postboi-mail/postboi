/**
 * Project-wide configuration. Set it once and every send — `send()`, `postboi/kit`, or any
 * provider instance — picks it up, so the 99% case is just calling `send()`.
 *
 * Two ways to provide it:
 *
 * 1. A `postboi.settings.ts` file at your project root (the only place hooks can live, since
 *    they're functions):
 *
 *    ```ts
 *    import { defineSettings } from "postboi"
 *
 *    export default defineSettings({
 *    	hooks: {
 *    		on_error: (ctx) => Sentry.captureException(ctx.error),
 *    	},
 *    })
 *    ```
 *
 * 2. A `"postboi"` key in `package.json`, for the JSON-serialisable options (no hooks):
 *
 *    ```json
 *    { "postboi": { "provider": "resend", "retries": 2, "auto_text": true } }
 *    ```
 *
 * Both are auto-loaded on the first `send()` (Node/Bun). In runtimes without filesystem
 * access (edge/Workers), call {@link configure} explicitly at startup instead.
 */
import type { Defaults, Hooks } from "./index.js"

/** The JSON-serialisable options, valid in both a settings file and the `package.json` key. */
export interface PostboiConfig {
	/** Provider key (`resend`, `mailgun`, …) for the zero-config `send()`. `POSTBOI_PROVIDER` wins. */
	provider?: string
	/** Default fields applied to every send. Merged under `POSTBOI_*` env vars, which win. */
	default?: Defaults
	/** Per-request timeout in milliseconds. */
	timeout?: number
	/** Retries on network / 429 / 5xx errors. */
	retries?: number
	/** Base retry backoff in milliseconds (doubles each attempt). */
	retry_delay?: number
	/** Derive a plain-text body from the HTML body when `text` is omitted. */
	auto_text?: boolean
}

/** Everything you can configure globally. The settings file may add `hooks`; `package.json` can't. */
export interface PostboiSettings extends PostboiConfig {
	/** Lifecycle hooks run around every send (the main reason to use a settings file). */
	hooks?: Hooks
}

/** Keep only defined entries so a shallow merge never clobbers a value with `undefined`. */
function defined<T extends object>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(obj)) if (value !== undefined) out[key] = value
	return out as Partial<T>
}

/** Merge `override` over `base`, deep-merging the `default` and `hooks` objects. */
function merge(base: PostboiSettings, override: PostboiSettings): PostboiSettings {
	return {
		...base,
		...defined(override),
		default: { ...base.default, ...defined(override.default ?? {}) },
		hooks: { ...base.hooks, ...defined(override.hooks ?? {}) },
	}
}

let explicit: PostboiSettings = {}
let disk: PostboiSettings = {}
let disk_loaded = false

/**
 * Register global settings imperatively. Useful in runtimes without filesystem access (edge,
 * Cloudflare Workers) where the file auto-load can't run. Calls merge, so it's additive.
 */
export function configure(settings: PostboiSettings): void {
	explicit = merge(explicit, settings)
}

/**
 * Define settings in a `postboi.settings.ts` file. Registers them as a side effect (so merely
 * importing the file is enough) and returns them, so it works as a typed `export default`.
 */
export function defineSettings(settings: PostboiSettings): PostboiSettings {
	configure(settings)
	return settings
}

/** The current effective settings (disk config underneath anything set via {@link configure}). */
export function get_settings(): PostboiSettings {
	return merge(disk, explicit)
}

/** Reset all registered settings. Intended for tests. */
export function reset_settings(): void {
	explicit = {}
	disk = {}
	disk_loaded = false
}

/**
 * Ensure on-disk config has been read (once), then return the effective settings. Called on the
 * `send()` path. Best-effort and Node/Bun-only — any failure falls back to whatever was set
 * via {@link configure}.
 */
export async function load_settings(): Promise<PostboiSettings> {
	if (!disk_loaded) {
		disk_loaded = true
		disk = await read_disk()
	}
	return get_settings()
}

const SETTINGS_FILES = [
	"postboi.settings.ts",
	"postboi.settings.mts",
	"postboi.settings.js",
	"postboi.settings.mjs",
]

/** Read `package.json`'s `postboi` key and a `postboi.settings.*` file, if present. */
async function read_disk(): Promise<PostboiSettings> {
	if (typeof process === "undefined" || !process.versions?.node) return {}
	try {
		const { readFileSync, existsSync } = await import("node:fs")
		const path = await import("node:path")
		const { pathToFileURL } = await import("node:url")

		// Walk up to the nearest package.json so it works from sub-directories.
		let root = process.cwd()
		while (!existsSync(path.join(root, "package.json"))) {
			const parent = path.dirname(root)
			if (parent === root) break
			root = parent
		}

		let result: PostboiSettings = {}

		const pkg_path = path.join(root, "package.json")
		if (existsSync(pkg_path)) {
			const pkg = JSON.parse(readFileSync(pkg_path, "utf8")) as { postboi?: PostboiConfig }
			if (pkg.postboi && typeof pkg.postboi === "object") result = merge(result, pkg.postboi)
		}

		const file = SETTINGS_FILES.map((f) => path.join(root, f)).find((f) => existsSync(f))
		if (file) {
			const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
				default?: PostboiSettings
				settings?: PostboiSettings
			}
			const settings = mod.default ?? mod.settings
			if (settings && typeof settings === "object") result = merge(result, settings)
		}

		return result
	} catch {
		// No fs, unreadable file, or a `.ts` file on a runtime that can't strip types — fall back.
		return {}
	}
}
