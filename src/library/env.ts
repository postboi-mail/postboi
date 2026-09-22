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

/** Exported for tests: the CLI's env writer and this parser must agree on escapes. */
export function parse_dotenv(text: string): Array<[string, string]> {
	const out: Array<[string, string]> = []
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (!line || line.startsWith("#")) continue
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
		if (!match) continue
		let value = match[2].trim()
		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			// Standard dotenv behaviour, and what the CLI's own writer produces: escapes in
			// double-quoted values decode, so a multi-line credential (an FCM key) written as
			// \n sequences reaches providers as real newlines rather than literal backslashes.
			const escapes: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", r: "\r" }
			value = value.slice(1, -1).replace(/\\(["\\nr])/g, (_, c: string) => escapes[c])
		} else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
			value = value.slice(1, -1)
		}
		out.push([match[1], value])
	}
	return out
}

/**
 * Populate the fallback once: Cloudflare Worker bindings, plus `.env` / `.env.local` and
 * Cloudflare's `.dev.vars` from the cwd (Node/Bun only). Best-effort — any failure leaves
 * the fallback empty and we fall through to `process.env` alone. Awaited on every send path,
 * and cheap after the first call.
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
		// Later files win: `.env.local` overrides `.env`. Cloudflare Workers keep dev
		// secrets in `.dev.vars` (same dotenv format) — wrangler and adapter-cloudflare's
		// dev proxy read it but never put it on process.env, so a Vite/Node dev server
		// can't see a Worker's token without this. It wins over `.env*` when both exist.
		for (const file of [".env", ".env.local", ".dev.vars", ".dev.vars.local"]) {
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
type AddressDefault = "from" | "to" | "cc" | "bcc" | "reply_to"

/**
 * Variables already complained about. `env_defaults()` runs once per send — `mail()`
 * resolves its provider each time — so an unguarded warning here is one log line per
 * email, which is how a real one stops being read. Once per name per process, the same
 * bargain `warned_shadowed_from` strikes in mail.ts.
 */
const warned = new Set<string>()

function warn_once(name: string, message: string): void {
	if (warned.has(name)) return
	warned.add(name)
	console.warn(message)
}

/**
 * A flag from the environment, or undefined for one that isn't set. A value that is
 * neither yes nor no is **said out loud and then ignored**: these decide how mail looks,
 * and a typo that quietly meant "no" is a fortnight of unbranded email nobody notices.
 */
function read_flag(name: string): boolean | undefined {
	const value = read_env(name)?.trim().toLowerCase()
	if (value === undefined || value === "") return undefined
	if (["1", "true", "on", "yes"].includes(value)) return true
	if (["0", "false", "off", "no"].includes(value)) return false
	warn_once(name, `postboi: ${name} is "${value}", which is neither true nor false — ignoring it.`)
	return undefined
}

export function env_defaults(): Defaults {
	const env: Record<AddressDefault, string> = {
		from: "POSTBOI_FROM",
		to: "POSTBOI_TO",
		cc: "POSTBOI_CC",
		bcc: "POSTBOI_BCC",
		reply_to: "POSTBOI_REPLY_TO",
	}
	const out: Defaults = {}
	for (const [key, name] of Object.entries(env) as Array<[AddressDefault, string]>) {
		const value = read_env(name)
		// `as never`: writing through a union key demands the intersection of field types,
		// which a project-level `Register` augmentation can narrow below `string`.
		if (value !== undefined) out[key] = value as never
	}

	// How a Postboi send looks, for the runtimes a config file can't reach. An edge
	// worker or a Convex deployment has no filesystem and often no bundler we can hook,
	// so postboi.config.ts is simply absent there — but every one of them has environment
	// variables, which is why these three are worth reading twice.
	const letterhead = read_flag("POSTBOI_LETTERHEAD")
	if (letterhead !== undefined) out.letterhead = letterhead as never
	const shell = read_flag("POSTBOI_SHELL")
	if (shell !== undefined) out.shell = shell as never
	const style = read_env("POSTBOI_STYLE")?.trim().toLowerCase()
	if (style === "styled" || style === "plain") out.style = style as never
	else if (style) {
		warn_once(
			"POSTBOI_STYLE",
			`postboi: POSTBOI_STYLE is "${style}" — it takes "styled" or "plain". Ignoring it.`
		)
	}
	return out
}

/**
 * True only when the environment positively identifies itself as development. Deliberately
 * one-way: an unknown environment is treated as production, because the caller uses this to
 * decide whether a missing credential is a convenience (log it) or a fault (throw). Guessing
 * "development" wrong turns real mail into console noise; guessing "production" wrong only
 * costs a developer one clear error telling them to set a token. `test` is excluded so suites
 * keep asserting the real failure.
 */
export function is_development(): boolean {
	return read_env("NODE_ENV") === "development"
}
