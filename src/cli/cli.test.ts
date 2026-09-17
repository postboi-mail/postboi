import { describe, it, expect, vi } from "vitest"
import { Readable, Writable } from "node:stream"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
	PROVIDERS,
	DEFAULT_FIELDS,
	usage_snippet,
	render_config,
	render_block,
} from "./providers.js"
import {
	detect_env_targets,
	format_line,
	upsert_env,
	remove_env,
	is_gitignored,
	parse_env,
} from "./env.js"
import {
	detect_hosts,
	detect_adapter_host,
	host_invocation,
	link_args,
	link_state,
	push_spec,
	manual_hint,
} from "./deploy.js"
import {
	add_remote_exclude,
	add_vite_plugin,
	detect_package_manager,
	has_dependency,
	install_command,
	is_bundled_framework,
} from "./project.js"
import {
	create_prompts,
	create_auto_prompts,
	AgentAnswerError,
	PromptCancelledError,
} from "./prompts.js"
import { banner } from "./banner.js"
import {
	cloud_base,
	start_device_auth,
	poll_device_auth,
	provision_account,
	fetch_domains,
	fetch_forms,
	fetch_env_vars,
	push_env_vars,
	start_connect,
	poll_connect,
	PostboiAuthError,
} from "./postboi.js"
import { credential_env_keys } from "../library/registry.js"
import {
	render_types,
	render_runtime,
	parse_from,
	parse_forms,
	parse_provider,
	parse_runtime,
	config_captcha_key,
	config_provider,
	upsert_captcha_key,
	from_status,
} from "./typegen.js"
import { bundled_skill, offer_skill, refresh_skill, skill_command } from "./skill.js"
import { detect_domains, hostname_of } from "./domain_hint.js"
import { find_auth_keys, offer_auth_key, verify_apns } from "./apns.js"

// verify_apns drives the real APNs provider, whose transport is HTTP/2 rather than
// fetch — so this is the seam to stub, exactly as `fetch` is everywhere else.
const http2_fetch = vi.hoisted(() => vi.fn())
vi.mock("../library/push/http2.js", () => ({ http2_fetch, close_http2_sessions: () => {} }))

/** A fake fetch Response — the shape every API-flow test hands to its fetch stub. */
function json(body: unknown, status = 200): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe("provider registry", () => {
	it("lists the configurable providers with complete metadata", () => {
		expect(PROVIDERS.length).toBeGreaterThanOrEqual(14)
		for (const p of PROVIDERS) {
			expect(p.key, p.name).toMatch(/^[a-z0-9]+$/)
			expect(p.import.startsWith("postboi/"), p.name).toBe(true)
			expect(p.url.startsWith("https://"), p.name).toBe(true)
			expect(p.fields.length, p.name).toBeGreaterThan(0)
			for (const f of p.fields) {
				expect(f.env, p.name).toMatch(/^[A-Z0-9_]+$/)
				expect(f.arg.length, p.name).toBeGreaterThan(0)
			}
		}
	})

	it("excludes the mock and cloud providers", () => {
		const keys = PROVIDERS.map((p) => p.key)
		expect(keys).not.toContain("mock")
		expect(keys).not.toContain("cloud")
	})

	it("renders a usage snippet from the fields", () => {
		const mailgun = PROVIDERS.find((p) => p.key === "mailgun")!
		const snippet = usage_snippet(mailgun)
		expect(snippet).toContain('import Mailgun from "postboi/mailgun"')
		expect(snippet).toContain("api_key: process.env.MAILGUN_API_KEY")
		expect(snippet).toContain("domain: process.env.MAILGUN_DOMAIN")
		expect(snippet).not.toContain("default:")
	})

	it("includes a default block when defaults are provided", () => {
		const resend = PROVIDERS.find((p) => p.key === "resend")!
		const snippet = usage_snippet(resend, [
			{ arg: "from", env: "POSTBOI_FROM" },
			{ arg: "to", env: "POSTBOI_TO" },
		])
		expect(snippet).toContain("default: {")
		expect(snippet).toContain("from: process.env.POSTBOI_FROM")
		expect(snippet).toContain("to: process.env.POSTBOI_TO")
	})

	it("renders a config file with provider, defaults and non-secret options", () => {
		const out = render_config(
			"mailgun",
			{ from: "no-reply@example.com" },
			{ domain: "mg.example.com" }
		)
		expect(out).toContain('import { config } from "postboi"')
		expect(out).toContain('provider: "mailgun",')
		expect(out).toContain('from: "no-reply@example.com",')
		expect(out).toContain('domain: "mg.example.com",')
		expect(out).toContain("hooks: {")
	})

	it("omits empty default / options blocks from the config file", () => {
		const out = render_config("resend", {}, {})
		expect(out).toContain('provider: "resend",')
		expect(out).not.toContain("default: {")
		expect(out).not.toContain("options: {")
	})

	it("render_block returns empty string for no entries and escapes values", () => {
		expect(render_block("default", {})).toBe("")
		expect(render_block("options", { region: 'a"b' })).toContain('region: "a\\"b",')
	})

	it("maps default fields to POSTBOI_* env vars (no subject)", () => {
		const envs = DEFAULT_FIELDS.map((f) => f.env)
		expect(envs).toEqual([
			"POSTBOI_FROM",
			"POSTBOI_TO",
			"POSTBOI_REPLY_TO",
			"POSTBOI_CC",
			"POSTBOI_BCC",
		])
		expect(DEFAULT_FIELDS.map((f) => f.arg)).not.toContain("subject")
	})
})

describe("env detection", () => {
	it("falls back to .env when nothing is present", () => {
		expect(detect_env_targets([])).toEqual([{ file: ".env", format: "dotenv" }])
	})

	it("recognises each flavour", () => {
		expect(detect_env_targets([".env"])).toEqual([{ file: ".env", format: "dotenv" }])
		expect(detect_env_targets([".envrc"])).toEqual([{ file: ".envrc", format: "direnv" }])
		expect(detect_env_targets([".dev.vars"])).toEqual([{ file: ".dev.vars", format: "devvars" }])
	})

	it("treats .env.schema as varlock with a note", () => {
		const [target] = detect_env_targets([".env.schema"])
		expect(target.file).toBe(".env")
		expect(target.note).toMatch(/varlock/)
	})

	it("collects multiple targets when several are present", () => {
		const targets = detect_env_targets([".env", ".dev.vars", ".envrc"])
		expect(targets.map((t) => t.file)).toEqual([".env", ".envrc", ".dev.vars"])
	})
})

