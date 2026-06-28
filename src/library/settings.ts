/**
 * Project-wide configuration. Set it once and every send — `send()`, `postboi/kit`, or any
 * provider instance — picks it up, so the 99% case is just calling `send()`.
 *
 * Drop a `postboi.settings.ts` at your project root:
 *
 * ```ts
 * import { defineSettings } from "postboi"
 *
 * export default defineSettings({
 * 	hooks: {
 * 		on_error: (ctx) => Sentry.captureException(ctx.error),
 * 	},
 * })
 * ```
 *
 * It's auto-loaded on the first `send()` (Node/Bun). In runtimes without filesystem access
 * (edge/Workers), call {@link configure} explicitly at startup instead.
 */
import type { Defaults, Hooks } from "./index.js"

/** Everything you can configure globally via `postboi.settings.ts` or {@link configure}. */
export interface PostboiSettings {
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
 * Ensure the settings file has been read (once), then return the effective settings. Called on
 * the `send()` path. Best-effort and Node/Bun-only — any failure falls back to whatever was set
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

/** Find and import a `postboi.settings.*` file, walking up from the cwd. */
async function read_disk(): Promise<PostboiSettings> {
	if (typeof process === "undefined" || !process.versions?.node) return {}
	try {
		const { existsSync } = await import("node:fs")
		const path = await import("node:path")
		const { pathToFileURL } = await import("node:url")

		let dir = process.cwd()
		for (;;) {
			const file = SETTINGS_FILES.map((f) => path.join(dir, f)).find((f) => existsSync(f))
			if (file) {
				const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
					default?: PostboiSettings
					settings?: PostboiSettings
				}
				const settings = mod.default ?? mod.settings
				return settings && typeof settings === "object" ? settings : {}
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
