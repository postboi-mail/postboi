import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diagnose, doctor_command, gather, type DoctorFacts } from "./doctor.js"

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
