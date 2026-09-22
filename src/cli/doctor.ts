import { existsSync, readdirSync, readFileSync } from "node:fs"
import { cwd, exit } from "node:process"
import { ensure_env_loaded, read_env } from "../library/env.js"
import { api, ApiCommandError } from "./api.js"
import { cloud_base, fetch_domains, type PostboiDomain } from "./postboi.js"
import { bold, cyan, dim, green, red, yellow } from "./prompts.js"
import { skill_state } from "./skill.js"
import { config_default_from, config_provider, from_status, TYPES_TARGET } from "./typegen.js"

/**
 * `postboi doctor` — is this project wired? The question every agent asks first and
 * last, answered in one command instead of `whoami` + `domains` + `webhooks` + a read of
 * the config file. Every check names its fix. Exit 1 when anything fails, so a script
 * can gate on it; `--json` for the checks as data.
 *
 * `diagnose` is pure over the facts `gather` collects, which is what makes the rules
 * testable without a network.
 */

export const CONFIG_FILES = [
	"postboi.config.ts",
	"postboi.config.mts",
	"postboi.config.js",
	"postboi.config.mjs",
]

export interface DoctorFacts {
	/** The config file found, or undefined for none. */
	config_file?: string
	/**
	 * The runtime this project deploys server code to that **can't read** the config
	 * file, when there is one and nothing hands it over — "Convex", today. Undefined
	 * when the config will reach the runtime, or when there is no config to reach it.
	 */
	config_unreachable?: string
	/** The provider the project sends through, resolved as `mail()` does. */
	provider?: string
	default_from?: string
	installed: boolean
	token: boolean
	/** `GET /v1/account`, or a string naming why it failed. Absent when there is no token. */
	account?:
		| {
				id: string
				name?: string
				plan: string
				send_address: string
				suspended: boolean
				sandbox?: boolean
				unclaimed?: boolean
				claim_url?: string
		  }
		| { error: string; code?: string }
	domains?: Array<PostboiDomain>
	webhooks?: number
	webhook_secret: boolean
	skill: "missing" | "linked" | "current" | "stale"
}

export type Level = "ok" | "warn" | "fail" | "skip"

export interface Check {
	name: string
	level: Level
	detail: string
	fix?: string
}

/** The provider is Postboi when nothing says otherwise — the same default `mail()` takes. */
function on_postboi(facts: DoctorFacts): boolean {
	return !facts.provider || facts.provider === "postboi"
}

