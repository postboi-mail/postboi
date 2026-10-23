import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse_env } from "./env.js"
import { read_package, SVELTEKIT_CALL, VITE_CONFIGS } from "./project.js"

/**
 * Where a project says its own public domain out loud. Nothing here *decides* anything —
 * DNS setup is always the human's click at their registrar — so a hint only ever
 * prefills a prompt (interactive init) or seeds a suggestion (agent init), where a wrong
 * guess costs one keystroke.
 *
 * Signals, strongest intent first:
 *   1. CNAME file (GitHub Pages custom domain — the domain, verbatim)
 *   2. astro.config `site` / SvelteKit's origin (svelte.config, or `paths.origin` on its
 *      vite plugin) / nuxt.config `url`
 *   3. Next.js `metadataBase` (next.config or the root layout)
 *   4. wrangler routes and custom domains
 *   5. package.json `homepage`
 *   6. site-URL env vars (.env PUBLIC_SITE_URL, ORIGIN, APP_URL, …)
 */

export interface DomainHint {
	domain: string
	/** Human-readable provenance, e.g. `astro.config site` — shown next to the prefill. */
	source: string
}

/**
 * Hosts that are never *your* sending domain: dev loopbacks, reserved names, and the
 * platform-owned suffixes free deployments live on. Suffix match, so `app.vercel.app`
 * is rejected by `vercel.app`.
 */
const REJECT_SUFFIXES = [
	"localhost",
	".local",
	".test",
	".invalid",
	".internal",
	".example",
	"example.com",
	"example.org",
	"example.net",
	// platform-owned deployment hosts
	"vercel.app",
	"now.sh",
	"netlify.app",
	"pages.dev",
	"workers.dev",
	"github.io",
	"gitlab.io",
	"herokuapp.com",
	"fly.dev",
	"onrender.com",
	"railway.app",
	"surge.sh",
	"web.app",
	"firebaseapp.com",
	"azurewebsites.net",
	"azurestaticapps.net",
	"amplifyapp.com",
	"cloudfront.net",
	"amazonaws.com",
	"ngrok.io",
	"ngrok-free.app",
	"trycloudflare.com",
	"repl.co",
	"glitch.me",
	"webflow.io",
	"framer.app",
	"framer.website",
	"wixsite.com",
	"notion.site",
	// ours
	"postboi.app",
	"postboi.email",
]

/** A URL, origin, or bare host squeezed into a usable public hostname, or undefined. */
export function hostname_of(value: string): string | undefined {
	const raw = value.trim().replace(/^["']|["']$/g, "")
	if (!raw) return undefined
	let host: string
	try {
		host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase()
	} catch {
		return undefined
	}
	host = host.replace(/^www\./, "")

	// A public DNS name: dotted labels, no IPs, no underscores.
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
		return undefined
	}
	if (/^\d+(\.\d+)+$/.test(host)) return undefined
	// Label-boundary match: `demo.vercel.app` is platform-owned, `butterfly.dev` is not
	// `fly.dev` — a bare-string endsWith would reject real customer domains.
	if (
		REJECT_SUFFIXES.some((suffix) =>
			suffix.startsWith(".")
				? host.endsWith(suffix)
				: host === suffix || host.endsWith(`.${suffix}`)
		)
	) {
		return undefined
	}
	return host
}

/** Every `pattern` match of `regex` in `text`, as capture group 1. */
function matches(text: string, regex: RegExp): Array<string> {
	return Array.from(text.matchAll(regex), (match) => match[1])
}

function read_if_present(path: string): string {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : ""
	} catch {
		return ""
	}
}

/**
 * The project's likely public domain(s), best first, deduped. `dir` is the project root
 * (tests point it at a fixture; the CLI at the cwd).
 */
