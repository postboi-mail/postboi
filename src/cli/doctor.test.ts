import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diagnose, doctor_command, gather, magic_link_check, type DoctorFacts } from "./doctor.js"

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

const wired: DoctorFacts = {
	config_file: "postboi.config.ts",
	provider: undefined,
	default_from: "hello@acme.com",
	installed: true,
	token: true,
	account: {
		id: "acct_1",
		name: "Acme",
		plan: "starter",
		send_address: "acme@send.postboi.email",
		suspended: false,
	},
	domains: [{ domain: "acme.com", status: "verified" }],
	webhooks: 1,
	webhook_secret: true,
	skill: "linked",
}

const by_name = (checks: ReturnType<typeof diagnose>) =>
	Object.fromEntries(checks.map((c) => [c.name, c]))

describe("gather: does the config reach the runtime", () => {
	function project(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "postboi-doctor-"))
		for (const [path, source] of Object.entries(files)) {
			const full = join(dir, path)
			mkdirSync(join(full, ".."), { recursive: true })
			writeFileSync(full, source)
		}
		return dir
	}

	it("a Convex project whose functions never import the config is named", async () => {
		const dir = project({
			"postboi.config.ts": "export default config({})",
			"convex/email.ts": "import { mail } from 'postboi'\nexport const send = mail",
		})
		expect((await gather(dir)).config_unreachable).toBe("Convex")
	})

	it("importing the config anywhere in that tree is enough", async () => {
		const dir = project({
			"postboi.config.ts": "export default config({})",
			"convex/email.ts": "import '../postboi.config'\nimport { mail } from 'postboi'",
		})
		expect((await gather(dir)).config_unreachable).toBeUndefined()
	})

	it("a project with no Convex functions has nothing to say", async () => {
		const dir = project({ "postboi.config.ts": "export default config({})" })
		expect((await gather(dir)).config_unreachable).toBeUndefined()
	})

	it("no config file means there is nothing to fail to arrive", async () => {
		const dir = project({ "convex/email.ts": "import { mail } from 'postboi'" })
		expect((await gather(dir)).config_unreachable).toBeUndefined()
	})
})