export function diagnose(facts: DoctorFacts): Array<Check> {
	const checks: Array<Check> = []
	const hosted = on_postboi(facts)

	checks.push(
		facts.installed
			? { name: "package", level: "ok", detail: "postboi is installed" }
			: {
					name: "package",
					level: "fail",
					detail: "postboi isn't installed in this project",
					fix: "bunx postboi init",
				}
	)

	// A config file that exists and a config file that arrives are different facts. The
	// second one is what a send actually reads, and the runtimes where they come apart
	// have no filesystem to be told off about it — so it is said here, at dev time,
	// where it is still cheap.
	checks.push(
		!facts.config_file
			? {
					name: "config",
					level: "warn",
					detail: "no postboi.config.* — mail() runs on defaults",
					fix: "bunx postboi init",
				}
			: facts.config_unreachable
				? {
						name: "config",
						level: "warn",
						detail: `${facts.config_file} — ${facts.config_unreachable} bundles its own server code and can't read it, so its defaults and hooks never reach a send made there`,
						fix: `import "../${facts.config_file.replace(/\.\w+$/, "")}" in the file that sends, or set POSTBOI_* in the ${facts.config_unreachable} dashboard`,
					}
				: {
						name: "config",
						level: "ok",
						detail: `${facts.config_file} — provider ${facts.provider ?? "postboi"}${facts.default_from ? `, from ${facts.default_from}` : ""}`,
					}
	)

	if (!hosted) {
		checks.push({
			name: "account",
			level: "skip",
			detail: `sending through ${facts.provider} — no Postboi account to check`,
		})
		checks.push({ name: "skill", ...skill_check(facts.skill) })
		return checks
	}

	if (!facts.token) {
		checks.push({
			name: "account",
			level: "fail",
			detail: "no POSTBOI_TOKEN in the environment or .env",
			fix: "bunx postboi init --agent (no prompts) or bunx postboi init",
		})
	} else if (!facts.account || "error" in facts.account) {
		checks.push({
			name: "account",
			level: "fail",
			detail: `the token doesn't reach an account${facts.account ? ` (${facts.account.error})` : ""}`,
			fix: "bunx postboi init to sign in again",
		})
	} else {
		const a = facts.account
		if (a.suspended) {
			checks.push({
				name: "account",
				level: "fail",
				detail: `${a.name ?? a.id} is suspended`,
				fix: "contact support@postboi.app",
			})
		} else if (a.unclaimed && a.claim_url) {
			checks.push({
				name: "account",
				level: "warn",
				detail: `${a.name ?? a.id} is unclaimed — sends are sandboxed until a human claims it`,
				fix: `claim it at ${a.claim_url}`,
			})
		} else if (a.sandbox) {
			checks.push({
				name: "account",
				level: "warn",
				detail: `${a.name ?? a.id} is in sandbox — sends are logged, nothing is delivered`,
			})
		} else {
			checks.push({
				name: "account",
				level: "ok",
				detail: `${a.name ?? a.id} on ${a.plan}, sends as ${a.send_address}`,
			})
		}

		// The address the project sends as: the account's own, or one on a verified domain.
		if (facts.default_from && facts.domains) {
			const status = from_status(facts.default_from, a.send_address, facts.domains)
			if (status.level === "ok") {
				checks.push({ name: "from", level: "ok", detail: `${facts.default_from} is sendable` })
			} else if (status.level === "pending") {
				checks.push({
					name: "from",
					level: "warn",
					detail: `${facts.default_from} is on ${status.domain}, which isn't verified yet — sends fall back to ${a.send_address}`,
					fix: `bunx postboi domains check ${status.domain}`,
				})
			} else {
				checks.push({
					name: "from",
					level: "fail",
					detail: `${facts.default_from} is on ${status.domain}, which isn't on this account`,
					fix: `bunx postboi domains add ${status.domain}`,
				})
			}
		} else if (facts.domains) {
			const pending = facts.domains.filter((d) => d.status !== "verified")
			checks.push({
				name: "from",
				level: pending.length ? "warn" : "ok",
				detail: pending.length
					? `${pending.map((d) => d.domain).join(", ")} still pending — sends use ${a.send_address}`
					: facts.domains.length
						? `${facts.domains.length} verified domain(s); default.from unset, sends use ${a.send_address}`
						: `no custom domain; sends use ${a.send_address}`,
				fix: pending.length ? `bunx postboi domains check ${pending[0].domain}` : undefined,
			})
		}

		if (facts.webhooks !== undefined) {
			if (facts.webhooks > 0 && !facts.webhook_secret) {
				checks.push({
					name: "webhooks",
					level: "warn",
					detail: `${facts.webhooks} endpoint(s) on the account but no POSTBOI_WEBHOOK_SECRET here — receive() can't verify them`,
					fix: "bunx postboi sync",
				})
			} else {
				checks.push({
					name: "webhooks",
					level: "ok",
					detail:
						facts.webhooks === 0
							? "none registered"
							: `${facts.webhooks} endpoint(s), secret present`,
				})
			}
		}
	}

	checks.push({ name: "skill", ...skill_check(facts.skill) })
	return checks
}

function skill_check(state: DoctorFacts["skill"]): Omit<Check, "name"> {
	switch (state) {
		case "linked":
			return { level: "ok", detail: "agent skill installed and linked to this version" }
		case "current":
			return { level: "ok", detail: "agent skill installed and current" }
		case "stale":
			return {
				level: "warn",
				detail: "agent skill installed but behind the installed version",
				fix: "bunx postboi skill",
			}
		default:
			return {
				level: "warn",
				detail: "agent skill not installed — AI coding agents will guess at the API",
				fix: "bunx postboi skill",
			}
	}
}

