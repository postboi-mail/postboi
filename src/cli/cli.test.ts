import { describe, it, expect } from "vitest"
import { Readable, Writable } from "node:stream"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	PROVIDERS,
	DEFAULT_FIELDS,
	usage_snippet,
	render_config,
	render_block,
} from "./providers.js"
import { detect_env_targets, format_line, upsert_env, remove_env, is_gitignored } from "./env.js"
import { detect_hosts, detect_adapter_host, push_spec, manual_hint } from "./deploy.js"
import {
	detect_package_manager,
	has_dependency,
	install_command,
	is_bundled_framework,
} from "./project.js"
import { create_prompts, PromptCancelledError } from "./prompts.js"
import { banner } from "./banner.js"
import {
	cloud_base,
	start_device_auth,
	poll_device_auth,
	fetch_domains,
	PostboiAuthError,
} from "./postboi.js"
import {
	render_types,
	render_runtime,
	config_captcha_key,
	upsert_captcha_key,
	from_status,
} from "./typegen.js"
import { bundled_skill, offer_skill, refresh_skill } from "./skill.js"

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

	it("builds push commands (secrets via stdin, netlify via arg)", () => {
		expect(push_spec("vercel", "K", "v")).toEqual({
			cmd: "vercel",
			args: ["env", "add", "K", "production"],
			stdin: "v",
		})
		expect(push_spec("cloudflare", "K", "v")).toEqual({
			cmd: "wrangler",
			args: ["secret", "put", "K"],
			stdin: "v",
		})
		expect(push_spec("netlify", "K", "v")).toEqual({
			cmd: "netlify",
			args: ["env:set", "K", "v"],
		})
		expect(push_spec("railway", "K", "v")).toEqual({
			cmd: "railway",
			args: ["variables", "--set", "K=v"],
		})
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
		expect(out).toContain("but mail ain't one")
	})

	it("degrades to plain text when stdout isn't a TTY", () => {
		expect(banner().includes("\x1b")).toBe(false) // no ANSI escape character
	})
})

describe("cloud device flow", () => {
	const json = (body: unknown, status = 200) =>
		({
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		}) as Response

	const start = { code: "abc123", url: "https://postboi.email/cli?code=abc123" }

	it("cloud_base defaults to postboi.email and honours POSTBOI_API_URL", () => {
		const original = process.env.POSTBOI_API_URL
		delete process.env.POSTBOI_API_URL
		expect(cloud_base()).toBe("https://postboi.email")
		process.env.POSTBOI_API_URL = "http://localhost:5173/"
		expect(cloud_base()).toBe("http://localhost:5173") // trailing slash stripped
		if (original === undefined) delete process.env.POSTBOI_API_URL
		else process.env.POSTBOI_API_URL = original
	})

	it("start_device_auth returns the code and claim URL with defaults filled in", async () => {
		const result = await start_device_auth("https://postboi.email", async () => json(start))
		expect(result).toEqual({ ...start, expires_in: 600, interval: 2 })
	})

	it("start_device_auth wraps network and server failures in a friendly error", async () => {
		await expect(
			start_device_auth("https://postboi.email", async () => {
				throw new Error("ECONNREFUSED")
			})
		).rejects.toBeInstanceOf(PostboiAuthError)
		await expect(
			start_device_auth("https://postboi.email", async () => json({}, 500))
		).rejects.toBeInstanceOf(PostboiAuthError)
	})

	it("poll_device_auth polls until claimed and returns the claim", async () => {
		const responses = [
			json({ status: "pending", interval: 2 }),
			json({ status: "pending", interval: 2 }),
			json({ status: "claimed", token: "pb_secret", send_address: "joe@send.postboi.email" }),
		]
		const claim = await poll_device_auth(
			"https://postboi.email",
			{ ...start, expires_in: 600, interval: 2 },
			{ fetch: async () => responses.shift()!, sleep: async () => {}, now: () => 0 }
		)
		expect(claim).toEqual({ token: "pb_secret", send_address: "joe@send.postboi.email" })
	})

	it("poll_device_auth tolerates servers that don't send send_address", async () => {
		const claim = await poll_device_auth(
			"https://postboi.email",
			{ ...start, expires_in: 600, interval: 2 },
			{ fetch: async () => json({ status: "claimed", token: "pb_secret" }), sleep: async () => {} }
		)
		expect(claim).toEqual({ token: "pb_secret", send_address: undefined })
	})

	it("poll_device_auth fails fast on an invalid or expired code", async () => {
		await expect(
			poll_device_auth(
				"https://postboi.email",
				{ ...start, expires_in: 600, interval: 2 },
				{ fetch: async () => json({ error: "expired" }, 410), sleep: async () => {} }
			)
		).rejects.toBeInstanceOf(PostboiAuthError)
	})

	it("poll_device_auth times out at the deadline", async () => {
		let clock = 0
		await expect(
			poll_device_auth(
				"https://postboi.email",
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
	const json = (body: unknown, status = 200) =>
		({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

	const domains = [
		{ domain: "example.com", status: "verified" },
		{ domain: "other-domain.com", status: "pending" },
	]

	it("fetch_domains parses the account and defaults missing statuses to pending", async () => {
		const account = await fetch_domains("https://postboi.email", "pb_secret", async (url, init) => {
			expect(url).toBe("https://postboi.email/v1/domains")
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

	it("render_types returns null when the account has nothing to send from", () => {
		expect(render_types(undefined, [])).toBeNull()
	})

	it("render_runtime bakes the key", () => {
		expect(render_runtime("pk_123")).toContain('export const captcha_key = "pk_123"')
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

	it("refresh_skill never creates the file, and no-ops when current", () => {
		const t = target()
		expect(refresh_skill(t)).toBe(false)
		expect(existsSync(t)).toBe(false)
		writeFileSync(t, bundled_skill()!)
		expect(refresh_skill(t)).toBe(false)
	})
})