describe("env file writing", () => {
	it("formats per flavour", () => {
		expect(format_line("dotenv", "K", "v")).toBe('K="v"')
		expect(format_line("direnv", "K", "v")).toBe('export K="v"')
		expect(format_line("devvars", "K", "v")).toBe('K="v"')
	})

	it("appends a new key, preserving existing content", () => {
		const out = upsert_env("EXISTING=1\n", "RESEND_API_KEY", "re_1", "dotenv")
		expect(out).toBe('EXISTING=1\nRESEND_API_KEY="re_1"\n')
	})

	it("replaces an existing key in place (any flavour)", () => {
		expect(upsert_env('K="old"\n', "K", "new", "dotenv")).toBe('K="new"\n')
		expect(upsert_env('export K="old"\n', "K", "new", "direnv")).toBe('export K="new"\n')
	})

	it("escapes quotes and backslashes", () => {
		expect(format_line("dotenv", "K", 'a"b\\c')).toBe('K="a\\"b\\\\c"')
	})

	it("escapes newlines so a multi-line value cannot corrupt the file", () => {
		// An FCM service-account key is a multi-line PEM; raw newlines would split it
		// across lines and garble everything after it.
		const pem = "-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----"
		const line = format_line("dotenv", "FCM_PRIVATE_KEY", pem)
		expect(line).not.toContain("\n")
		expect(parse_env(`${line}\nOTHER=1\n`)).toEqual({ FCM_PRIVATE_KEY: pem, OTHER: "1" })
	})

	it("parse_env reads quoted, exported and bare assignments, skipping comments", () => {
		expect(
			parse_env('# comment\nRESEND_API_KEY="re_1"\nexport K="v"\nBARE=plain\nnot a line\n')
		).toEqual({ RESEND_API_KEY: "re_1", K: "v", BARE: "plain" })
	})

	it("parse_env accepts whitespace around =, like the library's own parse_dotenv", () => {
		// A hand-written `KEY = value` loads fine at runtime, so the push sweep must see it
		// too — otherwise the credential the project demonstrably uses is never synced.
		expect(parse_env("TWILIO_AUTH_TOKEN = abc123\nexport K =  v\n")).toEqual({
			TWILIO_AUTH_TOKEN: "abc123",
			K: "v",
		})
	})

	it("round-trips a value ending in a backslash — the writer's and parser's escapes agree", () => {
		// quote() writes `KEY="…\\"`: the final quote is real, the backslash before it is
		// escaped. Reading that as an unterminated string would swallow every line after
		// it — including other secrets — into this value.
		const line = format_line("dotenv", "A", "abc123\\")
		expect(parse_env(`${line}\nRESEND_API_KEY="re_9"\n`)).toEqual({
			A: "abc123\\",
			RESEND_API_KEY: "re_9",
		})
	})

	it("upsert_env replaces a multi-line quoted value whole, not just its first line", () => {
		// A hand-pasted PEM spans lines legally; replacing only line one would leave the
		// tail dangling, and its orphaned closing quote corrupts every assignment after it.
		const content = 'FCM_KEY="-----BEGIN\nabc\ndef\n-----END"\nOTHER=1\n'
		expect(upsert_env(content, "FCM_KEY", "new", "dotenv")).toBe('FCM_KEY="new"\nOTHER=1\n')
		expect(remove_env(content, "FCM_KEY")).toBe("OTHER=1\n")
	})

	it("remove_env drops the key line (any flavour) and leaves everything else", () => {
		expect(remove_env('POSTBOI_TOKEN="t"\nPOSTBOI_FROM="a@b.c"\n', "POSTBOI_FROM")).toBe(
			'POSTBOI_TOKEN="t"\n'
		)
		expect(remove_env('export POSTBOI_FROM="a@b.c"\nOTHER=1\n', "POSTBOI_FROM")).toBe("OTHER=1\n")
		expect(remove_env("OTHER=1\n", "POSTBOI_FROM")).toBe("OTHER=1\n")
	})
})

describe("gitignore detection", () => {
	it("matches plain names and globs", () => {
		expect(is_gitignored(".env\nnode_modules\n", ".env")).toBe(true)
		expect(is_gitignored(".env*\n", ".env.local")).toBe(true)
		expect(is_gitignored("node_modules\n", ".env")).toBe(false)
		expect(is_gitignored("# .env\n", ".env")).toBe(false)
	})
})

describe("deploy detection", () => {
	it("detects hosts from project files", () => {
		expect(detect_hosts([".vercel"])).toEqual(["vercel"])
		expect(detect_hosts(["wrangler.toml"])).toEqual(["cloudflare"])
		expect(detect_hosts(["netlify.toml"])).toEqual(["netlify"])
		expect(detect_hosts(["railway.json"])).toEqual(["railway"])
		expect(detect_hosts(["package.json"])).toEqual([])
	})

	it("detects the host from the SvelteKit adapter in config sources", () => {
		expect(detect_adapter_host(['import adapter from "@sveltejs/adapter-vercel"'])).toBe("vercel")
		expect(detect_adapter_host(['"@sveltejs/adapter-cloudflare-workers": "^1.0.0"'])).toBe(
			"cloudflare"
		)
		expect(detect_adapter_host(['import adapter from "@sveltejs/adapter-netlify"'])).toBe("netlify")
		expect(detect_adapter_host(['import adapter from "@sveltejs/adapter-node"'])).toBeNull()
		expect(detect_adapter_host([])).toBeNull()
	})

	const direct = { cmd: "vercel", prefix: [] }

	it("builds upserting push commands (secrets via stdin, netlify via arg)", () => {
		// Every push overwrites: the user chose to push freshly-collected credentials, so
		// a stale existing value winning would be the surprise. Vercel spells that --force.
		expect(push_spec(direct, "vercel", "K", "v")).toEqual({
			cmd: "vercel",
			args: ["env", "add", "K", "production", "--force"],
			stdin: "v",
		})
		expect(push_spec({ cmd: "wrangler", prefix: [] }, "cloudflare", "K", "v")).toEqual({
			cmd: "wrangler",
			args: ["secret", "put", "K"],
			stdin: "v",
		})
		expect(push_spec({ cmd: "netlify", prefix: [] }, "netlify", "K", "v")).toEqual({
			cmd: "netlify",
			args: ["env:set", "K", "v"],
			unsafe_on_windows: false,
		})
		expect(push_spec({ cmd: "railway", prefix: [] }, "railway", "K", "v")).toEqual({
			cmd: "railway",
			args: ["variables", "--set", "K=v"],
			unsafe_on_windows: false,
		})
	})

	it("flags argv-borne values cmd.exe would mangle, but never stdin-borne ones", () => {
		// Windows runs these through a shell (the CLIs are .cmd shims) with no argv
		// escaping — a JSON secret or a URL with query params must not be split or executed.
		const json = '{"type": "service_account"}'
		expect(push_spec({ cmd: "netlify", prefix: [] }, "netlify", "K", json).unsafe_on_windows).toBe(
			true
		)
		expect(
			push_spec({ cmd: "railway", prefix: [] }, "railway", "K", "https://h/x?a=1&b=2")
				.unsafe_on_windows
		).toBe(true)
		// Vercel and Cloudflare take the value on stdin, so nothing rides through the shell.
		expect(push_spec(direct, "vercel", "K", json).unsafe_on_windows).toBeUndefined()
	})

	it("falls back to the package runner when the host CLI isn't installed", () => {
		expect(host_invocation("cloudflare", "bun", () => true)).toEqual({
			cmd: "wrangler",
			prefix: [],
			via_runner: false,
		})
		expect(host_invocation("cloudflare", "bun", () => false)).toEqual({
			cmd: "bunx",
			prefix: ["wrangler"],
			via_runner: true,
		})
		// The netlify binary lives in the netlify-cli package; railway in @railway/cli.
		expect(host_invocation("netlify", "npm", () => false)).toEqual({
			cmd: "npx",
			prefix: ["--yes", "netlify-cli"],
			via_runner: true,
		})
		expect(host_invocation("railway", "pnpm", () => false)).toEqual({
			cmd: "pnpm",
			prefix: ["dlx", "@railway/cli"],
			via_runner: true,
		})
		const runnered = push_spec(
			host_invocation("cloudflare", "bun", () => false),
			"cloudflare",
			"K",
			"v"
		)
		expect(runnered).toEqual({ cmd: "bunx", args: ["wrangler", "secret", "put", "K"], stdin: "v" })
	})

	it("knows each host's link state and link command", () => {
		expect(link_state("vercel", [], (p) => p === ".vercel/project.json")).toBe("linked")
		expect(link_state("vercel", [], () => false)).toBe("unlinked")
		expect(link_state("netlify", [], (p) => p === ".netlify/state.json")).toBe("linked")
		expect(link_state("cloudflare", ["wrangler.jsonc"], () => false)).toBe("linked")
		expect(link_state("cloudflare", [".dev.vars"], () => false)).toBe("unlinked")
		// Railway keeps link state in its global config — nothing local to check.
		expect(link_state("railway", [], () => false)).toBe("unknown")

		expect(link_args("vercel")).toEqual(["link"])
		expect(link_args("railway")).toEqual(["link"])
		// Cloudflare's link is the config file itself, not a CLI command.
		expect(link_args("cloudflare")).toBeNull()
	})

	it("offers a manual hint per host", () => {
		expect(manual_hint("vercel", "K")).toContain("vercel env add K")
		expect(manual_hint("cloudflare", "K")).toContain("wrangler secret put K")
		expect(manual_hint("railway", "K")).toContain("railway variables --set")
	})
})