describe("diagnose", () => {
	it("a wired project is all ok", () => {
		expect(diagnose(wired).every((c) => c.level === "ok")).toBe(true)
	})

	it("a config that can't reach the runtime is a warning naming the runtime", () => {
		const checks = by_name(diagnose({ ...wired, config_unreachable: "Convex" }))
		expect(checks.config.level).toBe("warn")
		expect(checks.config.detail).toContain("Convex")
		expect(checks.config.fix).toContain("postboi.config")
		// It is the config check itself, not a second one somebody has to notice.
		expect(
			diagnose({ ...wired, config_unreachable: "Convex" }).filter((c) => c.name === "config")
		).toHaveLength(1)
	})

	it("no token is a failure with the agent's init as the fix", () => {
		const { account } = by_name(diagnose({ ...wired, token: false, account: undefined }))
		expect(account.level).toBe("fail")
		expect(account.fix).toContain("init --agent")
	})

	it("an unclaimed project warns and hands over the claim URL", () => {
		const { account } = by_name(
			diagnose({
				...wired,
				account: { ...wired.account!, unclaimed: true, claim_url: "https://postboi.app/claim/x" },
			})
		)
		expect(account.level).toBe("warn")
		expect(account.fix).toContain("https://postboi.app/claim/x")
	})

	it("a from on a pending domain warns; on a foreign domain fails", () => {
		const pending = by_name(
			diagnose({ ...wired, domains: [{ domain: "acme.com", status: "pending" }] })
		)
		expect(pending.from.level).toBe("warn")
		expect(pending.from.fix).toBe("bunx postboi domains check acme.com")
		const foreign = by_name(diagnose({ ...wired, domains: [] }))
		expect(foreign.from.level).toBe("fail")
		expect(foreign.from.fix).toBe("bunx postboi domains add acme.com")
	})

	it("endpoints without a local secret point at sync", () => {
		const { webhooks } = by_name(diagnose({ ...wired, webhook_secret: false }))
		expect(webhooks.level).toBe("warn")
		expect(webhooks.fix).toBe("bunx postboi sync")
	})

	it("a stale or missing skill is a note, never a failure", () => {
		expect(by_name(diagnose({ ...wired, skill: "stale" })).skill.level).toBe("warn")
		expect(by_name(diagnose({ ...wired, skill: "missing" })).skill.level).toBe("warn")
	})

	it("a stale install warns with the reinstall for its lockfile", () => {
		const { package: pkg } = by_name(
			diagnose({
				...wired,
				drift: { installed: "0.54.3", locked: "0.56.0", lockfile: "bun.lock" },
			})
		)
		expect(pkg.level).toBe("warn")
		expect(pkg.detail).toContain("0.54.3")
		expect(pkg.detail).toContain("0.56.0")
		expect(pkg.fix).toBe("bun install")
	})

	it("says nothing about the captcha when no key exists anywhere", () => {
		expect(by_name(diagnose(wired)).captcha).toBeUndefined()
	})

	it("warns when <Captcha /> is rendered but no key exists anywhere", () => {
		const check = by_name(
			diagnose({ ...wired, captcha: { component: "src/routes/contact/+page.svelte" } })
		).captcha
		expect(check.level).toBe("warn")
		expect(check.detail).toContain("src/routes/contact/+page.svelte")
		expect(check.detail).toContain("honeypot-only")

		// Another provider's <Captcha pk="…"> never has a baked key, and isn't meant to.
		expect(
			by_name(
				diagnose({
					...wired,
					provider: "resend",
					captcha: { component: "src/routes/contact/+page.svelte" },
				})
			).captcha
		).toBeUndefined()
	})

	it("a captcha key that matches everywhere is ok", () => {
		const keys = { config: "pk_a", account: "pk_a", baked: "pk_a" }
		expect(by_name(diagnose({ ...wired, captcha: keys })).captcha.level).toBe("ok")
	})

	it("a config key that isn't the account's, or is missing, points at sync", () => {
		const other = by_name(
			diagnose({ ...wired, captcha: { config: "pk_old", account: "pk_a", baked: "pk_a" } })
		).captcha
		expect(other.level).toBe("warn")
		expect(other.detail).toContain("pk_old")
		expect(other.fix).toBe("bunx postboi sync")
		const missing = by_name(
			diagnose({ ...wired, captcha: { account: "pk_a", baked: "pk_a" } })
		).captcha
		expect(missing.level).toBe("warn")
		expect(missing.detail).toContain("no captcha.key")
	})

	it("a baked key that's missing or different points at sync, with or without a token", () => {
		const unbaked = by_name(
			diagnose({ ...wired, captcha: { config: "pk_a", account: "pk_a" } })
		).captcha
		expect(unbaked.level).toBe("warn")
		expect(unbaked.detail).toContain("honeypot-only")
		// Tokenless: the config is the key to compare against.
		const stale = by_name(
			diagnose({
				...wired,
				token: false,
				account: undefined,
				captcha: { config: "pk_a", baked: "pk_old" },
			})
		).captcha
		expect(stale.level).toBe("warn")
		expect(stale.detail).toContain("pk_old")
		expect(stale.fix).toBe("bunx postboi sync")
	})

	it("another provider skips the account checks rather than failing them", () => {
		const checks = diagnose({ ...wired, provider: "resend", token: false, account: undefined })
		const named = by_name(checks)
		expect(named.account.level).toBe("skip")
		expect(checks.some((c) => c.level === "fail")).toBe(false)
		expect(named.from).toBeUndefined()
	})
})

describe("gather + doctor_command", () => {
	function project(config: string) {
		const dir = mkdtempSync(join(tmpdir(), "postboi-doctor-"))
		writeFileSync(join(dir, "postboi.config.ts"), config)
		mkdirSync(join(dir, "node_modules", "postboi", "dist"), { recursive: true })
		writeFileSync(join(dir, "node_modules", "postboi", "dist", "register.d.ts"), "")
		return dir
	}

	it("reads the config, the env and the account", async () => {
		const dir = project(
			'import { config } from "postboi"\nexport default config({ default: { from: "hi@acme.com" } })\n'
		)
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubEnv("POSTBOI_WEBHOOK_SECRET", "whsec_x")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/v1/account")) {
					return new Response(
						JSON.stringify({
							id: "acct_1",
							name: "Acme",
							plan: "starter",
							send_address: "a@send.postboi.email",
							suspended: false,
						}),
						{ status: 200 }
					)
				}
				if (url.endsWith("/v1/domains")) {
					return new Response(
						JSON.stringify({
							send_address: "a@send.postboi.email",
							domains: [{ domain: "acme.com", status: "verified" }],
							webhook_secrets: [],
						}),
						{ status: 200 }
					)
				}
				return new Response(JSON.stringify({ webhooks: [{ id: "wh_1" }] }), { status: 200 })
			})
		)
		const facts = await gather(dir)
		expect(facts).toMatchObject({
			config_file: "postboi.config.ts",
			default_from: "hi@acme.com",
			installed: true,
			token: true,
			webhooks: 1,
			webhook_secret: true,
			skill: "missing",
		})
		expect(facts.domains).toEqual([{ domain: "acme.com", status: "verified" }])

		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		expect(await doctor_command([], dir)).toBe(0)
		expect(lines.join("\n")).toContain("hi@acme.com is sendable")

		lines.length = 0
		expect(await doctor_command(["--json"], dir)).toBe(0)
		const report = JSON.parse(lines.join("\n"))
		expect(report.ok).toBe(true)
		expect(report.checks.find((c: { name: string }) => c.name === "from").level).toBe("ok")
	})

	it("reads the captcha key three ways and the locked version", async () => {
		const dir = project('export default config({ captcha: { key: "pk_config" } })\n')
		writeFileSync(
			join(dir, "node_modules", "postboi", "dist", "register.js"),
			'export const captcha_key = "pk_baked"\n'
		)
		writeFileSync(
			join(dir, "node_modules", "postboi", "package.json"),
			'{ "name": "postboi", "version": "0.54.3" }'
		)
		writeFileSync(
			join(dir, "bun.lock"),
			'{\n  "packages": {\n    "postboi": ["postboi@0.56.0", "", {}, "sha512-x"],\n  }\n}\n'
		)
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const body = url.endsWith("/v1/domains")
					? { send_address: "a@send.postboi.email", domains: [], captcha_key: "pk_account" }
					: url.endsWith("/v1/account")
						? { id: "acct_1", plan: "starter", send_address: "a@x", suspended: false }
						: { webhooks: [] }
				return new Response(JSON.stringify(body), { status: 200 })
			})
		)
		const facts = await gather(dir)
		expect(facts.captcha).toEqual({ config: "pk_config", baked: "pk_baked", account: "pk_account" })
		expect(facts.drift).toEqual({ installed: "0.54.3", locked: "0.56.0", lockfile: "bun.lock" })
	})

	it("exits 1 when the token doesn't reach an account", async () => {
		const dir = project("export default {}\n")
		vi.stubEnv("POSTBOI_TOKEN", "pb_bad")
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({ message: "Invalid or revoked API key.", code: "invalid_token" }),
						{ status: 401 }
					)
			)
		)
		vi.spyOn(console, "log").mockImplementation(() => {})
		expect(await doctor_command([], dir)).toBe(1)
		const facts = await gather(dir)
		expect(facts.account).toEqual({ error: "Invalid or revoked API key.", code: "invalid_token" })
	})
})

