import type { Defaults } from "./index.js"
import { workers_env } from "./workers_env.js"

/**
 * Cross-runtime environment reading shared by every provider. Works in Node, Bun,
 * Vercel/Netlify functions, Deno and Cloudflare Workers, and falls back to a `.env` file
 * in dev (see {@link ensure_env_loaded}).
 */

/**
 * Values that aren't on `process.env`, read once. Two sources feed it. SvelteKit (and other
 * Vite dev servers) load `.env` files into their own `$env` modules, *not* `process.env`, so
 * a library reading `process.env` directly sees nothing in dev — we read the files
 * ourselves. Cloudflare Workers have no `process.env` at all without `nodejs_compat`, but
 * expose bindings on `cloudflare:workers`. `process.env` always wins over both, so
 * deployed/real env vars take precedence.
 */
let fallback: Record<string, string> | null = null

function parse_dotenv(text: string): Array<[string, string]> {
	const out: Array<[string, string]> = []
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (!line || line.startsWith("#")) continue
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
		if (!match) continue
		let value = match[2].trim()
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1)
		}
		out.push([match[1], value])
	}
	return out
}

/**
 * Populate the fallback once: Cloudflare Worker bindings, plus `.env` / `.env.local` from
 * the cwd (Node/Bun only). Best-effort — any failure leaves the fallback empty and we fall
 * through to `process.env` alone. Awaited on every send path, and cheap after the first call.
 */
export function ensure_env_loaded(): Promise<void> {
	// Cache the promise, not a done-flag: concurrent first sends must all wait for the
	// bindings rather than the losers racing past an empty fallback.
	return (loading ??= load_fallback())
}

let loading: Promise<void> | null = null

async function load_fallback(): Promise<void> {
	const out = await workers_env()
	fallback = out
	if (typeof process === "undefined" || !process.versions?.node) return
	try {
		const { existsSync, readFileSync } = await import("node:fs")
		const { join } = await import("node:path")
		const dir = process.cwd()
		// Later files win: `.env.local` overrides `.env`.
		for (const file of [".env", ".env.local"]) {
			const path = join(dir, file)
			if (!existsSync(path)) continue
			for (const [key, value] of parse_dotenv(readFileSync(path, "utf8"))) out[key] = value
		}
	} catch {
		// no fs / unreadable — fall back to process.env only
	}
}

/**
 * Read an environment variable across runtimes. Works in Node, Bun, Vercel/Netlify
 * functions, Deno and Cloudflare Workers, and falls back to a `.env` file in dev.
 * Worker bindings and `.env` values only appear once {@link ensure_env_loaded} has run,
 * which every send path awaits.
 */
export function read_env(name: string): string | undefined {
	if (typeof process !== "undefined" && process.env) {
		const value = process.env[name]
		if (value) return value
	}
	if (fallback && fallback[name]) return fallback[name]
	const deno = (globalThis as { Deno?: { env?: { get?(key: string): string | undefined } } }).Deno
	try {
		return deno?.env?.get?.(name) || undefined
	} catch {
		return undefined
	}
}

/**
 * Read the default field values shared by every provider from the environment. Only defined
 * values are included, so an unset env var never clobbers a default from postboi.config.ts.
 */
export function env_defaults(): Defaults {
	const env: Record<keyof Defaults, string> = {
		from: "POSTBOI_FROM",
		to: "POSTBOI_TO",
		cc: "POSTBOI_CC",
		bcc: "POSTBOI_BCC",
		reply_to: "POSTBOI_REPLY_TO",
	}
	const out: Defaults = {}
	for (const [key, name] of Object.entries(env) as Array<[keyof Defaults, string]>) {
		const value = read_env(name)
		// `as never`: writing through a union key demands the intersection of field types,
		// which a project-level `Register` augmentation can narrow below `string`.
		if (value !== undefined) out[key] = value as never
	}
	return out
}