describe("project detection", () => {
	it("detects the package manager from packageManager then lockfile", () => {
		expect(detect_package_manager([], { packageManager: "pnpm@9.0.0" })).toBe("pnpm")
		expect(detect_package_manager(["bun.lock"])).toBe("bun")
		expect(detect_package_manager(["pnpm-lock.yaml"])).toBe("pnpm")
		expect(detect_package_manager(["yarn.lock"])).toBe("yarn")
		expect(detect_package_manager(["package-lock.json"])).toBe("npm")
		expect(detect_package_manager([])).toBe("npm")
	})

	it("checks all dependency maps for postboi", () => {
		expect(has_dependency({ dependencies: { postboi: "^1" } }, "postboi")).toBe(true)
		expect(has_dependency({ devDependencies: { postboi: "^1" } }, "postboi")).toBe(true)
		expect(has_dependency({ dependencies: { other: "^1" } }, "postboi")).toBe(false)
		expect(has_dependency(undefined, "postboi")).toBe(false)
	})

	it("builds the install command per manager", () => {
		expect(install_command("bun", "postboi")).toEqual({ cmd: "bun", args: ["add", "postboi"] })
		expect(install_command("pnpm", "postboi")).toEqual({ cmd: "pnpm", args: ["add", "postboi"] })
		expect(install_command("npm", "postboi")).toEqual({ cmd: "npm", args: ["install", "postboi"] })
	})

	it("adds -D for a dev install with every manager", () => {
		expect(install_command("bun", "postboi", true)).toEqual({
			cmd: "bun",
			args: ["add", "-D", "postboi"],
		})
		expect(install_command("pnpm", "postboi", true)).toEqual({
			cmd: "pnpm",
			args: ["add", "-D", "postboi"],
		})
		expect(install_command("yarn", "postboi", true)).toEqual({
			cmd: "yarn",
			args: ["add", "-D", "postboi"],
		})
		expect(install_command("npm", "postboi", true)).toEqual({
			cmd: "npm",
			args: ["install", "-D", "postboi"],
		})
	})

	it("detects bundled frameworks from config file or packages", () => {
		expect(is_bundled_framework(["svelte.config.js"])).toBe(true)
		expect(is_bundled_framework(["svelte.config.ts"])).toBe(true)
		expect(is_bundled_framework(["nuxt.config.ts"])).toBe(true)
		expect(is_bundled_framework([], { devDependencies: { svelte: "^5" } })).toBe(true)
		expect(is_bundled_framework([], { devDependencies: { "@sveltejs/kit": "^2" } })).toBe(true)
		expect(is_bundled_framework([], { dependencies: { nuxt: "^4" } })).toBe(true)
		expect(is_bundled_framework([], { devDependencies: { "@solidjs/start": "^1" } })).toBe(true)
		expect(is_bundled_framework([], { dependencies: { "@tanstack/react-start": "^1" } })).toBe(true)
		expect(is_bundled_framework([], { devDependencies: { "@analogjs/platform": "^1" } })).toBe(true)
	})

	it("leaves externalising frameworks (Next, Remix, Astro) as regular deps", () => {
		expect(is_bundled_framework(["astro.config.mjs"], { dependencies: { astro: "^5" } })).toBe(
			false
		)
		expect(is_bundled_framework(["next.config.js"], { dependencies: { next: "^15" } })).toBe(false)
		expect(is_bundled_framework(["vite.config.ts"], { dependencies: { react: "^19" } })).toBe(false)
		expect(is_bundled_framework([])).toBe(false)
	})
})

describe("banner", () => {
	it("renders the multi-line wordmark and tagline", () => {
		const out = banner()
		expect(out.split("\n").length).toBeGreaterThan(5) // figlet art is multi-line
		expect(out).toContain("every channel, zero config")
	})

	it("degrades to plain text when stdout isn't a TTY", () => {
		expect(banner().includes("\x1b")).toBe(false) // no ANSI escape character
	})
})

describe("cloud device flow", () => {
	const start = { code: "abc123", url: "https://postboi.app/cli?code=abc123" }

	it("cloud_base defaults to postboi.app and honours POSTBOI_API_URL", () => {
		const original = process.env.POSTBOI_API_URL
		delete process.env.POSTBOI_API_URL
		expect(cloud_base()).toBe("https://postboi.app")
		process.env.POSTBOI_API_URL = "http://localhost:5173/"
		expect(cloud_base()).toBe("http://localhost:5173") // trailing slash stripped
		if (original === undefined) delete process.env.POSTBOI_API_URL
		else process.env.POSTBOI_API_URL = original
	})

	it("start_device_auth returns the code and claim URL with defaults filled in", async () => {
		const result = await start_device_auth("https://postboi.app", async () => json(start))
		expect(result).toEqual({ ...start, expires_in: 600, interval: 2 })
	})

	it("start_device_auth wraps network and server failures in a friendly error", async () => {
		await expect(
			start_device_auth("https://postboi.app", async () => {
				throw new Error("ECONNREFUSED")
			})
		).rejects.toBeInstanceOf(PostboiAuthError)
		await expect(
			start_device_auth("https://postboi.app", async () => json({}, 500))
		).rejects.toBeInstanceOf(PostboiAuthError)
	})

	it("poll_device_auth polls until claimed and returns the claim", async () => {
		const responses = [
			json({ status: "pending", interval: 2 }),
			json({ status: "pending", interval: 2 }),
			json({ status: "claimed", token: "pb_secret", send_address: "joe@send.postboi.email" }),
		]
		const claim = await poll_device_auth(
			"https://postboi.app",
			{ ...start, expires_in: 600, interval: 2 },
			{ fetch: async () => responses.shift()!, sleep: async () => {}, now: () => 0 }
		)
		expect(claim).toEqual({ token: "pb_secret", send_address: "joe@send.postboi.email" })
	})

	it("poll_device_auth tolerates servers that don't send send_address", async () => {
		const claim = await poll_device_auth(
			"https://postboi.app",
			{ ...start, expires_in: 600, interval: 2 },
			{ fetch: async () => json({ status: "claimed", token: "pb_secret" }), sleep: async () => {} }
		)
		expect(claim).toEqual({ token: "pb_secret", send_address: undefined })
	})

	it("poll_device_auth fails fast on an invalid or expired code", async () => {
		await expect(
			poll_device_auth(
				"https://postboi.app",
				{ ...start, expires_in: 600, interval: 2 },
				{ fetch: async () => json({ error: "expired" }, 410), sleep: async () => {} }
			)
		).rejects.toBeInstanceOf(PostboiAuthError)
	})

	it("poll_device_auth times out at the deadline", async () => {
		let clock = 0
		await expect(
			poll_device_auth(
				"https://postboi.app",
				{ ...start, expires_in: 600, interval: 2 },
				{
					fetch: async () => json({ status: "pending", interval: 2 }),
					sleep: async () => {
						clock += 300_000
					},
					now: () => clock,
				}
			)
		).rejects.toThrow(/timed out/i)
	})
})

