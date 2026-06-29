import { describe, it, expect } from "vitest"
import { Readable, Writable } from "node:stream"
import { PROVIDERS, DEFAULT_FIELDS, usage_snippet } from "./providers.js"
import { detect_env_targets, format_line, upsert_env, is_gitignored } from "./env.js"
import { detect_hosts, push_spec, manual_hint } from "./deploy.js"
import { detect_package_manager, has_dependency, install_command } from "./project.js"
import { create_prompts, PromptCancelledError } from "./prompts.js"
import { banner } from "./banner.js"

describe("provider registry", () => {
	it("lists the configurable providers with complete metadata", () => {
		expect(PROVIDERS.length).toBeGreaterThanOrEqual(14)
		for (const p of PROVIDERS) {
			expect(p.key, p.name).toMatch(/^[a-z]+$/)
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
		expect(detect_hosts(["package.json"])).toEqual([])
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
	})

	it("offers a manual hint per host", () => {
		expect(manual_hint("vercel", "K")).toContain("vercel env add K")
		expect(manual_hint("cloudflare", "K")).toContain("wrangler secret put K")
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
})

describe("banner", () => {
	it("renders the mascot and wordmark", () => {
		const out = banner()
		expect(out).toContain("postboi") // wordmark
		expect(out).toContain("( O )") // the kid's nose
		expect(out).toContain("<3") // parcel heart
	})

	it("degrades to plain text when stdout isn't a TTY", () => {
		expect(banner().includes("\x1b")).toBe(false) // no ANSI escape character
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