export function detect_domains(dir = "."): Array<DomainHint> {
	const hints: Array<DomainHint> = []
	const seen = new Set<string>()
	const add = (value: string | undefined, source: string) => {
		const domain = value ? hostname_of(value) : undefined
		if (!domain || seen.has(domain)) return
		seen.add(domain)
		hints.push({ domain, source })
	}
	const first = (paths: Array<string>): { path: string; text: string } | undefined => {
		for (const path of paths) {
			const text = read_if_present(join(dir, path))
			if (text) return { path, text }
		}
		return undefined
	}

	// 1. CNAME — the file *is* the domain.
	const cname = first(["CNAME", "static/CNAME", "public/CNAME"])
	if (cname) add(cname.text.split("\n")[0], cname.path)

	// 2. Framework configs that carry the site's canonical URL — one table, one loop,
	// so a fifth framework is an entry rather than a pasted stanza.
	const CONFIG_SIGNALS: Array<{
		paths: Array<string>
		regex: RegExp
		label: string
		/** The file only counts when this matches it. */
		when?: RegExp
	}> = [
		{
			paths: ["astro.config.mjs", "astro.config.ts", "astro.config.js"],
			regex: /\bsite:\s*["'`](https?:\/\/[^"'`]+)/g,
			label: "site",
		},
		{
			paths: ["svelte.config.js", "svelte.config.ts"],
			regex: /\borigin:\s*["'`](https?:\/\/[^"'`]+)/g,
			label: "origin",
		},
		// SvelteKit 3's `paths.origin`, on the sveltekit() call in vite.config.
		{
			paths: VITE_CONFIGS,
			regex: /\bpaths:\s*\{[^}]*?\borigin:\s*["'`](https?:\/\/[^"'`]+)/g,
			label: "paths.origin",
			when: SVELTEKIT_CALL,
		},
		{
			paths: ["nuxt.config.ts", "nuxt.config.js"],
			regex: /\burl:\s*["'`](https?:\/\/[^"'`]+)/g,
			label: "url",
		},
		// Next's metadataBase usually lives in the root layout rather than next.config.
		{
			paths: [
				"next.config.ts",
				"next.config.mjs",
				"next.config.js",
				"src/app/layout.tsx",
				"src/app/layout.jsx",
				"src/app/layout.ts",
				"src/app/layout.js",
				"app/layout.tsx",
				"app/layout.jsx",
				"app/layout.ts",
				"app/layout.js",
			],
			regex: /metadataBase[^\n]*?["'`](https?:\/\/[^"'`]+)["'`]/g,
			label: "metadataBase",
		},
	]
	for (const signal of CONFIG_SIGNALS) {
		const found = first(signal.paths)
		if (!found || (signal.when && !signal.when.test(found.text))) continue
		for (const url of matches(found.text, signal.regex)) {
			add(url, `${found.path} ${signal.label}`)
		}
	}

	// 3. wrangler routes/custom domains — `"pattern": "acme.com/*"`, `route = "acme.com/*"`.
	const wrangler = first(["wrangler.jsonc", "wrangler.json", "wrangler.toml"])
	if (wrangler) {
		const patterns = [
			...matches(wrangler.text, /"pattern":\s*"([^"]+)"/g),
			...matches(wrangler.text, /\broutes?\s*=\s*\[?\s*"([^"]+)"/g),
			...matches(wrangler.text, /\bpattern\s*=\s*"([^"]+)"/g),
		]
		for (const pattern of patterns) {
			add(
				pattern.replace(/^\*\./, "").replace(/\/.*$/, "").replace(/\*$/, ""),
				`${wrangler.path} routes`
			)
		}
	}

	// 4. package.json homepage.
	add(read_package(join(dir, "package.json"))?.homepage, "package.json homepage")

	// 5. Site-URL env vars. An allowlist, not a pattern: DATABASE_URL-style values also
	// parse to hostnames, and suggesting your database's host as a sending domain is
	// exactly the kind of clever that erodes trust.
	const SITE_KEYS = new Set(
		[
			"SITE_URL",
			"SITE_DOMAIN",
			"APP_URL",
			"BASE_URL",
			"CANONICAL_URL",
			"DOMAIN",
			"ORIGIN",
			"PUBLIC_URL",
			"URL",
		].flatMap((key) => [key, `PUBLIC_${key}`, `NEXT_PUBLIC_${key}`, `VITE_${key}`])
	)
	for (const env_file of [".env", ".env.local", ".env.production"]) {
		// The CLI's own dotenv grammar (quotes, comments, CRLF) rather than a second one
		// that would drift from it.
		for (const [key, value] of Object.entries(parse_env(read_if_present(join(dir, env_file))))) {
			if (SITE_KEYS.has(key)) add(value, `${env_file} ${key}`)
		}
	}

	return hints
}