describe("provision_account (zero setup)", () => {
	it("posts the project's name and slug and returns the claimable account", async () => {
		let posted: { url: string; body: unknown } | undefined
		const result = await provision_account(
			"https://postboi.app",
			{ name: "acme-site", slug: "acme-site" },
			async (url, init) => {
				posted = { url, body: JSON.parse(String(init?.body)) }
				return json({
					token: "pb_secret",
					send_address: "acme-site@send.postboi.email",
					claim_url: "https://postboi.app/claim/abc",
					expires_in_days: 14,
				})
			}
		)
		expect(posted).toEqual({
			url: "https://postboi.app/api/cli/provision",
			body: { name: "acme-site", slug: "acme-site" },
		})
		expect(result).toEqual({
			token: "pb_secret",
			send_address: "acme-site@send.postboi.email",
			claim_url: "https://postboi.app/claim/abc",
			expires_in_days: 14,
		})
	})

	it("relays the API's message on a rejection (rate limit)", async () => {
		await expect(
			provision_account("https://postboi.app", {}, async () =>
				json({ message: "You've set up 5 projects today", code: "rate_limited" }, 429)
			)
		).rejects.toThrow(/5 projects today/)
	})

	it("explains itself against an API that predates provisioning", async () => {
		await expect(
			provision_account("https://postboi.app", {}, async () => json({ ok: true }))
		).rejects.toThrow(/without --agent/)
	})

	it("wraps network failures in a friendly error", async () => {
		await expect(
			provision_account("https://postboi.app", {}, async () => {
				throw new Error("ECONNREFUSED")
			})
		).rejects.toBeInstanceOf(PostboiAuthError)
	})
})

describe("domain hints", () => {
	/** A throwaway project directory holding exactly `files`. */
	function project(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "postboi-domains-"))
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true })
			writeFileSync(join(dir, path), content)
		}
		return dir
	}

	it("hostname_of normalises URLs, origins and bare hosts", () => {
		expect(hostname_of("https://www.acme.com/about")).toBe("acme.com")
		expect(hostname_of("acme.co.uk")).toBe("acme.co.uk")
		expect(hostname_of('"https://acme.com"')).toBe("acme.com")
	})

	it("hostname_of rejects what can't be a sending domain", () => {
		expect(hostname_of("http://localhost:5173")).toBeUndefined()
		expect(hostname_of("192.168.0.1")).toBeUndefined()
		expect(hostname_of("https://demo.vercel.app")).toBeUndefined()
		expect(hostname_of("https://my-site.pages.dev")).toBeUndefined()
		expect(hostname_of("https://example.com")).toBeUndefined()
		expect(hostname_of("justoneword")).toBeUndefined()
		expect(hostname_of("")).toBeUndefined()
	})

	it("hostname_of matches platform suffixes on label boundaries only", () => {
		// Real customer domains that merely end with a platform suffix's spelling.
		expect(hostname_of("https://butterfly.dev")).toBe("butterfly.dev")
		expect(hostname_of("https://myweb.app")).toBe("myweb.app")
		expect(hostname_of("https://snow.sh")).toBe("snow.sh")
		expect(hostname_of("https://grandexample.com")).toBe("grandexample.com")
		// The platforms themselves and their subdomains stay rejected.
		expect(hostname_of("https://fly.dev")).toBeUndefined()
		expect(hostname_of("https://my-app.fly.dev")).toBeUndefined()
	})

	it("reads the domain out of a CNAME file, verbatim", () => {
		const dir = project({ CNAME: "acme.com\n" })
		expect(detect_domains(dir)[0]).toEqual({ domain: "acme.com", source: "CNAME" })
	})

	it("reads astro's site, package.json homepage and wrangler routes", () => {
		const astro = project({ "astro.config.mjs": 'export default { site: "https://www.acme.dev" }' })
		expect(detect_domains(astro)[0]).toEqual({
			domain: "acme.dev",
			source: "astro.config.mjs site",
		})

		const pkg = project({ "package.json": '{ "homepage": "https://acme.studio" }' })
		expect(detect_domains(pkg)[0]).toEqual({
			domain: "acme.studio",
			source: "package.json homepage",
		})

		const wrangler = project({
			"wrangler.jsonc": '{ "routes": [{ "pattern": "acme.io/*", "custom_domain": true }] }',
		})
		expect(detect_domains(wrangler)[0]).toEqual({
			domain: "acme.io",
			source: "wrangler.jsonc routes",
		})
	})

	it("reads site-URL env vars but never credential-shaped ones", () => {
		const dir = project({
			".env": [
				"DATABASE_URL=postgres://db.supabase.co/postgres",
				"PUBLIC_SITE_URL=https://acme.gallery",
			].join("\n"),
		})
		const hints = detect_domains(dir)
		expect(hints).toEqual([{ domain: "acme.gallery", source: ".env PUBLIC_SITE_URL" }])
	})

	it("ranks stronger signals first and dedupes across files", () => {
		const dir = project({
			CNAME: "acme.com",
			"package.json": '{ "homepage": "https://acme.com" }',
			".env": "PUBLIC_SITE_URL=https://app.acme.com",
		})
		expect(detect_domains(dir)).toEqual([
			{ domain: "acme.com", source: "CNAME" },
			{ domain: "app.acme.com", source: ".env PUBLIC_SITE_URL" },
		])
	})

	it("finds nothing in a project that says nothing", () => {
		expect(detect_domains(project({ "package.json": '{ "name": "quiet" }' }))).toEqual([])
	})
})

describe("auto prompts (--agent)", () => {
	const options = [
		{ label: "One", value: 1 },
		{ label: "Two", value: 2 },
	]

	it("answers every prompt the way pressing Enter would", async () => {
		const prompts = create_auto_prompts()
		expect(prompts.agent).toBe(true)
		expect(await prompts.ask("Name?", { default: "acme" })).toBe("acme")
		expect(await prompts.ask("Optional?")).toBe("")
		expect(await prompts.select("Pick one", options)).toBe(1)
		expect(await prompts.confirm("Sure?")).toBe(true)
		expect(await prompts.confirm("Sure?", false)).toBe(false)
	})

	it("throws rather than loops on a required question with no default", async () => {
		const prompts = create_auto_prompts()
		await expect(prompts.ask("API key (RESEND_API_KEY)", { required: true })).rejects.toThrow(
			AgentAnswerError
		)
		await expect(prompts.ask("API key (RESEND_API_KEY)", { required: true })).rejects.toThrow(
			/RESEND_API_KEY/
		)
	})

	it("the interactive prompter identifies itself as non-agent", async () => {
		const prompts = create_prompts({
			input: Readable.from([]),
			output: new Writable({ write: (_chunk, _enc, cb) => cb() }),
		})
		expect(prompts.agent).toBe(false)
		prompts.close()
	})
})

describe("prompts", () => {
	/** Build a prompter fed by `lines`; the input ends (EOF) once they run out. */
	const prompter = (lines: Array<string>) =>
		create_prompts({
			input: Readable.from(lines.map((l) => `${l}\n`)),
			output: new Writable({ write: (_chunk, _enc, cb) => cb() }),
		})

	const options = [
		{ label: "One", value: 1 },
		{ label: "Two", value: 2 },
	]

	it("returns the selected option", async () => {
		const p = prompter(["2"])
		expect(await p.select("Pick", options)).toBe(2)
		p.close()
	})

	it("cancels instead of looping when input ends mid-select", async () => {
		// Regression: an invalid line followed by EOF must not spin forever re-prompting.
		const p = prompter(["99"])
		await expect(p.select("Pick", options)).rejects.toBeInstanceOf(PromptCancelledError)
		p.close()
	})

	it("cancels a required free-text prompt on EOF", async () => {
		const p = prompter([])
		await expect(p.ask("Token", { required: true })).rejects.toBeInstanceOf(PromptCancelledError)
		p.close()
	})
})