describe("magic_link_check: an auth route that mails any address", () => {
	function app(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "postboi-auth-"))
		for (const [path, source] of Object.entries(files)) {
			mkdirSync(join(dir, path, ".."), { recursive: true })
			writeFileSync(join(dir, path), source)
		}
		return dir
	}
	const server = `import { betterAuth } from "better-auth"
import { magicLink } from "better-auth/plugins"
export const auth = betterAuth({ plugins: [magicLink({ sendMagicLink })] })`

	it("warns when the plugin's route is open and nothing in the app calls it", () => {
		const check = magic_link_check(app({ "src/lib/server/auth.ts": server }))
		expect(check?.level).toBe("warn")
		expect(check?.detail).toContain("src/lib/server/auth.ts")
		expect(check?.fix).toContain('disabledPaths: ["/sign-in/magic-link"]')
	})

	it("is quiet once disabledPaths switches the route off", () => {
		const disabled = server.replace(
			"betterAuth({",
			'betterAuth({ disabledPaths: ["/sign-in/magic-link"],'
		)
		expect(magic_link_check(app({ "src/lib/server/auth.ts": disabled }))).toBeUndefined()
	})

	it("is quiet when the browser signs in through the route", () => {
		const dir = app({
			"src/lib/server/auth.ts": server,
			"src/routes/login/+page.svelte": "<script>authClient.signIn.magicLink({ email })</script>",
		})
		expect(magic_link_check(dir)).toBeUndefined()
	})

	it("sees a browser call split across lines", () => {
		const dir = app({
			"src/lib/server/auth.ts": server,
			"src/routes/login/+page.svelte":
				"<script>await auth_client.signIn\n\t.magicLink({ email })</script>",
		})
		expect(magic_link_check(dir)).toBeUndefined()
	})

	it("gather finds the file that renders <Captcha />, and only that", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "")
		const toggle = app({
			"src/routes/push/+page.svelte":
				'<script>import { push_toggle } from "postboi/svelte"</script>',
		})
		expect((await gather(toggle)).captcha?.component).toBeUndefined()

		// a neighbouring import and a type import aren't <Captcha /> either
		const neighbours = app({
			"src/routes/push/+page.svelte":
				'<script>import Foo from "./foo"\nimport { push_toggle } from "postboi/svelte"\nimport type { WebPushSubscription } from "postboi/svelte"</script>',
		})
		expect((await gather(neighbours)).captcha?.component).toBeUndefined()

		const form = app({
			"src/routes/push/+page.svelte":
				'<script>import { push_toggle } from "postboi/svelte"</script>',
			"src/routes/contact/+page.svelte": "<script>import Captcha from 'postboi/svelte'</script>",
		})
		expect((await gather(form)).captcha?.component).toBe("src/routes/contact/+page.svelte")
	})

	it("says nothing without BetterAuth's plugin", () => {
		expect(magic_link_check(app({ "src/app.ts": "export const x = 1" }))).toBeUndefined()
	})
})
