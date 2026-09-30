import { existsSync, readdirSync, readFileSync } from "node:fs"
import { cwd, exit } from "node:process"
import { ensure_env_loaded, read_env } from "../library/env.js"
import { api, ApiCommandError } from "./api.js"
import { cloud_base, fetch_domains, type PostboiDomain } from "./postboi.js"
import { bold, cyan, dim, green, red, yellow } from "./prompts.js"
import { detect_package_manager, version_drift } from "./project.js"
import { skill_state } from "./skill.js"
import {
	config_captcha_key,
	config_default_from,
	config_provider,
	from_status,
	parse_runtime,
	RUNTIME_TARGET,
	TYPES_TARGET,
} from "./typegen.js"

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
	/** node_modules/postboi against the version the lockfile pins, when the two differ. */
	drift?: { installed: string; locked: string; lockfile: string }
	/**
	 * The publishable captcha key three ways: committed in the config, on the account,
	 * and baked into the installed package, which is the one `<Captcha />` actually uses.
	 */
	captcha?: { config?: string; account?: string; baked?: string; component?: string }
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
		facts.installed && facts.drift
			? {
					name: "package",
					level: "warn",
					detail: `node_modules has postboi ${facts.drift.installed}, but ${facts.drift.lockfile} pins ${facts.drift.locked}`,
					fix: `${detect_package_manager([facts.drift.lockfile])} install`,
				}
			: facts.installed
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
					detail: "no postboi.config.*, so mail() runs on defaults",
					fix: "bunx postboi init",
				}
			: facts.config_unreachable
				? {
						name: "config",
						level: "warn",
						detail: `${facts.config_file}: ${facts.config_unreachable} bundles its own server code and can't read it, so its defaults and hooks never reach a send made there`,
						fix: `import the config from the file that sends (e.g. \`import "../${facts.config_file.replace(/\.\w+$/, "")}"\`, relative to that file), or set POSTBOI_* in the ${facts.config_unreachable} dashboard`,
					}
				: {
						name: "config",
						level: "ok",
						detail: `${facts.config_file}: provider ${facts.provider ?? "postboi"}${facts.default_from ? `, from ${facts.default_from}` : ""}`,
					}
	)

	if (!hosted) {
		checks.push({
			name: "account",
			level: "skip",
			detail: `sending through ${facts.provider}, no Postboi account to check`,
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
				detail: `${a.name ?? a.id} is unclaimed. Sends are sandboxed until a human claims it`,
				fix: `claim it at ${a.claim_url}`,
			})
		} else if (a.sandbox) {
			checks.push({
				name: "account",
				level: "warn",
				detail: `${a.name ?? a.id} is in sandbox. Sends are logged, nothing is delivered`,
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
					detail: `${facts.default_from} is on ${status.domain}, which isn't verified yet. Sends fall back to ${a.send_address}`,
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
					? `${pending.map((d) => d.domain).join(", ")} still pending. Sends use ${a.send_address}`
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
					detail: `${facts.webhooks} endpoint(s) on the account but no POSTBOI_WEBHOOK_SECRET here, so receive() can't verify them`,
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

	const captcha = captcha_check(facts)
	if (captcha) checks.push(captcha)
	checks.push({ name: "skill", ...skill_check(facts.skill) })
	return checks
}

/**
 * Does `<Captcha />` have the right key? The account's key wins, the committed config is
 * what a tokenless build (CI) bakes from, and the installed package is what the component
 * reads. Nothing to say when no key exists anywhere.
 */
function captcha_check(facts: DoctorFacts): Check | undefined {
	const { config, account, baked } = facts.captcha ?? {}
	const want = account ?? config
	if (!want) {
		// A <Captcha /> with no key anywhere is a honeypot and nothing else, and says so only
		// in the browser's console. On an account with a widget the API then refuses its forms.
		// Only the Postboi provider bakes a key; another one's <Captcha pk="…"> has its own.
		const { component } = facts.captcha ?? {}
		if (!component || (facts.provider && facts.provider !== "postboi")) return undefined
		return {
			name: "captcha",
			level: "warn",
			detail: `${component} renders <Captcha />, but no captcha key is baked in, so it's honeypot-only and its forms send no token`,
			fix: facts.token ? "bunx postboi sync" : "bunx postboi init",
		}
	}
	if (account && config !== account) {
		return {
			name: "captcha",
			level: "warn",
			detail: config
				? `captcha.key in ${facts.config_file ?? "the config"} is ${config}, but the account's key is ${account}`
				: "no captcha.key in the config, so a build without POSTBOI_TOKEN bakes no key for <Captcha />",
			fix: "bunx postboi sync",
		}
	}
	if (facts.installed && baked !== want) {
		return {
			name: "captcha",
			level: "warn",
			detail: baked
				? `the installed package has ${baked} baked in, not ${want}, so <Captcha /> uses the wrong key`
				: "no key baked into the installed package, so <Captcha /> is honeypot-only",
			fix: "bunx postboi sync",
		}
	}
	return { name: "captcha", level: "ok", detail: `<Captcha /> has ${want}` }
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
				detail: "agent skill not installed, so AI coding agents will guess at the API",
				fix: "bunx postboi skill",
			}
	}
}

/** How many source files under a folder are worth reading before giving up on an answer. */
const SCAN_CAP = 200

/**
 * Does any source file under `folder` import the config (or call `configure()`)? Importing
 * it anywhere is enough, because `config()` registers as a side effect. Undefined when
 * the folder is missing, unreadable, or too big to read: the cap bounds the reading, not
 * the answer, so a caller never says "nothing imports it" about a file it skipped.
 */