describe("cloud domains & generated from types", () => {
	const domains = [
		{ domain: "example.com", status: "verified" },
		{ domain: "other-domain.com", status: "pending" },
	]

	it("fetch_domains parses the account and defaults missing statuses to pending", async () => {
		const account = await fetch_domains("https://postboi.app", "pb_secret", async (url, init) => {
			expect(url).toBe("https://postboi.app/v1/domains")
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer pb_secret")
			return json({
				send_address: "joe@send.postboi.email",
				domains: [...domains, { domain: "half-baked.com" }],
			})
		})
		expect(account).toEqual({
			send_address: "joe@send.postboi.email",
			domains: [...domains, { domain: "half-baked.com", status: "pending" }],
			captcha_key: undefined,
			webhook_secrets: [],
		})
	})

	it("fetch_domains picks up the publishable captcha key", async () => {
		const account = await fetch_domains("https://x", "t", async () =>
			json({ send_address: "a@b.c", domains: [], captcha_key: "pk_123" })
		)
		expect(account?.captcha_key).toBe("pk_123")
	})

	it("fetch_domains collects webhook secrets, dropping non-strings", async () => {
		const account = await fetch_domains("https://x", "t", async () =>
			json({ send_address: "a@b.c", domains: [], webhook_secrets: ["whsec_a", 5, "whsec_b"] })
		)
		expect(account?.webhook_secrets).toEqual(["whsec_a", "whsec_b"])
	})

	it("fetch_domains degrades to undefined on errors and unknown shapes", async () => {
		expect(await fetch_domains("https://x", "t", async () => json({}, 404))).toBeUndefined()
		expect(await fetch_domains("https://x", "t", async () => json({ nope: true }))).toBeUndefined()
		expect(
			await fetch_domains("https://x", "t", async () => {
				throw new Error("offline")
			})
		).toBeUndefined()
	})

	it("render_types emits bare and display-name forms for the address and every domain", () => {
		const source = render_types("joe@send.postboi.email", domains)!
		expect(source).toContain('declare module "postboi"')
		expect(source).toContain('| "joe@send.postboi.email"')
		expect(source).toContain("| `${string}<joe@send.postboi.email>`")
		expect(source).toContain("| `${string}@example.com`")
		expect(source).toContain("| `${string}@example.com>`")
		// pending domains are included — the type answers "plausibly mine", not "will deliver"
		expect(source).toContain("| `${string}@other-domain.com`")
		// the export makes it a module, so `declare module` augments instead of replacing —
		// and it must mirror the shipped placeholder so `<Captcha />` imports type-check
		expect(source).toContain("export declare const captcha_key: string | undefined")
	})

	it("render_types returns null when there is nothing to narrow", () => {
		expect(render_types(undefined, [])).toBeNull()
	})

	it("fetch_forms lists the account's forms, and degrades to undefined rather than to none", async () => {
		const forms = await fetch_forms("https://postboi.app", "pb_secret", async (url, init) => {
			expect(url).toBe("https://postboi.app/v1/forms")
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer pb_secret")
			return json({
				forms: [
					{ id: "form_1", name: "Contact", kind: "library" },
					{ id: "form_2", name: "Home Ownership Query" },
					{ id: 3, name: "broken" },
				],
			})
		})
		expect(forms).toEqual([
			{ id: "form_1", name: "Contact" },
			{ id: "form_2", name: "Home Ownership Query" },
		])
		// an account with no forms is an answer; an older API or a blip is not
		expect(await fetch_forms("https://x", "t", async () => json({ forms: [] }))).toEqual([])
		expect(await fetch_forms("https://x", "t", async () => json({}, 404))).toBeUndefined()
		expect(await fetch_forms("https://x", "t", async () => json({ nope: true }))).toBeUndefined()
		expect(
			await fetch_forms("https://x", "t", async () => {
				throw new Error("offline")
			})
		).toBeUndefined()
	})

	it("render_types narrows form to the current names and ids, and drops it on an empty list", () => {
		const forms = [
			{ id: "form_1", name: "Contact" },
			{ id: "form_2", name: "Home Ownership Query" },
		]
		const source = render_types("joe@send.postboi.email", domains, [], {}, [], forms)!
		expect(source).toContain("form:")
		expect(source).toContain('| "Contact"')
		expect(source).toContain('| "Home Ownership Query"')
		expect(source).toContain('| "form_2"')
		// forms alone are enough to generate — a bring-your-own-provider project can still name them
		expect(render_types(undefined, [], [], {}, [], forms)!).toContain('| "Contact"')
		// an account with no forms gets no member, so a stale name is a type error
		expect(render_types("joe@send.postboi.email", domains, [], {}, [], [])!).not.toContain("form:")
		expect(render_types(undefined, [], [], {}, [], [])).toBeNull()
	})

	it("carries the form union forward when a run couldn't list the forms", () => {
		const forms = [{ id: "form_1", name: "Contact" }]
		const kept = parse_forms(render_types("joe@send.postboi.email", domains, [], {}, [], forms)!)
		expect(kept).toEqual(['"Contact"', '"form_1"'])
		// undefined is "no opinion": the previous names are re-emitted verbatim
		const next = render_types("joe@send.postboi.email", domains, [], {}, [], undefined, kept)!
		expect(parse_forms(next)).toEqual(kept)
		// and the from union is untouched by any of it
		expect(parse_from(next)).toEqual(parse_from(render_types("joe@send.postboi.email", domains)!))
		// an empty list beats the kept names: the forms really are gone
		expect(render_types("joe@send.postboi.email", domains, [], {}, [], [], kept)!).not.toContain(
			"form:"
		)
	})

	it("render_types narrows template to the approved names, with or without a from union", () => {
		const both = render_types("joe@send.postboi.email", domains, ["order_shipped"])!
		expect(both).toContain("from:")
		expect(both).toContain("template:")
		expect(both).toContain('| "order_shipped"')
		// a bring-your-own-provider project has no addresses to type but still has templates
		const templates_only = render_types(undefined, [], ["re_engage"])!
		expect(templates_only).toContain('| "re_engage"')
		expect(templates_only).not.toContain("from:")
	})

	it("render_types maps each template to its own variables, omitting the ones it can't read", () => {
		const source = render_types(undefined, [], ["order_shipped", "ping"], {
			order_shipped: ["name", "tracking"],
			ping: [],
		})!
		expect(source).toContain('"order_shipped": "name" | "tracking"')
		// a template whose placeholders came back empty is left unnarrowed on purpose —
		// typing it as "takes nothing" would reject a valid send
		expect(source).not.toContain('"ping":')
		// no variables read at all: the member is dropped rather than emitted empty
		expect(render_types(undefined, [], ["ping"])!).not.toContain("template_variables")
	})

	it("render_runtime bakes the keys and the template SIDs", () => {
		expect(render_runtime("pk_123")).toContain('export const captcha_key = "pk_123"')
		expect(render_runtime("pk_123", {}, "BKEY")).toContain('export const vapid_public_key = "BKEY"')
		// Round trip: what render writes, parse reads — including the vapid key, so a
		// later sync that has no opinion on it carries it forward instead of erasing it.
		expect(parse_runtime(render_runtime("pk_123", { a: "HX1" }, "BKEY"))).toEqual({
			captcha_key: "pk_123",
			vapid_public_key: "BKEY",
			sids: { a: "HX1" },
		})
		const source = render_runtime(undefined, { order_shipped: "HX1" })
		expect(source).toContain('export const whatsapp_templates = {"order_shipped":"HX1"}')
	})

	it("round-trips its own output, so a partial run keeps what it can't recompute", () => {
		// These parsers read back what the renderers wrote — if the emitted shape ever drifts,
		// a sync that resolved only templates would silently drop the `from` union and the
		// baked Twilio SIDs instead of carrying them forward.
		const types = render_types("joe@send.postboi.email", domains, ["order_shipped"])!
		const kept = parse_from(types)
		expect(kept).toContain('"joe@send.postboi.email"')
		expect(kept).toContain("`${string}@example.com`")

		// a templates-only run re-emits the preserved union verbatim
		const next = render_types(undefined, [], ["re_engage"], {}, kept)!
		expect(parse_from(next)).toEqual(kept)

		const runtime = render_runtime("pk_123", { order_shipped: "HX1" })
		expect(parse_runtime(runtime)).toEqual({
			captcha_key: "pk_123",
			sids: { order_shipped: "HX1" },
		})
		// the shipped placeholder parses as "nothing baked yet", not as garbage
		expect(parse_runtime(render_runtime(undefined))).toEqual({
			captcha_key: undefined,
			vapid_public_key: undefined,
			sids: {},
		})
	})

	it("config_provider reads the committed provider, and nothing else that says provider", () => {
		expect(config_provider('export default config({\n\tprovider: "resend",\n})')).toBe("resend")
		expect(config_provider("\tprovider: 'postboi',")).toBe("postboi")
		// the sms block's own provider is nested and indented the same — first match wins,
		// which is the top-level one because it comes first in every config init writes
		expect(config_provider("sms: {\n\t\tprovider: 'twilio',\n\t},")).toBe("twilio")
		expect(config_provider("default: { to: 'a@b.c' },")).toBeUndefined()
	})

	it("render_types carries a provider marker, kept across runs that have no opinion", () => {
		const resend = render_types(undefined, [], [], {}, [], undefined, [], "resend")!
		expect(resend).toContain("provider:")
		expect(resend).toContain('| "resend"')
		expect(parse_provider(resend)).toBe("resend")
		// a marker alone is worth writing: it is what makes `form` an error on that project
		expect(render_types(undefined, [], [], {}, [], undefined, [], undefined)).toBeNull()
		// and it rides along with everything else
		const full = render_types(
			"joe@send.postboi.email",
			domains,
			["t"],
			{},
			[],
			[{ id: "form_1", name: "Contact" }],
			[],
			"postboi"
		)!
		expect(parse_provider(full)).toBe("postboi")
		expect(parse_from(full).length).toBeGreaterThan(0)
		expect(parse_forms(full)).toEqual(['"Contact"', '"form_1"'])
		expect(parse_provider("nothing here")).toBeUndefined()
	})

	it("config_captcha_key reads the committed key", () => {
		expect(config_captcha_key('captcha: {\n\t\tkey: "pk_123",\n\t},')).toBe("pk_123")
		expect(config_captcha_key("captcha: { honeypot: false },")).toBeUndefined()
		expect(config_captcha_key("provider: 'resend',")).toBeUndefined()
	})

	it("upsert_captcha_key replaces, extends, or inserts — and gives up on odd shapes", () => {
		// replace an existing key
		expect(upsert_captcha_key('captcha: { key: "pk_old" },', "pk_new")).toContain('key: "pk_new"')
		// extend an existing captcha block
		const extended = upsert_captcha_key("captcha: { honeypot: false },", "pk_1")!
		expect(config_captcha_key(extended)).toBe("pk_1")
		expect(extended).toContain("honeypot: false")
		// insert a block into a fresh config
		const inserted = upsert_captcha_key(
			'export default config({\n\tprovider: "postboi",\n})\n',
			"pk_1"
		)!
		expect(config_captcha_key(inserted)).toBe("pk_1")
		// unrecognised shape → null, caller prints a hint instead
		expect(upsert_captcha_key("module.exports = something", "pk_1")).toBeNull()
	})

	it("from_status classifies the send address, verified, pending and unknown domains", () => {
		const send = "joe@send.postboi.email"
		expect(from_status("joe@send.postboi.email", send, domains)).toEqual({ level: "ok" })
		expect(from_status("Joe Bloggs <JOE@send.postboi.email>", send, domains)).toEqual({
			level: "ok",
		})
		expect(from_status("foo@example.com", send, domains)).toEqual({ level: "ok" })
		expect(from_status("foo@other-domain.com", send, domains)).toEqual({
			level: "pending",
			domain: "other-domain.com",
		})
		expect(from_status("foo@unknown-domain.com", send, domains)).toEqual({
			level: "unknown",
			domain: "unknown-domain.com",
		})
		// someone else's stock address is foreign, not ok
		expect(from_status("mallory@send.postboi.email", send, domains)).toEqual({
			level: "unknown",
			domain: "send.postboi.email",
		})
	})
})