/**
 * A runtime in this project that bundles server code without a filesystem and without a
 * bundler plugin we can install — Convex, whose own bundle takes none — and that nothing
 * has handed the config to. `read_disk` returns `{}` there, so the file is simply absent
 * at runtime: no error, no hook, no defaults, and mail that looks wrong a fortnight
 * later. Importing the config anywhere in that tree is enough, because `config()`
 * registers as a side effect.
 */
function unreachable_runtime(dir: string): string | undefined {
	const functions = `${dir}/convex`
	if (!existsSync(functions)) return undefined
	try {
		const files = readdirSync(functions, { recursive: true }) as Array<string>
		const carried = files
			.filter((file) => /\.(ts|mts|js|mjs)$/.test(file))
			.slice(0, 200)
			.some((file) => {
				const source = readFileSync(`${functions}/${file}`, "utf8")
				return source.includes("postboi.config") || /\bconfigure\s*\(/.test(source)
			})
		return carried ? undefined : "Convex"
	} catch {
		// An unreadable tree is not a diagnosis. Say nothing rather than guess.
		return undefined
	}
}

/** Collect the facts from the project directory and, with a token, the account. */
export async function gather(dir = cwd()): Promise<DoctorFacts> {
	await ensure_env_loaded()
	const config_file = CONFIG_FILES.find((f) => existsSync(`${dir}/${f}`))
	const source = config_file ? readFileSync(`${dir}/${config_file}`, "utf8") : undefined
	const provider = read_env("POSTBOI_PROVIDER") ?? (source ? config_provider(source) : undefined)
	const token = read_env("POSTBOI_TOKEN")
	const facts: DoctorFacts = {
		config_file,
		config_unreachable: config_file ? unreachable_runtime(dir) : undefined,
		provider,
		default_from: source ? config_default_from(source) : undefined,
		installed: existsSync(`${dir}/${TYPES_TARGET}`),
		token: Boolean(token),
		webhook_secret: Boolean(read_env("POSTBOI_WEBHOOK_SECRET")),
		skill: skill_state(`${dir}/.claude/skills/postboi/SKILL.md`),
	}
	if (!token || (provider && provider !== "postboi")) return facts

	try {
		facts.account =
			await api<Exclude<DoctorFacts["account"], { error: string } | undefined>>("/v1/account")
	} catch (error) {
		facts.account = {
			error: error instanceof Error ? error.message : String(error),
			code: error instanceof ApiCommandError ? error.code : undefined,
		}
		return facts
	}
	const [identity, hooks] = await Promise.all([
		fetch_domains(cloud_base(), token),
		api<{ webhooks: Array<unknown> }>("/v1/webhooks").catch(() => undefined),
	])
	facts.domains = identity?.domains
	facts.webhooks = hooks?.webhooks.length
	return facts
}

const MARK: Record<Level, string> = {
	ok: green("✓"),
	warn: yellow("!"),
	fail: red("✗"),
	skip: dim("–"),
}

export function print_checks(checks: Array<Check>): void {
	for (const check of checks) {
		console.log(`${MARK[check.level]} ${bold(check.name.padEnd(9))} ${check.detail}`)
		if (check.fix) console.log(`  ${dim("fix:")} ${cyan(check.fix)}`)
	}
}

export async function doctor_command(args: Array<string>, dir = cwd()): Promise<number> {
	const checks = diagnose(await gather(dir))
	const failed = checks.some((check) => check.level === "fail")
	if (args.includes("--json")) {
		console.log(JSON.stringify({ ok: !failed, checks }, null, 2))
	} else {
		print_checks(checks)
		console.log()
		console.log(
			failed
				? red("Something needs fixing before this project can send.")
				: checks.some((check) => check.level === "warn")
					? yellow("Sends work; the notes above are worth a look.")
					: green("All good — this project is wired.")
		)
	}
	return failed ? 1 : 0
}

/** The entry main() calls: run, then exit with the verdict. */
export async function doctor(args: Array<string>): Promise<void> {
	exit(await doctor_command(args))
}