export function imports_config(folder: string, cap = SCAN_CAP): boolean | undefined {
	if (!existsSync(folder)) return undefined
	try {
		const files = readdirSync(folder, { recursive: true }) as Array<string>
		const sources = files.filter((file) => /\.(ts|mts|js|mjs)$/.test(file))
		if (sources.length > cap) return undefined
		return sources.some((file) => {
			const source = readFileSync(`${folder}/${file}`, "utf8")
			return source.includes("postboi.config") || /\bconfigure\s*\(/.test(source)
		})
	} catch {
		// An unreadable tree is not a diagnosis. Say nothing rather than guess.
		return undefined
	}
}

/**
 * A runtime in this project that bundles server code without a filesystem and without a
 * bundler plugin we can install — Convex, whose own bundle takes none — and that nothing
 * has handed the config to. `read_disk` returns `{}` there, so the file is simply absent
 * at runtime: no error, no hook, no defaults, and mail that looks wrong a fortnight
 * later.
 */
function unreachable_runtime(dir: string): string | undefined {
	return imports_config(`${dir}/convex`) === false ? "Convex" : undefined
}

/** Collect the facts from the project directory and, with a token, the account. */
export async function gather(dir = cwd(), sources = project_sources(dir)): Promise<DoctorFacts> {
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
		drift: version_drift(dir),
		captcha: {
			component: sources?.find(([, file]) => CAPTCHA_IMPORT.test(file))?.[0],
			config: source ? config_captcha_key(source) : undefined,
			baked: existsSync(`${dir}/${RUNTIME_TARGET}`)
				? parse_runtime(readFileSync(`${dir}/${RUNTIME_TARGET}`, "utf8")).captcha_key
				: undefined,
		},
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
	if (facts.captcha) facts.captcha.account = identity?.captcha_key
	facts.webhooks = hooks?.webhooks.length
	return facts
}

/** Where app code lives across the frameworks we set up, and what counts as a source file. */
const SOURCE_DIRS = ["src", "app", "lib", "server"]
const SOURCE_FILE = /\.(ts|mts|js|mjs|tsx|jsx|svelte|vue|astro)$/

/**
 * The app's own source files, as `[path, source]`. Undefined past 2000 files, or when a
 * folder can't be read: a check that might have missed the one file it needed gives no
 * answer rather than a wrong one.
 */
function project_sources(dir: string): Array<[string, string]> | undefined {
	const sources: Array<[string, string]> = []
	try {
		for (const folder of SOURCE_DIRS) {
			if (!existsSync(`${dir}/${folder}`)) continue
			const files = readdirSync(`${dir}/${folder}`, { recursive: true }) as Array<string>
			for (const file of files) {
				if (!SOURCE_FILE.test(file) || file.includes("node_modules")) continue
				// ponytail: a hard cap, not a smarter walk; raise it if a real project hits it.
				if (sources.length >= 2000) return undefined
				const path = `${folder}/${file}`
				sources.push([path, readFileSync(`${dir}/${path}`, "utf8")])
			}
		}
	} catch {
		return undefined
	}
	return sources
}

/**
 * `<Captcha />` imported from one of the component entries: the default import (optionally
 * beside named ones), or `Captcha` by name. One import statement only, and never a type import.
 */
const CAPTCHA_IMPORT =
	/import\s+(?:(?!type\b)[\w$]+(?:\s*,\s*\{[^}]*\})?|\{[^}]*\bCaptcha\b[^}]*\})\s*from\s*["']postboi\/(?:svelte|react|vue|astro)["']/

/**
 * BetterAuth's `magicLink()` plugin mounts a public `POST /sign-in/magic-link` that mails
 * a link to any posted address, outside the app's own throttle. That's the product when
 * the browser signs in through it, and an open relay when the app sends its links some
 * other way. So: warn when the plugin is there, its route isn't in `disabledPaths`, and
 * nothing in the project calls `signIn.magicLink` from the client.
 */
export function magic_link_check(dir = cwd(), sources = project_sources(dir)): Check | undefined {
	if (!sources) return undefined
	const plugin = sources.find(
		([, source]) => source.includes("better-auth/plugins") && /\bmagicLink\s*\(/.test(source)
	)
	if (!plugin) return undefined
	const disabled = sources.some(
		([, source]) => source.includes("disabledPaths") && source.includes("/sign-in/magic-link")
	)
	// `\s*` around the dot: `auth_client.signIn` on one line and `.magicLink(…)` on the next.
	const called = sources.some(([, source]) => /signIn\s*\.\s*magicLink\s*\(/.test(source))
	if (disabled || called) return undefined
	return {
		name: "auth",
		level: "warn",
		detail: `${plugin[0]} adds BetterAuth's magicLink(), whose public POST /sign-in/magic-link mails a link to any address, and nothing here calls it from the browser`,
		fix: 'if the app sends its own sign-in links, add disabledPaths: ["/sign-in/magic-link"] to betterAuth()',
	}
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
	// One read of the app's source for both checks that look at it.
	const sources = project_sources(dir)
	const checks = diagnose(await gather(dir, sources))
	const auth = magic_link_check(dir, sources)
	if (auth) checks.push(auth)
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
					: green("All good. This project is wired.")
		)
	}
	return failed ? 1 : 0
}

/** The entry main() calls: run, then exit with the verdict. */
export async function doctor(args: Array<string>): Promise<void> {
	exit(await doctor_command(args))
}