describe("agent skill", () => {
	const prompter = (lines: Array<string>) =>
		create_prompts({
			input: Readable.from(lines.map((l) => `${l}\n`)),
			output: new Writable({ write: (_chunk, _enc, cb) => cb() }),
		})
	const target = () => join(mkdtempSync(join(tmpdir(), "postboi-skill-")), "SKILL.md")

	it("ships inside the package", () => {
		expect(bundled_skill()).toContain("name: postboi")
	})

	it("installs on confirm (default yes)", async () => {
		const t = target()
		const p = prompter([""])
		await offer_skill(p, t)
		p.close()
		expect(readFileSync(t, "utf8")).toBe(bundled_skill())
	})

	it("writes nothing on decline", async () => {
		const t = target()
		const p = prompter(["n"])
		await offer_skill(p, t)
		p.close()
		expect(existsSync(t)).toBe(false)
	})

	it("refreshes a stale copy without prompting", async () => {
		const t = target()
		writeFileSync(t, "old skill")
		const p = prompter([]) // EOF — a prompt here would throw PromptCancelledError
		await offer_skill(p, t)
		p.close()
		expect(readFileSync(t, "utf8")).toBe(bundled_skill())
	})

	it("skill_command installs without a prompt, and is safe to run twice", () => {
		const t = target()
		// The whole point of the command: no prompts wired up at all, unlike offer_skill.
		expect(skill_command(t)).toBe(true)
		expect(readFileSync(t, "utf8")).toBe(bundled_skill())
		expect(skill_command(t)).toBe(true)
		expect(readFileSync(t, "utf8")).toBe(bundled_skill())
	})

	it("skill_command upgrades a stale copy rather than leaving it", () => {
		const t = target()
		writeFileSync(t, "old skill")
		expect(skill_command(t)).toBe(true)
		expect(readFileSync(t, "utf8")).toBe(bundled_skill())
	})

	it("refresh_skill never creates the file, and no-ops once linked", () => {
		const t = target()
		expect(refresh_skill(t)).toBe(false)
		expect(existsSync(t)).toBe(false)
		writeFileSync(t, bundled_skill()!)
		expect(refresh_skill(t)).toBe(true) // an old copy is upgraded to a link
		expect(refresh_skill(t)).toBe(false)
	})

	it("installs a link, so a new release lands with no diff", async () => {
		const t = target()
		const p = prompter([""])
		await offer_skill(p, t)
		p.close()
		expect(lstatSync(t).isSymbolicLink()).toBe(true)
		expect(readlinkSync(t).startsWith("..")).toBe(true) // relative — survives a clone
	})

	it("links via node_modules/postboi, not the version-pinned store path", async () => {
		const root = mkdtempSync(join(tmpdir(), "postboi-proj-"))
		const pkg = join(root, "node_modules", "postboi", "skills", "postboi")
		mkdirSync(pkg, { recursive: true })
		writeFileSync(join(pkg, "SKILL.md"), bundled_skill()!)
		const t = join(root, ".claude", "skills", "postboi", "SKILL.md")
		mkdirSync(dirname(t), { recursive: true })
		const p = prompter([""])
		await offer_skill(p, t)
		p.close()
		expect(readlinkSync(t)).toBe(
			join("..", "..", "..", "node_modules", "postboi", "skills", "postboi", "SKILL.md")
		)
	})
})

