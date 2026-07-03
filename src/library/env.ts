import type { Defaults } from "./index.js"

/**
 * Cross-runtime environment reading shared by every provider. Works in Node, Bun,
 * Vercel/Netlify functions and Deno, and falls back to a `.env` file in dev (see
 * {@link ensure_env_loaded}).
 */

/**
 * `.env` values parsed as a fallback. SvelteKit (and other Vite dev servers) load `.env`
 * files into their own `$env` modules, *not* `process.env`, so a library reading
 * `process.env` directly sees nothing in dev. We fill that gap by reading the files
 * ourselves — `process.env` always wins, so deployed/real env vars take precedence.
 */
let dotenv: Record<string, string> | null = null

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
 * Load `.env` / `.env.local` from the cwd once (Node/Bun only). Best-effort: any failure
 * leaves the fallback empty and we fall through to `process.env` alone.
 */
export async function ensure_env_loaded(): Promise<void> {
	if (dotenv) return
	dotenv = {}
	if (typeof process === "undefined" || !process.versions?.node) return
	try {
		const { existsSync, readFileSync } = await import("node:fs")
		const { join } = await import("node:path")
		const dir = process.cwd()
		// Later files win: `.env.local` overrides `.env`.
		for (const file of [".env", ".env.local"]) {
			const path = join(dir, file)
			if (!existsSync(path)) continue
			for (const [key, value] of parse_dotenv(readFileSync(path, "utf8"))) dotenv[key] = value
		}
	} catch {
		// no fs / unreadable — fall back to process.env only
	}
}

/**
 * Read an environment variable across runtimes. Works in Node, Bun, Vercel/Netlify
 * functions and Deno, and falls back to a `.env` file in dev (see {@link ensure_env_loaded}).
 * Cloudflare Workers pass env via bindings rather than the ambient environment, so this
 * returns undefined there — pass credentials explicitly in Workers.
 */
export function read_env(name: string): string | undefined {
	if (typeof process !== "undefined" && process.env) {
		const value = process.env[name]
		if (value) return value
	}
	if (dotenv && dotenv[name]) return dotenv[name]
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