describe("add_remote_exclude", () => {
	it("adds an optimizeDeps block to a plain defineConfig", () => {
		const result = add_remote_exclude(
			'import { defineConfig } from "vite"\n\nexport default defineConfig({\n\tplugins: [sveltekit()],\n})\n'
		)
		expect(result).toContain('optimizeDeps: { exclude: ["postboi/remote"] }')
		expect(result).toContain("plugins: [sveltekit()]")
	})

	it("extends an existing exclude array", () => {
		const result = add_remote_exclude(
			'export default defineConfig({\n\toptimizeDeps: { exclude: ["@rollup/browser"] },\n})\n'
		)
		expect(result).toContain('exclude: ["postboi/remote", "@rollup/browser"]')
	})

	it("adds exclude to an existing flat optimizeDeps block", () => {
		const result = add_remote_exclude(
			'export default defineConfig({\n\toptimizeDeps: { include: ["kitto"] },\n})\n'
		)
		expect(result).toContain('exclude: ["postboi/remote"]')
		expect(result).toContain('include: ["kitto"]')
	})

	it("reports an already-present exclude", () => {
		expect(
			add_remote_exclude('defineConfig({ optimizeDeps: { exclude: ["postboi/remote"] } })')
		).toBe("present")
	})

	it("refuses shapes it can't edit safely", () => {
		// nested optimizeDeps (esbuildOptions) and non-object-literal configs
		expect(
			add_remote_exclude("defineConfig({ optimizeDeps: { esbuildOptions: { plugins: [] } } })")
		).toBe("unable")
		expect(add_remote_exclude("export default { plugins: [] }")).toBe("unable")
	})
})

describe("add_vite_plugin", () => {
	it("keeps a single-line plugins array on one line", () => {
		const result = add_vite_plugin(
			'import { defineConfig } from "vite"\nexport default defineConfig({\n\tplugins: [sveltekit(), svg(), tailwindcss()],\n})\n'
		) as string
		expect(result).toContain("plugins: [postboi(), sveltekit(), svg(), tailwindcss()],")
		// no comment, and no newline jammed in mid-array
		expect(result).not.toContain("//")
	})

	it("gives a multi-line array its own line, matching the existing indentation", () => {
		const result = add_vite_plugin(
			'import { defineConfig } from "vite"\nexport default defineConfig({\n    plugins: [\n        sveltekit(),\n    ],\n})\n'
		) as string
		expect(result).toContain("plugins: [\n        postboi(),\n        sveltekit(),")
	})

	it("adds no separator to an empty array", () => {
		const result = add_vite_plugin(
			'import { defineConfig } from "vite"\nexport default defineConfig({\n\tplugins: [],\n})\n'
		) as string
		expect(result).toContain("plugins: [postboi()],")
	})

	it("inserts the plugin into an existing plugins array, with its import", () => {
		const result = add_vite_plugin(
			'import { sveltekit } from "@sveltejs/kit/vite"\nimport { defineConfig } from "vite"\n\nexport default defineConfig({\n\tplugins: [sveltekit()],\n})\n'
		)
		expect(result).toContain('import { postboi } from "postboi/vite"')
		expect(result).toContain("postboi()")
		expect(result).toContain("sveltekit()")
		// the import must land after the existing ones, not inside the config
		expect(result.indexOf('from "postboi/vite"')).toBeLessThan(
			(result as string).indexOf("defineConfig({")
		)
	})

	it("creates a plugins array when there isn't one", () => {
		const result = add_vite_plugin(
			'import { defineConfig } from "vite"\n\nexport default defineConfig({\n\tbuild: {},\n})\n'
		)
		expect(result).toContain("plugins: [postboi()]")
		expect(result).toContain("build: {}")
	})

	it("adds the import at the top when the file has none", () => {
		const result = add_vite_plugin("export default defineConfig({ plugins: [] })")
		expect((result as string).startsWith('import { postboi } from "postboi/vite"')).toBe(true)
	})

	it("reports an already-present plugin", () => {
		expect(
			add_vite_plugin(
				'import { postboi } from "postboi/vite"\ndefineConfig({ plugins: [postboi()] })'
			)
		).toBe("present")
	})

	it("refuses shapes it can't edit safely", () => {
		expect(add_vite_plugin("export default { build: {} }")).toBe("unable")
	})

	it("produces a config that still parses as TypeScript-ish source", () => {
		const result = add_vite_plugin(
			'import { defineConfig } from "vite"\n\nexport default defineConfig({\n\tplugins: [a(), b()],\n})\n'
		) as string
		// balanced brackets is a cheap proxy for "didn't mangle the array"
		expect((result.match(/\[/g) ?? []).length).toBe((result.match(/\]/g) ?? []).length)
		expect((result.match(/\{/g) ?? []).length).toBe((result.match(/\}/g) ?? []).length)
	})
})

describe("synced credentials (postboi env)", () => {
	it("fetch_env_vars parses the vars and drops non-string values", async () => {
		const synced = await fetch_env_vars("https://postboi.app", "pb_secret", async (url, init) => {
			expect(url).toBe("https://postboi.app/v1/env")
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer pb_secret")
			return json({ vars: { RESEND_API_KEY: "re_123", BROKEN: 42 } })
		})
		expect(synced?.vars).toEqual({ RESEND_API_KEY: "re_123" })
	})

	it("fetch_env_vars returns undefined on an API that predates the endpoint", async () => {
		expect(
			await fetch_env_vars("https://postboi.app", "pb_secret", async () => json({}, 404))
		).toBeUndefined()
	})

	it("push_env_vars PUTs a merge, null deleting", async () => {
		let sent: unknown
		const ok = await push_env_vars(
			"https://postboi.app",
			"pb_secret",
			{ SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", OLD_KEY: null },
			async (url, init) => {
				expect(url).toBe("https://postboi.app/v1/env")
				expect(init?.method).toBe("PUT")
				sent = JSON.parse(String(init?.body))
				return json({ stored: 1, removed: 1 })
			}
		)
		expect(ok).toEqual({ ok: true })
		expect(sent).toEqual({
			vars: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", OLD_KEY: null },
		})
	})

	it("push_env_vars relays the API's rejection reason instead of blaming the network", async () => {
		const rejected = await push_env_vars(
			"https://postboi.app",
			"pb_secret",
			{ RESEND_API_KEY: "re_123" },
			async () => json({ message: "an account stores at most 100 env vars" }, 422)
		)
		expect(rejected).toEqual({ ok: false, reason: "an account stores at most 100 env vars" })
	})

	it("push_env_vars reports an unreachable API with no reason", async () => {
		const failed = await push_env_vars(
			"https://postboi.app",
			"pb_secret",
			{ RESEND_API_KEY: "re_123" },
			async () => {
				throw new Error("network down")
			}
		)
		expect(failed).toEqual({ ok: false })
	})

	it("start_connect posts the provider and reads the browser URL", async () => {
		const result = await start_connect("https://postboi.app", "slack", async (url, init) => {
			expect(url).toBe("https://postboi.app/api/connect/start")
			expect(JSON.parse(String(init?.body))).toEqual({ provider: "slack" })
			return json({ code: "c0de", url: "https://postboi.app/connect/slack?code=c0de" })
		})
		expect(result).toEqual({
			code: "c0de",
			url: "https://postboi.app/connect/slack?code=c0de",
			expires_in: 900,
			interval: 2,
		})
	})

	it("start_connect degrades to undefined instead of throwing — paste is the fallback", async () => {
		expect(
			await start_connect("https://postboi.app", "discord", async () => {
				throw new Error("ECONNREFUSED")
			})
		).toBeUndefined()
		expect(
			await start_connect("https://postboi.app", "discord", async () => json({}, 404))
		).toBeUndefined()
	})

	it("poll_connect polls until the webhook arrives", async () => {
		const responses = [
			json({ status: "pending", interval: 2 }),
			json({ status: "connected", webhook_url: "https://hooks.slack.com/x", label: "#alerts" }),
		]
		const result = await poll_connect(
			"https://postboi.app",
			{ code: "c0de", url: "u", expires_in: 900, interval: 2 },
			{ fetch: async () => responses.shift()!, sleep: async () => {}, now: () => 0 }
		)
		expect(result).toEqual({ webhook_url: "https://hooks.slack.com/x", label: "#alerts" })
	})

	it("poll_connect returns undefined on an expired code or timeout", async () => {
		expect(
			await poll_connect(
				"https://postboi.app",
				{ code: "c0de", url: "u", expires_in: 900, interval: 2 },
				{ fetch: async () => json({ error: "expired" }, 410), sleep: async () => {} }
			)
		).toBeUndefined()

		let clock = 0
		expect(
			await poll_connect(
				"https://postboi.app",
				{ code: "c0de", url: "u", expires_in: 900, interval: 2 },
				{
					fetch: async () => json({ status: "pending", interval: 2 }),
					sleep: async () => {
						clock += 1_000_000
					},
					now: () => clock,
				}
			)
		).toBeUndefined()
	})

	it("credential_env_keys spans every channel and never includes POSTBOI_TOKEN", () => {
		const keys = credential_env_keys()
		// One representative per channel: the registry is the allowlist, so a new
		// provider's credentials sync without anyone remembering to say so.
		for (const expected of [
			"RESEND_API_KEY",
			"TWILIO_AUTH_TOKEN",
			"SLACK_WEBHOOK_URL",
			"VAPID_PRIVATE_KEY",
			"WHATSAPP_ACCESS_TOKEN",
		]) {
			expect(keys).toContain(expected)
		}
		expect(keys).not.toContain("POSTBOI_TOKEN")
	})
})

describe("multiline env values", () => {
	it("parse_env reads a hand-pasted multiline quoted value instead of truncating it", () => {
		// Real newlines inside quotes, the way dotenv and Bun allow — truncating this to
		// its first line and team-syncing the fragment is the failure being ruled out.
		const pem = "-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----"
		expect(parse_env(`FCM_PRIVATE_KEY="${pem}"\nOTHER=1\n`)).toEqual({
			FCM_PRIVATE_KEY: pem,
			OTHER: "1",
		})
	})
})

describe("poll_connect terminal statuses", () => {
	const json_response = (body: unknown, status: number) =>
		({ ok: false, status, json: async () => body }) as Response

	it("treats 404/410 as dead instead of polling out the TTL", async () => {
		expect(
			await poll_connect(
				"https://postboi.app",
				{ code: "c0de", url: "u", expires_in: 900, interval: 2 },
				{
					fetch: async () => json_response({ error: "not_found" }, 404),
					sleep: async () => {},
				}
			)
		).toBeUndefined()
	})

	it("keeps polling through a 429 rate limit until the code resolves", async () => {
		let calls = 0
		const responses: Array<Response> = [
			json_response({ error: "rate_limited" }, 429),
			{
				ok: true,
				status: 200,
				json: async () => ({ status: "connected", webhook_url: "https://hooks.slack.com/x" }),
			} as Response,
		]
		const result = await poll_connect(
			"https://postboi.app",
			{ code: "c0de", url: "u", expires_in: 900, interval: 2 },
			{ fetch: async () => responses[calls++], sleep: async () => {} }
		)
		expect(result?.webhook_url).toBe("https://hooks.slack.com/x")
		expect(calls).toBe(2)
	})
})

describe("apns init helpers", () => {
	const P8 =
		"-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgSlMr9cyykHQqjsba\nRE/NSK6k0equ5zgboyWxvPczWSmhRANCAAQwNJfPKRALk/I14IAp/WFlk+Mo1Mcr\nMSHpnAMiRM5wHhc4z+R9vOF0RaLBDpYdMV2HciCfJZBuJovIvGxngLHp\n-----END PRIVATE KEY-----\n"
	const CREDS = {
		key_id: "ABC1234567",
		team_id: "TEAM123456",
		topic: "com.example.app",
		private_key: P8,
	}
	const apns_error = (status: number, reason: string) =>
		({
			ok: false,
			status,
			url: "",
			headers: new Headers(),
			text: async () => JSON.stringify({ reason }),
		}) as unknown as Response

	it("finds a downloaded key and reads its ID out of the filename", () => {
		const dir = mkdtempSync(join(tmpdir(), "postboi-apns-"))
		writeFileSync(join(dir, "AuthKey_ABC1234567.p8"), P8)
		writeFileSync(join(dir, "notes.txt"), "not a key")
		// A certificate is a different credential entirely — it must not be offered as one.
		writeFileSync(join(dir, "aps.cer"), "")

		expect(find_auth_keys([dir])).toEqual([
			{ path: join(dir, "AuthKey_ABC1234567.p8"), key_id: "ABC1234567" },
		])
		expect(find_auth_keys([join(dir, "nope")])).toEqual([])
	})

	it("offers the newest key first, since that's the one just downloaded", () => {
		const dir = mkdtempSync(join(tmpdir(), "postboi-apns-"))
		writeFileSync(join(dir, "AuthKey_OLD0000000.p8"), P8)
		utimesSync(join(dir, "AuthKey_OLD0000000.p8"), new Date(1e12), new Date(1e12))
		writeFileSync(join(dir, "AuthKey_NEW1111111.p8"), P8)

		expect(find_auth_keys([dir]).map((k) => k.key_id)).toEqual(["NEW1111111", "OLD0000000"])
	})

	it("fills both the key and its ID when one is picked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "postboi-apns-"))
		writeFileSync(join(dir, "AuthKey_ABC1234567.p8"), P8)
		const prefilled: Record<string, string> = {}
		// select() takes the first option — the found key.
		await offer_auth_key({ select: async (_m, options) => options[0].value }, prefilled, [dir])

		expect(prefilled.APNS_KEY_ID).toBe("ABC1234567")
		expect(prefilled.APNS_PRIVATE_KEY).toBe(P8)
	})

	it("leaves the prompts alone when the key is declined", async () => {
		const dir = mkdtempSync(join(tmpdir(), "postboi-apns-"))
		writeFileSync(join(dir, "AuthKey_ABC1234567.p8"), P8)
		const prefilled: Record<string, string> = {}
		// The last option is always "Paste the key instead".
		await offer_auth_key(
			{ select: async (_m, options) => options[options.length - 1].value },
			prefilled,
			[dir]
		)
		expect(prefilled).toEqual({})
	})

	it("reads BadDeviceToken as credentials accepted — the token was ours to invent", async () => {
		http2_fetch.mockResolvedValue(apns_error(400, "BadDeviceToken"))
		// APNs checks the provider token and topic before the device, so getting as far as
		// a rejected *device* means everything else was right. Inverting this would tell
		// people their working credentials are broken.
		expect(await verify_apns(CREDS)).toBeUndefined()
	})

	it("names the wrong thing for each way the credentials can be wrong", async () => {
		http2_fetch.mockResolvedValue(apns_error(403, "InvalidProviderToken"))
		expect(await verify_apns(CREDS)).toMatch(/key ID and team ID/)

		http2_fetch.mockResolvedValue(apns_error(400, "DeviceTokenNotForTopic"))
		expect(await verify_apns(CREDS)).toMatch(/bundle ID/)

		// A distinct key ID, because provider tokens are cached by it — reusing ABC1234567
		// would hand back the JWT signed earlier and never look at this key at all.
		expect(await verify_apns({ ...CREDS, key_id: "BADKEY0000", private_key: "not a key" })).toMatch(
			/readable \.p8/
		)
	})

	it("does not condemn the credentials when it simply couldn't reach Apple", async () => {
		http2_fetch.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"))
		expect(await verify_apns(CREDS)).toMatch(/couldn't reach APNs/)
	})
})
