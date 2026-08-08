#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, delimiter } from "node:path"
import { argv, cwd, exit, platform, env } from "node:process"
import {
	PROVIDERS,
	SMS_PROVIDERS,
	CHAT_PROVIDERS,
	PUSH_PROVIDERS,
	WHATSAPP_PROVIDERS,
	SMS_DEFAULT_FIELDS,
	render_channel_config,
	type CliSmsProvider,
	DEFAULT_FIELDS,
	usage_snippet,
	render_config,
	render_block,
	type CliProvider,
} from "./providers.js"
import {
	detect_env_targets,
	upsert_env,
	remove_env,
	is_gitignored,
	parse_env,
	type EnvTarget,
} from "./env.js"
import {
	detect_hosts,
	detect_adapter_host,
	push_spec,
	manual_hint,
	HOST_LABEL,
	HOST_CLI,
	type Host,
} from "./deploy.js"
import {
	detect_package_manager,
	add_remote_exclude,
	add_vite_plugin,
	has_dependency,
	type PackageJson,
	install_command,
	is_bundled_framework,
} from "./project.js"
import {
	create_prompts,
	PromptCancelledError,
	bold,
	dim,
	cyan,
	green,
	yellow,
	red,
} from "./prompts.js"
import { banner } from "./banner.js"
import {
	cloud_base,
	start_device_auth,
	poll_device_auth,
	open_browser,
	fetch_domains,
	fetch_env_vars,
	push_env_vars,
	type PostboiDomain,
} from "./postboi.js"
import { credential_env_keys } from "../library/registry.js"
import { to_base64url } from "../library/encoding.js"
import {
	write_types,
	write_runtime,
	from_status,
	config_captcha_key,
	upsert_captcha_key,
	TYPES_TARGET,
} from "./typegen.js"
import { offer_skill, refresh_skill } from "./skill.js"
import { api_command } from "./api.js"
import { dev_command } from "./dev.js"
import { ensure_env_loaded, read_env } from "../library/env.js"

const CONFIG_FILES = [
	"postboi.config.ts",
	"postboi.config.mts",
	"postboi.config.js",
	"postboi.config.mjs",
]

type Prompts = ReturnType<typeof create_prompts>

function version(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
		return pkg.version ?? "unknown"
	} catch {
		return "unknown"
	}
}

function help(): void {
	console.log(`
${banner()}
${dim(`  v${version()}`)}

${bold("Usage")}
  ${cyan("bunx postboi init")}     Set up the Postboi provider or a provider of your own
  ${cyan("bunx postboi sync")}     Pull synced team credentials and refresh the generated from types
  ${cyan("bunx postboi env")}      The synced credentials ${dim("· push · pull [--force] · remove <KEY>")}
  ${cyan("bunx postboi dev")}      Local inbox for mail sent in development
  ${dim("                          · --port <n> --demo --no-sound --no-intro")}
  ${dim("                          (Vite projects already serve it at /__postboi)")}

${bold("Account")} ${dim("(Postboi provider — full reference: https://api.postboi.email)")}
  ${cyan("bunx postboi whoami")}          The account behind your token
  ${cyan("bunx postboi send-address")}    Default sending address ${dim("· [name@yourdomain.com]")}
  ${cyan("bunx postboi lists")}           Lists ${dim("· add <name> · delete <ref>")}
  ${cyan("bunx postboi recipients")}      A list's recipients ${dim("· <list> add <email>… · <list> remove <email>")}
  ${cyan("bunx postboi contacts")}        The audience ${dim("· add <email> [--name --data] · <email> · remove <email>")}
  ${cyan("bunx postboi domains")}         Sending domains ${dim("· add <domain> · check <ref> · delete <ref>")}
  ${cyan("bunx postboi webhooks")}        Webhooks ${dim("· add <url> · delete <id> · deliveries <id>")}
  ${cyan("bunx postboi members")}         Members ${dim("· invite <email> · remove <ref> · revoke <ref>")}
  ${cyan("bunx postboi messages")}        Recent messages ${dim("· [status]")}
  ${cyan("bunx postboi suppressions")}    Suppressed addresses ${dim("· add <email> · remove <email>")}

${bold("Options")}
  -h, --help        Show this help
  -V, --version     Show the version
`)
}

/** Is an executable named `cmd` on PATH? Lets us skip a push cleanly instead of failing per-var. */
function is_on_path(cmd: string): boolean {
	const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean)
	const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
	return dirs.some((dir) => exts.some((ext) => existsSync(join(dir, cmd + ext))))
}

function run_push(spec: ReturnType<typeof push_spec>): { ok: boolean; reason?: string } {
	const result = spawnSync(spec.cmd, spec.args, {
		input: spec.stdin,
		stdio: [spec.stdin !== undefined ? "pipe" : "inherit", "inherit", "inherit"],
		encoding: "utf8",
	})
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code
		return {
			ok: false,
			reason:
				code === "ENOENT"
					? `\`${spec.cmd}\` is not installed or not on PATH`
					: result.error.message,
		}
	}
	if (typeof result.status === "number" && result.status !== 0) {
		return { ok: false, reason: `\`${spec.cmd}\` exited with code ${result.status}` }
	}
	return { ok: true }
}

/** Pick the env file(s) to write secrets to (auto when only one is detected). */
async function choose_env_targets(
	prompts: Prompts,
	files: Array<string>
): Promise<Array<EnvTarget>> {
	const detected = detect_env_targets(files)
	if (detected.length === 1) return detected

	const choice = await prompts.select<EnvTarget | "all">(`\n${bold("Write to which env file?")}`, [
		...detected.map((t) => ({
			label: t.file,
			value: t as EnvTarget | "all",
			hint: t.format,
		})),
		{ label: "All of them", value: "all" as const },
	])
	return choice === "all" ? detected : [choice]
}

/**
 * Upsert each `KEY=value` into every target env file, and drop stale default vars
 * (POSTBOI_FROM, …) that older inits wrote — env beats config, so a leftover would
 * silently shadow the defaults now committed to postboi.config.
 */
function write_env_values(targets: Array<EnvTarget>, values: Record<string, string>): void {
	console.log()
	const stale = DEFAULT_FIELDS.map((f) => f.env).filter((env) => !(env in values))
	for (const target of targets) {
		let content = existsSync(target.file) ? readFileSync(target.file, "utf8") : ""
		for (const [key, value] of Object.entries(values)) {
			content = upsert_env(content, key, value, target.format)
		}
		const removed = stale.filter((key) => {
			const next = remove_env(content, key)
			const hit = next !== content
			content = next
			return hit
		})
		writeFileSync(target.file, content)
		console.log(`${green("✓")} wrote ${Object.keys(values).length} var(s) to ${bold(target.file)}`)
		for (const key of removed) {
			console.log(
				`  ${yellow("!")} removed stale ${bold(key)} — it would override your postboi.config defaults`
			)
		}
		if (target.note) console.log(`  ${yellow("!")} ${target.note}`)
	}
}

/**
 * The team's synced credentials, when signed in — `{}` otherwise. Fetched once per init
 * flow so a teammate is never asked to paste a key the team already holds: a synced value
 * answers the prompt, silently landing in the env file like a typed one would.
 */
async function synced_credentials(): Promise<Record<string, string>> {
	await ensure_env_loaded()
	const token = read_env("POSTBOI_TOKEN")
	if (!token) return {}
	const synced = await fetch_env_vars(cloud_base(), token)
	return synced?.vars ?? {}
}

/** Every assignment in the project's env file(s) — what the bare `env push` sweep reads. */
function read_project_env(): Record<string, string> {
	const out: Record<string, string> = {}
	for (const target of detect_env_targets(readdirSync("."))) {
		if (!existsSync(target.file)) continue
		Object.assign(out, parse_env(readFileSync(target.file, "utf8")))
	}
	return out
}

/**
 * Push freshly-collected credentials to the account, so teammates (and this developer's
 * next machine) get them from `postboi sync` with no ceremony. Quiet no-op without a
 * token — nothing to sync to — and `POSTBOI_*` vars never sync: the token is per
 * developer, and the rest derive from the account already.
 */
async function sync_credentials_up(values: Record<string, string>): Promise<void> {
	const syncable = Object.fromEntries(
		Object.entries(values).filter(([key]) => !key.startsWith("POSTBOI_"))
	)
	if (Object.keys(syncable).length === 0) return
	await ensure_env_loaded()
	const token = read_env("POSTBOI_TOKEN")
	if (!token) return
	const pushed = await push_env_vars(cloud_base(), token, syncable)
	if (pushed.ok) {
		console.log(
			`${green("✓")} synced ${Object.keys(syncable).length} credential(s) to your Postboi account ${dim("(teammates get them with `postboi sync`)")}`
		)
	} else if (pushed.reason) {
		// A rejection is worth a line; an unreachable API stays quiet — sync is best-effort.
		console.log(yellow(`! credential sync skipped — ${pushed.reason}`))
	}
}

/**
 * Write vars pulled from the account into the project's env file(s) — every one that
 * already exists, or a fresh `.env`. Existing local values are left alone unless `force`:
 * a local override is a decision, and sync doesn't overrule decisions.
 */
function write_pulled_vars(vars: Record<string, string>, force = false): Array<string> {
	const keys = Object.keys(vars).filter((key) => force || read_env(key) === undefined)
	if (keys.length === 0) return []
	const targets = detect_env_targets(readdirSync("."))
	for (const target of targets) {
		let content = existsSync(target.file) ? readFileSync(target.file, "utf8") : ""
		for (const key of keys) content = upsert_env(content, key, vars[key], target.format)
		writeFileSync(target.file, content)
	}
	const gitignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : ""
	for (const target of targets) {
		if (target.file !== ".envrc" && !is_gitignored(gitignore, target.file)) {
			console.log(`  ${yellow("!")} ${bold(target.file)} isn't gitignored — it holds secrets now`)
		}
	}
	return keys
}

/** Offer to gitignore any env file that isn't covered yet. */
async function offer_gitignore(prompts: Prompts, targets: Array<EnvTarget>): Promise<void> {
	const gitignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : ""
	const unignored = targets.map((t) => t.file).filter((file) => !is_gitignored(gitignore, file))
	if (
		unignored.length > 0 &&
		(await prompts.confirm(`\nAdd ${unignored.join(", ")} to .gitignore?`))
	) {
		appendFileSync(".gitignore", `\n${unignored.join("\n")}\n`)
		console.log(`${green("✓")} updated ${bold(".gitignore")}`)
	}
}

/**
 * Offer to push the secrets to a deployment host — detected from config files *and* the
 * SvelteKit adapter (svelte.config / vite.config / package.json), where the real signal lives.
 */
async function offer_host_push(
	prompts: Prompts,
	files: Array<string>,
	values: Record<string, string>
): Promise<void> {
	const config_sources = [
		"svelte.config.js",
		"svelte.config.ts",
		"vite.config.js",
		"vite.config.ts",
		"package.json",
	]
		.filter((f) => files.includes(f))
		.map((f) => {
			try {
				return readFileSync(f, "utf8")
			} catch {
				return ""
			}
		})
	const adapter_host = detect_adapter_host(config_sources)
	const detected_hosts = Array.from(
		new Set([...detect_hosts(files), ...(adapter_host ? [adapter_host] : [])])
	)
	let host: Host | undefined
	if (detected_hosts.length > 0) {
		const picked = await prompts.select<Host | "skip">(`\n${bold("Push these to a host?")}`, [
			...detected_hosts.map((h) => ({
				label: HOST_LABEL[h],
				value: h as Host | "skip",
				hint: "detected",
			})),
			{ label: "Skip", value: "skip" as const },
		])
		if (picked !== "skip") host = picked
	} else {
		const picked = await prompts.select<Host | "skip">(
			`\n${dim("No deployment detected.")} ${bold("Push to a host anyway?")}`,
			[
				{ label: "Vercel", value: "vercel" as Host | "skip" },
				{ label: "Cloudflare (wrangler)", value: "cloudflare" as const },
				{ label: "Netlify", value: "netlify" as const },
				{ label: "Railway", value: "railway" as const },
				{ label: "Skip", value: "skip" as const },
			]
		)
		if (picked !== "skip") host = picked
	}

	if (host && !is_on_path(HOST_CLI[host])) {
		// CLI isn't installed — warn once and print the manual commands rather than
		// failing on every var.
		console.log(`\n${yellow("!")} ${bold(HOST_CLI[host])} not found on PATH — skipping env push.`)
		console.log(`  ${dim("install it, then run:")}`)
		for (const key of Object.keys(values)) console.log(`    ${manual_hint(host, key)}`)
	} else if (host) {
		console.log(`\n${dim(`Pushing to ${HOST_LABEL[host]}…`)}`)
		for (const [key, value] of Object.entries(values)) {
			const result = run_push(push_spec(host, key, value))
			if (result.ok) {
				console.log(`${green("✓")} ${key}`)
			} else {
				console.log(`${red("✗")} ${key} — ${result.reason}`)
				console.log(`  ${dim("run it yourself:")} ${manual_hint(host, key)}`)
			}
		}
	}
}

type DefaultField = {
	arg: string
	label: string
	default?: string
	/** Example shown dimmed after the label — e.g. the `Name <email>` form for `from`. */
	hint?: string
	/** Return an error message to reject the value and re-ask; print-and-undefined to accept. */
	validate?: (value: string) => string | undefined
}

/** Prompt for the optional default fields (committed to postboi.config.ts, not env). */
async function ask_defaults(
	prompts: Prompts,
	fields: Array<DefaultField> = DEFAULT_FIELDS
): Promise<Record<string, string>> {
	const defaults: Record<string, string> = {}
	const names = fields.map((f) => f.arg.replace("_", "-")).join(" / ")
	if (await prompts.confirm(`\nSet ${bold("default")} ${names}?`)) {
		for (const field of fields) {
			while (true) {
				const hint = field.hint ? dim(` — ${field.hint}`) : ""
				const value = await prompts.ask(`${field.label} ${dim("(optional)")}${hint}`, {
					default: field.default,
				})
				const error = value ? field.validate?.(value) : undefined
				if (error) {
					console.log(`${red("✗")} ${error}`)
					continue
				}
				if (value) defaults[field.arg] = value
				break
			}
		}
	}
	return defaults
}

/** Write postboi.config.ts, or show what to merge in when one already exists. */
function write_config(
	provider_key: string,
	defaults: Record<string, string>,
	options: Record<string, string>,
	captcha_key?: string
): void {
	console.log()
	const existing_config = CONFIG_FILES.find((f) => existsSync(f))
	if (existing_config) {
		// Don't clobber a hand-edited file — show what to merge in instead. The captcha key
		// is the exception: it has a safe surgical upsert, so try that first.
		if (captcha_key) {
			const source = readFileSync(existing_config, "utf8")
			const next =
				config_captcha_key(source) === captcha_key
					? source
					: upsert_captcha_key(source, captcha_key)
			if (next && next !== source) {
				writeFileSync(existing_config, next)
				console.log(`${green("✓")} wrote your captcha key to ${bold(existing_config)}`)
			}
			if (next) captcha_key = undefined // handled — keep it out of the merge hint
		}
		console.log(`${yellow("!")} ${bold(existing_config)} already exists — add to it:`)
		console.log(dim(`\n  provider: ${JSON.stringify(provider_key)},`))
		if (Object.keys(defaults).length)
			console.log(dim(`  ${render_block("default", defaults, "  ").trimEnd()}`))
		if (Object.keys(options).length)
			console.log(dim(`  ${render_block("options", options, "  ").trimEnd()}`))
		if (captcha_key)
			console.log(dim(`  ${render_block("captcha", { key: captcha_key }, "  ").trimEnd()}`))
	} else {
		const file = config_filename()
		writeFileSync(file, render_config(provider_key, defaults, options, captcha_key))
		console.log(`${green("✓")} wrote ${bold(file)}`)
	}
}

/**
 * Pick the config filename that will actually load in this project: .ts needs a TS
 * toolchain; plain-JS projects get .js only under `"type": "module"`, and .mjs otherwise —
 * an ESM-syntax .js in a CommonJS project fails to import, and config.ts swallows that
 * failure, so the config would silently vanish.
 */
function config_filename(): string {
	const type_module = (): boolean => {
		try {
			return JSON.parse(readFileSync("package.json", "utf8")).type === "module"
		} catch {
			return false
		}
	}
	return existsSync("tsconfig.json")
		? "postboi.config.ts"
		: type_module()
			? "postboi.config.js"
			: "postboi.config.mjs"
}

/** Make sure postboi itself is installed in the project — it's required, so no prompt. */
function ensure_install(files: Array<string>): void {
	if (!existsSync("package.json")) return
	const pkg = JSON.parse(readFileSync("package.json", "utf8"))
	if (has_dependency(pkg, "postboi")) return
	const pm = detect_package_manager(files, pkg)
	const dev = is_bundled_framework(files, pkg)
	const hint = dev ? ` ${dim("(as a devDependency — bundled at build time)")}` : ""
	console.log(`\n${dim(`Installing ${bold("postboi")} with ${pm}…`)}${hint}`)
	const { cmd, args } = install_command(pm, "postboi", dev)
	const result = run_push({ cmd, args })
	if (result.ok) console.log(`${green("✓")} installed postboi`)
	else console.log(`${red("✗")} ${result.reason} — run \`${cmd} ${args.join(" ")}\` yourself`)
}

/**
 * SvelteKit only: make sure `postboi/remote` is excluded from Vite's dependency
 * prebundle, which would otherwise serve the remote-function module empty. Harmless
 * when remote functions aren't in use, so it's added preemptively.
 */
function ensure_remote_exclude(files: Array<string>): void {
	const vite = files.find((f) => /^vite\.config\.(js|ts|mjs|mts)$/.test(f))
	if (!vite) return
	let pkg: PackageJson | undefined
	try {
		pkg = JSON.parse(readFileSync("package.json", "utf8"))
	} catch {
		return
	}
	if (!has_dependency(pkg, "@sveltejs/kit")) return

	const source = readFileSync(vite, "utf8")

	// Prefer the plugin: it supplies the optimizeDeps exclude *and* bundles postboi.config
	// into the server build, which a hand-written exclude doesn't.
	const plugin = add_vite_plugin(source)
	if (plugin === "present") return
	if (plugin !== "unable") {
		writeFileSync(vite, plugin)
		console.log(
			`${green("✓")} added the ${bold("postboi()")} Vite plugin ${dim(`(${vite} — bundles postboi.config into the server build)`)}`
		)
		return
	}

	// Couldn't place the plugin safely — fall back to the exclude alone.
	const result = add_remote_exclude(source)
	if (result === "present") return
	if (result === "unable") {
		// Only nag when remote functions are actually enabled somewhere.
		const configs = files.filter((f) => /^(svelte|vite)\.config\.(js|ts)$/.test(f))
		const enabled = configs.some((f) => {
			try {
				return readFileSync(f, "utf8").includes("remoteFunctions")
			} catch {
				return false
			}
		})
		if (enabled) {
			console.log(
				`${dim("Add")} ${bold('optimizeDeps: { exclude: ["postboi/remote"] }')} ${dim(`to ${vite} if you use postboi's remote form`)}`
			)
		}
		return
	}
	writeFileSync(vite, result)
	console.log(
		`${green("✓")} excluded ${bold("postboi/remote")} from Vite prebundling ${dim(`(${vite} — needed for SvelteKit remote functions)`)}`
	)
}

/**
 * Ensure a `prepare` script restores the generated types after every install — they live
 * inside node_modules, so a reinstall wipes them. Chains onto an existing prepare script
 * rather than replacing it; no-op when one already runs postboi.
 */
function ensure_prepare(): void {
	if (!existsSync("package.json")) return
	const raw = readFileSync("package.json", "utf8")
	const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
	if (pkg.scripts?.prepare?.includes("postboi")) return
	const prepare = pkg.scripts?.prepare ? `${pkg.scripts.prepare} && postboi sync` : "postboi sync"
	pkg.scripts = { ...pkg.scripts, prepare }
	const indent = /^(\t| +)"/m.exec(raw)?.[1] ?? "\t"
	writeFileSync("package.json", `${JSON.stringify(pkg, null, indent)}\n`)
	console.log(
		`${green("✓")} set ${cyan(`"prepare": "${prepare}"`)} ${dim("(restores the types after installs)")}`
	)
}

/**
 * Regenerate the artifacts in node_modules: the `from` types from the account's current
 * domains, and the baked captcha key for `<Captcha />`. Safe as a predev/CI hook: always
 * exits 0, and quietly no-ops without a token or a reachable API. The committed
 * `postboi.config.*` is the offline source of truth for the key, so tokenless builds
 * (CI) keep the captcha — only the `from` types need the token.
 */
/**
 * Warn when a `postboi.config.*` carries runtime settings but the Vite plugin isn't wired up.
 *
 * The config is found by walking up from `process.cwd()` at runtime, which covers local dev
 * but not a deployed bundle — nothing imports the file, so tracing leaves it out of a
 * serverless function. Defaults and hooks then silently vanish in production while working
 * perfectly on the developer's machine.
 *
 * Only warns when something in the config actually matters at send time. `provider` is
 * usually redundant (POSTBOI_TOKEN selects the provider on its own) and `captcha.key` is
 * baked into the installed package at build time, so a config holding just those loses
 * nothing by not being bundled.
 */
function warn_unbundled_config(): void {
	const config_file = CONFIG_FILES.find((f) => existsSync(f))
	if (!config_file) return

	const vite = ["vite.config.ts", "vite.config.js"].find((f) => existsSync(f))
	if (!vite) return
	if (readFileSync(vite, "utf8").includes("postboi/vite")) return

	const source = readFileSync(config_file, "utf8")
	// Strip comments, then drop empty objects: every scaffolded config ships a `hooks` block
	// containing nothing but commented-out examples, and warning about that would fire on
	// every project while nothing is actually at risk.
	const live = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.replace(/\b\w+\s*:\s*\{\s*\}\s*,?/g, "")
	const runtime = ["default", "hooks", "options", "timeout", "retries", "retry_delay", "auto_text"]
	const used = runtime.filter((key) => new RegExp(`\\b${key}\\s*:`).test(live))
	if (used.length === 0) return

	console.log(
		`${yellow("!")} ${bold(config_file)} sets ${bold(used.join(", "))}, but ${bold(vite)} is missing the ${bold("postboi()")} plugin.`
	)
	console.log(
		dim(
			`  Without it the config isn't bundled, so those settings work locally and vanish once deployed.\n  Add: import { postboi } from "postboi/vite" — then postboi() in plugins.`
		)
	)
}

/**
 * Preview a secret: enough to recognise a value, never enough to reconstruct one. The
 * reveal scales with length — at most a quarter of the value, capped at six characters,
 * and nothing at all for short secrets (showing 6 of a 9-char secret is most of it).
 */
function masked(value: string): string {
	const budget = Math.min(6, Math.floor(value.length / 4))
	if (budget < 3) return "•••"
	const head = Math.ceil((budget * 2) / 3)
	return `${value.slice(0, head)}…${value.slice(-(budget - head))}`
}

/**
 * `postboi env` — the team's synced channel credentials, explicitly.
 *
 * `init` pushes what it collects and `sync` pulls what's missing, so most projects never
 * run this. It exists for the edges: seeing what's synced, pushing a credential that was
 * set by hand, or deliberately taking the team's values over local ones.
 */
async function env_command(args: Array<string>): Promise<void> {
	await ensure_env_loaded()
	const token = read_env("POSTBOI_TOKEN")
	if (!token) {
		console.log(red("postboi env needs a POSTBOI_TOKEN — run `bunx postboi init` first."))
		return exit(1)
	}
	const base = cloud_base()
	const action = args[0] ?? "list"

	if (action === "list") {
		const synced = await fetch_env_vars(base, token)
		if (!synced) return void console.log(red("Could not reach the Postboi API."))
		const keys = Object.keys(synced.vars)
		if (keys.length === 0) {
			console.log(
				dim(
					"Nothing synced yet. `postboi init` pushes credentials as it collects them, or push by hand: `postboi env push`."
				)
			)
			return
		}
		console.log(`${bold("Synced credentials")} ${dim(`(${keys.length})`)}`)
		for (const key of keys) {
			console.log(`  ${green("✓")} ${bold(key)} ${dim(masked(synced.vars[key]))}`)
		}
		console.log(dim("\nPull into this machine: `postboi sync` (or `postboi env pull --force`)"))
		return
	}

	if (action === "push") {
		// Explicit KEY=value args win; otherwise push every registry-known credential the
		// *project's env files* hold. Never the ambient shell environment: an exported
		// AWS_SECRET_ACCESS_KEY for unrelated work matches the registry too, and a bare
		// `env push` must not quietly sync it to the whole team. POSTBOI_* never syncs —
		// the token is per developer.
		const explicit = args.slice(1).filter((arg) => arg.includes("="))
		const vars: Record<string, string> = {}
		if (explicit.length > 0) {
			for (const pair of explicit) {
				const at = pair.indexOf("=")
				vars[pair.slice(0, at)] = pair.slice(at + 1)
			}
		} else {
			const local = read_project_env()
			for (const key of credential_env_keys()) {
				const value = local[key]
				if (value !== undefined && value !== "") vars[key] = value
			}
		}
		const keys = Object.keys(vars).filter((key) => !key.startsWith("POSTBOI_"))
		if (keys.length === 0) {
			console.log(
				dim(
					"No credentials found in the project's env files to push. Pass KEY=value to push one explicitly."
				)
			)
			return
		}
		const payload = Object.fromEntries(keys.map((key) => [key, vars[key]]))
		const pushed = await push_env_vars(base, token, payload)
		if (!pushed.ok) {
			console.log(red(`Push failed — ${pushed.reason ?? "could not reach the Postboi API."}`))
			return exit(1)
		}
		console.log(`${green("✓")} pushed ${keys.length} credential(s): ${bold(keys.join(", "))}`)
		return
	}

	if (action === "pull") {
		const synced = await fetch_env_vars(base, token)
		if (!synced) return void console.log(red("Could not reach the Postboi API."))
		const written = write_pulled_vars(synced.vars, args.includes("--force"))
		if (written.length === 0) {
			console.log(dim("Nothing to pull — every synced credential already has a local value."))
			return
		}
		console.log(`${green("✓")} pulled ${written.length} credential(s): ${bold(written.join(", "))}`)
		return
	}

	if (action === "remove" && args[1]) {
		const removed = await push_env_vars(base, token, { [args[1]]: null })
		if (!removed.ok) {
			console.log(red(`Remove failed — ${removed.reason ?? "could not reach the Postboi API."}`))
			return exit(1)
		}
		console.log(`${green("✓")} removed ${bold(args[1])} from the synced credentials`)
		return
	}

	console.log(red(`Unknown env action: ${action}. Try list, push, pull or remove <KEY>.`))
	exit(1)
}

async function sync(): Promise<void> {
	await ensure_env_loaded()
	if (!existsSync(TYPES_TARGET)) {
		console.log(dim("postboi sync: postboi isn't installed here — install it, then re-run."))
		return
	}
	refresh_skill()
	warn_unbundled_config()

	const config_file = CONFIG_FILES.find((f) => existsSync(f))
	const config_source = config_file ? readFileSync(config_file, "utf8") : undefined
	const config_key = config_source ? config_captcha_key(config_source) : undefined
	const bake = (key: string | undefined, source: string) => {
		if (write_runtime(key)) {
			console.log(`${green("✓")} captcha key baked for <Captcha /> ${dim(`(from ${source})`)}`)
		}
	}

	const token = read_env("POSTBOI_TOKEN")
	if (!token) {
		bake(config_key, config_file ?? "config")
		console.log(dim("postboi sync: no POSTBOI_TOKEN — skipping the generated from types."))
		return
	}
	const account = await fetch_domains(cloud_base(), token)
	if (!account) {
		bake(config_key, config_file ?? "config")
		console.log(
			yellow("postboi sync: could not fetch domains from the Postboi provider — skipped.")
		)
		return
	}

	// Keep POSTBOI_WEBHOOK_SECRET in step with the dashboard's endpoints — only touch env
	// files that already exist (never create one from a predev hook), and only when the
	// value actually changed, so this stays a quiet no-op on a synced project.
	if (account.webhook_secrets.length) {
		const next = account.webhook_secrets.join(" ")
		if (read_env("POSTBOI_WEBHOOK_SECRET") !== next) {
			let wrote = false
			for (const target of detect_env_targets(readdirSync("."))) {
				if (!existsSync(target.file)) continue
				const content = readFileSync(target.file, "utf8")
				writeFileSync(
					target.file,
					upsert_env(content, "POSTBOI_WEBHOOK_SECRET", next, target.format)
				)
				wrote = true
			}
			if (wrote) console.log(`${green("✓")} synced ${bold("POSTBOI_WEBHOOK_SECRET")}`)
		}
	}

	// Pull the team's synced channel credentials into the local env. Only keys with no
	// local value — a deliberate local override always wins; `postboi env pull --force`
	// is the explicit way to take the team's values wholesale.
	const synced = await fetch_env_vars(cloud_base(), token)
	if (synced && Object.keys(synced.vars).length > 0) {
		const written = write_pulled_vars(synced.vars)
		if (written.length > 0) {
			console.log(
				`${green("✓")} pulled ${written.length} synced credential(s): ${bold(written.join(", "))}`
			)
		}
	}

	const captcha_key = account.captcha_key ?? config_key
	bake(captcha_key, account.captcha_key ? "the Postboi provider" : (config_file ?? "config"))
	// Keep the committed config as the tokenless source of truth for the key.
	if (account.captcha_key && config_file && config_source && account.captcha_key !== config_key) {
		const next = upsert_captcha_key(config_source, account.captcha_key)
		if (next) {
			writeFileSync(config_file, next)
			console.log(`${green("✓")} wrote the captcha key to ${bold(config_file)} — commit it`)
		} else {
			console.log(
				`${yellow("!")} add \`captcha: { key: ${JSON.stringify(account.captcha_key)} }\` to ${bold(config_file)} so tokenless builds keep the captcha`
			)
		}
	}

	const file = write_types(account.send_address ?? read_env("POSTBOI_FROM"), account.domains)
	if (!file) {
		console.log(dim("postboi sync: no sending addresses on this account yet."))
		return
	}
	console.log(`${green("✓")} wrote ${bold(file)}`)
	for (const d of account.domains) {
		console.log(
			d.status === "verified"
				? `  ${green("✓")} ${d.domain}`
				: `  ${yellow("⌛")} ${d.domain} ${dim(`(${d.status})`)}`
		)
	}
}

/**
 * The Postboi provider onboarding: authorise this device in the browser, write the resulting
 * `POSTBOI_TOKEN`, then a `postboi.config.ts` for defaults and hooks. No provider account, no DNS.
 */
async function cloud_init(prompts: Prompts, files: Array<string>): Promise<void> {
	const base = cloud_base()

	// Re-running init shouldn't mint a new token every time — reuse an existing
	// POSTBOI_TOKEN that still works, so the rest of the walkthrough (defaults,
	// config) can be repeated freely. A dead/revoked token falls through to auth.
	await ensure_env_loaded()
	const existing_token = read_env("POSTBOI_TOKEN")
	let cloud_account = existing_token ? await fetch_domains(base, existing_token) : undefined
	const reused = cloud_account !== undefined
	let token = existing_token ?? ""
	let send_address = cloud_account?.send_address

	if (reused) {
		console.log(`${green("✓")} using your existing ${bold("POSTBOI_TOKEN")}`)
	} else {
		const start = await start_device_auth(base)

		console.log(`\n${bold("Authorise this device in your browser:")}\n`)
		console.log(`  ${cyan(start.url)}\n`)
		if (open_browser(start.url)) console.log(dim("  (opening in your default browser)"))
		console.log(dim("\nWaiting for authorisation…"))

		const claim = await poll_device_auth(base, start)
		token = claim.token
		send_address = claim.send_address
		console.log(`${green("✓")} device authorised`)

		// The domain list drives the default-from hint, the post-input warning, and the
		// generated `from` types; the captcha key gets baked in for the <Captcha /> components.
		// Best-effort: an older API just means no domain info.
		cloud_account = await fetch_domains(base, token)
	}
	const domains: Array<PostboiDomain> = cloud_account?.domains ?? []
	if (domains.length > 0) {
		const list = domains
			.map((d) => `${d.domain} ${d.status === "verified" ? green("✓") : yellow("⌛")}`)
			.join(dim(", "))
		console.log(`${dim("Domains:")} ${list}`)
	}

	const values: Record<string, string> = {}
	if (!reused) values.POSTBOI_TOKEN = token

	// Every endpoint secret in one var; receive() accepts the whole set, so webhooks are
	// wired without the user copying a whsec_ from the dashboard. `postboi sync` refreshes it.
	if (cloud_account?.webhook_secrets.length) {
		const secrets = cloud_account.webhook_secrets.join(" ")
		if (read_env("POSTBOI_WEBHOOK_SECRET") !== secrets) values.POSTBOI_WEBHOOK_SECRET = secrets
	}

	// Reject a from we know the API would bounce (from_not_allowed) and re-ask; a pending
	// domain is accepted with a warning — it's theirs, the DNS just hasn't landed yet.
	const validate_from = (value: string): string | undefined => {
		// Nothing to validate against (older API, no domains yet) — accept anything.
		if (!send_address && domains.length === 0) return undefined
		const status = from_status(value, send_address, domains)
		if (status.level === "unknown") {
			const permitted = [
				...(send_address ? [send_address] : []),
				...domains.map((d) => `…@${d.domain}`),
			].join(", ")
			return `${bold(status.domain)} isn't a domain on your account — use ${permitted}, or verify the domain in the dashboard first.`
		}
		if (status.level === "pending")
			console.log(
				`${yellow("!")} ${bold(status.domain)} is still pending verification — mail from it may not be delivered yet.`
			)
		return undefined
	}

	// `from` is only worth asking when there's a choice (a custom domain); otherwise the
	// API already falls back to the account's address. Config-first: whatever's chosen goes
	// to postboi.config, and the environment carries nothing but the token — POSTBOI_FROM
	// remains a manual per-environment override (env beats config).
	const fields = DEFAULT_FIELDS.filter(
		(f) => f.arg !== "from" || domains.length > 0 || !send_address
	).map((f) => (f.arg === "from" ? { ...f, default: send_address, validate: validate_from } : f))
	const config_defaults = await ask_defaults(prompts, fields)

	// Nothing new to write on a re-run with an up-to-date env — skip the env-file dance.
	if (Object.keys(values).length > 0) {
		const targets = await choose_env_targets(prompts, files)
		write_env_values(targets, values)
		await offer_gitignore(prompts, targets)
		await offer_host_push(prompts, files, values)
	}
	ensure_install(files)
	ensure_remote_exclude(files)

	// The committed home for defaults, hooks, and the publishable captcha key. A
	// POSTBOI_TOKEN alone already routes send() to Postboi, but `provider: "postboi"` makes
	// it explicit.
	write_config("postboi", config_defaults, {}, cloud_account?.captcha_key)

	// Lives inside node_modules — nothing to commit, no diffs, `bunx postboi sync` refreshes it.
	const types_file = write_types(send_address, domains)
	if (types_file) {
		console.log(
			`${green("✓")} typed ${bold("from")} to your addresses ${dim(`(generated into ${types_file})`)}`
		)
	}
	if (write_runtime(cloud_account?.captcha_key)) {
		console.log(`${green("✓")} baked your captcha key — drop ${bold("<Captcha />")} into any form`)
	}
	if (types_file || cloud_account?.captcha_key) ensure_prepare()

	await offer_skill(prompts)

	console.log(`\n${green(bold("Done!"))} Just send:\n`)
	console.log(
		dim('import { mail } from "postboi"\n\nawait mail({ to: "…", subject: "…", body: "…" })') + "\n"
	)
	const from = config_defaults.from ?? send_address
	const from_note = from
		? `Emails send from ${from}`
		: "Emails send from your account's send.postboi.email address"
	const domain_hint = config_defaults.from
		? ""
		: " Verify a domain in the dashboard to send from your own."
	console.log(dim(`${from_note} — set reply_to to receive replies.${domain_hint}`) + "\n")
}

/** Bring-your-own-provider onboarding: pick a provider, collect creds, write config. */
async function byo_init(prompts: Prompts, files: Array<string>): Promise<void> {
	// 1. Choose a provider
	const provider = await prompts.select<CliProvider>(
		bold("Which provider?"),
		PROVIDERS.map((p) => ({ label: p.name, value: p }))
	)

	// 2. Collect credentials. Secrets go to the env file; everything non-secret is committed
	// to postboi.config.ts — so the best case is a single env var (the API key). A value
	// the team already synced answers its prompt: type it once, on one machine, ever.
	const team = await synced_credentials()
	console.log(`\n${dim("Get your credentials at")} ${cyan(provider.url)}\n`)
	const values: Record<string, string> = {} // secrets → env file
	const config_options: Record<string, string> = {} // non-secrets → config file
	for (const field of provider.fields) {
		const from_team = team[field.env]
		if (from_team !== undefined) {
			console.log(`${green("✓")} ${bold(field.env)} — using your team's synced credential`)
			if (field.secret) values[field.env] = from_team
			else config_options[field.arg] = from_team
			continue
		}
		const value = await prompts.ask(`${field.label} ${dim(`(${field.env})`)}`, {
			required: field.default === undefined,
			default: field.default,
		})
		if (field.secret) {
			// Optional secrets (default "") left blank are omitted, not written empty.
			if (value) values[field.env] = value
		} else if (value) config_options[field.arg] = value
	}

	// 2b. Optional default fields (committed to config, not env)
	const config_defaults = await ask_defaults(prompts)

	// 3–6. Write env vars, gitignore them, offer a host push
	const targets = await choose_env_targets(prompts, files)
	write_env_values(targets, values)
	await offer_gitignore(prompts, targets)
	await offer_host_push(prompts, files, values)
	await sync_credentials_up(values)

	// 7. Make sure postboi itself is installed
	ensure_install(files)
	ensure_remote_exclude(files)

	// 7b. Write postboi.config.ts — the committed home for provider + non-secret config.
	write_config(provider.key, config_defaults, config_options)

	// 7c. Offer the bundled agent skill
	await offer_skill(prompts)

	// 8. Done — show how to use it
	console.log(`\n${green(bold("Done!"))} Now just send — no setup, no instance:\n`)
	console.log(
		dim('import { mail } from "postboi"\n\nawait mail({ to: "…", subject: "…", body: "…" })') + "\n"
	)
	console.log(`${dim("…or construct the provider yourself:")}\n`)
	console.log(dim(usage_snippet(provider)) + "\n")
}

/**
 * Countries offered by name in the SMS flow. A short list on purpose: it exists to set the
 * default country and to order the provider list, and anyone outside it can type a dialling
 * code, which `to_e164` accepts directly.
 */
const SMS_COUNTRIES: Array<{ label: string; value: string }> = [
	{ label: "United Kingdom", value: "GB" },
	{ label: "United States", value: "US" },
	{ label: "Ireland", value: "IE" },
	{ label: "Germany", value: "DE" },
	{ label: "France", value: "FR" },
	{ label: "Australia", value: "AU" },
]

/**
 * SMS onboarding. Unlike email, the right provider depends on **where you're sending** —
 * UK-native providers are materially cheaper into the UK and useless elsewhere — so this
 * asks for a destination first and orders the list by it rather than presenting a flat menu.
 */
async function sms_init(prompts: Prompts, files: Array<string>): Promise<void> {
	// 1. Destination first: it decides the ordering, and it's also the default country used
	// to resolve national numbers like "07788 223344".
	const country = await prompts.select<string>(bold("Where are you sending?"), [
		...SMS_COUNTRIES,
		{ label: "Somewhere else / several countries", value: "" },
	])

	// 2. Providers whose region matches come first — that's the whole point of asking.
	const ranked = [...SMS_PROVIDERS].sort((a, b) => {
		const score = (p: CliSmsProvider) =>
			country && p.regions.includes(country) ? 0 : p.regions.includes("global") ? 1 : 2
		return score(a) - score(b)
	})
	const provider = await prompts.select<CliSmsProvider>(
		`\n${bold("Which provider?")}`,
		ranked.map((p) => ({
			label: p.name,
			value: p,
			hint: [p.price, p.note].filter(Boolean).join(" · "),
		}))
	)
	if (provider.verified) {
		console.log(
			dim(`\nPrices move — ${provider.name} was last checked on ${provider.verified}.`) + "\n"
		)
	}

	// 3. Credentials. Same split as email: secrets to env, everything else committed —
	// and a value the team already synced answers its prompt.
	const team = await synced_credentials()
	console.log(`${dim("Get your credentials at")} ${cyan(provider.url)}\n`)
	const values: Record<string, string> = {}
	const config_options: Record<string, string> = {}
	for (const field of provider.fields) {
		const from_team = team[field.env]
		if (from_team !== undefined) {
			console.log(`${green("✓")} ${bold(field.env)} — using your team's synced credential`)
			if (field.secret) values[field.env] = from_team
			else config_options[field.arg] = from_team
			continue
		}
		const value = await prompts.ask(`${field.label} ${dim(`(${field.env})`)}`, {
			required: field.default === undefined,
			default: field.default,
		})
		if (field.secret) {
			if (value) values[field.env] = value
		} else if (value) config_options[field.arg] = value
	}

	// 4. Defaults. The country is pre-filled from step 1, so it's usually just Enter.
	const config_defaults: Record<string, string> = {}
	if (country) config_defaults.country = country
	for (const field of SMS_DEFAULT_FIELDS) {
		if (field.arg === "country" && country) continue
		const value = await prompts.ask(
			`\n${field.label} ${dim("(optional)")}\n${dim(field.hint ?? "")}`,
			{
				required: false,
			}
		)
		if (value) config_defaults[field.arg] = value
	}

	// 5–6. Write env vars, gitignore them, offer a host push
	const targets = await choose_env_targets(prompts, files)
	write_env_values(targets, values)
	await offer_gitignore(prompts, targets)
	await offer_host_push(prompts, files, values)
	await sync_credentials_up(values)

	ensure_install(files)
	write_channel_config("sms", provider.key, config_defaults, config_options)

	console.log(`\n${green(bold("Done!"))} Now just text:\n`)
	console.log(
		dim('import { sms } from "postboi"\n\nawait sms({ to: "+447788223344", message: "…" })') + "\n"
	)
	// Worth saying out loud: the safe default surprises people who expect a real send.
	console.log(
		dim(
			"In development texts are logged, not sent — set POSTBOI_SMS_DEV=send when you want real delivery."
		) + "\n"
	)
}

/** The shape `channel_init` needs from either the chat or the push registry. */
type ChannelProvider = {
	key: string
	name: string
	url: string
	note: string
	fields: ReadonlyArray<{
		env: string
		arg: string
		label: string
		secret?: boolean
		default?: string
	}>
}

/**
 * Mint a VAPID key pair (P-256): the public key as the base64url uncompressed point the
 * push service and `subscribe_push` expect, the private key as the JWK `d` scalar —
 * exactly the shapes `vapid_header` consumes.
 */
export async function generate_vapid_keys(): Promise<{ public_key: string; private_key: string }> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])
	const point = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
	return { public_key: to_base64url(point), private_key: jwk.d! }
}

/**
 * What makes one channel's init its own: the registry, the picker prompt, and the
 * done-snippet. A compile-checked map instead of per-call ternary chains, so a new
 * channel can't silently fall through to another channel's branch.
 */
const CHANNEL_INIT = {
	chat: {
		registry: CHAT_PROVIDERS as ReadonlyArray<ChannelProvider>,
		picker: "Which chat platform?",
		// The public surface is the platform function, so the snippet names the one just
		// configured — there is no generic chat() import.
		done: (provider: ChannelProvider) => [
			`import { ${provider.key} } from "postboi"\n\nawait ${provider.key}({ message: "Deploy finished" })`,
		],
	},
	push: {
		registry: PUSH_PROVIDERS as ReadonlyArray<ChannelProvider>,
		picker: "Which push service?",
		done: () => [
			'import { push } from "postboi"\n\nawait push({ to: subscription, message: "…" })',
			// The half people forget: a push target has to be registered before it exists.
			"Subscribe in the browser with `subscribe_push()` from postboi/push-client first.",
		],
	},
	whatsapp: {
		registry: WHATSAPP_PROVIDERS as ReadonlyArray<ChannelProvider>,
		picker: "WhatsApp via which provider?",
		done: () => [
			'import { whatsapp } from "postboi"\n\nawait whatsapp({ to: "+447788223344", template: "…", variables: { name: "Ada" } })',
			// The constraint that shapes everything: free-form only works in-window.
			"Free-form `message` only delivers within 24h of the user's last reply — templates deliver anytime.\nIn development messages are logged, not sent — set POSTBOI_WHATSAPP_DEV=send for real delivery.",
		],
	},
} satisfies Record<"chat" | "push" | "whatsapp", unknown>

/**
 * Chat, push and WhatsApp onboarding.
 *
 * Simpler than SMS: none of these have destination-dependent pricing, so there's nothing
 * to ask before showing the provider list, and few defaults worth prompting for — a chat
 * webhook URL is the credential, and a push target is per-device rather than global.
 */
async function channel_init(
	prompts: Prompts,
	files: Array<string>,
	channel: "chat" | "push" | "whatsapp"
): Promise<void> {
	// The registries are separate const-narrowed tuples; the map widens each to the shared
	// shape, which carries every field used here.
	const spec = CHANNEL_INIT[channel]
	const provider = await prompts.select<ChannelProvider>(
		bold(spec.picker),
		spec.registry.map((p) => ({ label: p.name, value: p, hint: p.note }))
	)

	const team = await synced_credentials()
	console.log(`\n${dim("Get your credentials at")} ${cyan(provider.url)}\n`)
	const values: Record<string, string> = {}
	const config_options: Record<string, string> = {}
	// Values the team already synced answer their prompts — type it once, on one machine.
	const prefilled: Record<string, string> = {}
	for (const field of provider.fields) {
		if (team[field.env] !== undefined) {
			console.log(`${green("✓")} ${bold(field.env)} — using your team's synced credential`)
			prefilled[field.env] = team[field.env]
		}
	}
	// Web Push's "credential" is a VAPID key pair you mint yourself — no dashboard hands
	// one out, so mint it here rather than dead-ending the prompt on keys nobody has.
	// Skipped when the team's synced pair just covered it: a second pair would orphan
	// every subscription collected under the first.
	if (
		provider.key === "webpush" &&
		(prefilled.VAPID_PUBLIC_KEY === undefined || prefilled.VAPID_PRIVATE_KEY === undefined) &&
		(await prompts.confirm("Generate a fresh VAPID key pair?"))
	) {
		const pair = await generate_vapid_keys()
		prefilled.VAPID_PUBLIC_KEY = pair.public_key
		prefilled.VAPID_PRIVATE_KEY = pair.private_key
		console.log(
			`${green("✓")} generated — the public key also goes to the browser's \`subscribe_push({ key })\`:\n  ${dim(pair.public_key)}\n`
		)
	}
	for (const field of provider.fields) {
		const value =
			prefilled[field.env] ??
			(await prompts.ask(`${field.label} ${dim(`(${field.env})`)}`, {
				required: field.default === undefined,
				default: field.default,
			}))
		if (field.secret) {
			if (value) values[field.env] = value
		} else if (value) config_options[field.arg] = value
	}

	// Channel defaults, committed to the config's `default:` block — not to `options`,
	// which is strictly provider constructor arguments. Only Telegram has one worth asking
	// for: its destination is a chat id you can't know until the bot hears from the user,
	// where the webhook providers carry the destination inside the (secret) URL.
	const config_defaults: Record<string, string> = {}
	if (provider.key === "telegram") {
		const chat_id = await prompts.ask(
			`\nDefault chat id ${dim("(optional — the id your bot should post to)")}`,
			{ required: false }
		)
		if (chat_id) config_defaults.to = chat_id
	}
	if (channel === "whatsapp") {
		// Twilio addresses the sender by number; Meta's sender is the phone_number_id
		// already collected above, so `from` would be dead config there.
		if (provider.key === "twilio") {
			const from = await prompts.ask(
				`\nSender number ${dim("(optional — your WhatsApp-enabled number, e.g. +14155238886)")}`,
				{ required: false }
			)
			if (from) config_defaults.from = from
		}
		const country = await prompts.ask(
			`\nDefault country ${dim('(optional — resolves national numbers; an ISO code like "GB")')}`,
			{ required: false }
		)
		if (country) config_defaults.country = country
	}

	const targets = await choose_env_targets(prompts, files)
	write_env_values(targets, values)
	await offer_gitignore(prompts, targets)
	await offer_host_push(prompts, files, values)
	await sync_credentials_up(values)

	ensure_install(files)
	write_channel_config(channel, provider.key, config_defaults, config_options)

	console.log(`\n${green(bold("Done!"))}\n`)
	for (const line of spec.done(provider)) console.log(dim(line) + "\n")
}

/** Write (or show how to merge) a channel block of `postboi.config`. */
function write_channel_config(
	channel: "sms" | "chat" | "push" | "whatsapp",
	provider_key: string,
	defaults: Record<string, string>,
	options: Record<string, string>
): void {
	console.log()
	const existing = CONFIG_FILES.find((f) => existsSync(f))
	if (existing) {
		console.log(`${yellow("!")} ${bold(existing)} already exists — add to it:`)
		console.log(dim(`\n  ${channel}: {`))
		console.log(dim(`    provider: ${JSON.stringify(provider_key)},`))
		if (Object.keys(defaults).length)
			console.log(dim(`  ${render_block("default", defaults, "    ").trimEnd()}`))
		if (Object.keys(options).length)
			console.log(dim(`  ${render_block("options", options, "    ").trimEnd()}`))
		console.log(dim(`  },`))
		return
	}
	const file = config_filename()
	writeFileSync(file, render_channel_config(channel, provider_key, defaults, options))
	console.log(`${green("✓")} wrote ${bold(file)}`)
}

async function init(channel?: "sms" | "chat" | "push" | "whatsapp"): Promise<void> {
	const prompts = create_prompts()
	console.log()
	console.log(banner())
	console.log()

	const files = readdirSync(cwd())

	try {
		if (channel === "sms") return await sms_init(prompts, files)
		if (channel) return await channel_init(prompts, files, channel)
		const mode = await prompts.select<"cloud" | "byo" | "sms" | "chat" | "push" | "whatsapp">(
			bold("What do you want to set up?"),
			[
				{
					label: "Email — Postboi",
					value: "cloud",
					hint: "zero config — sign in and start sending",
				},
				{
					label: "Email — bring your own provider",
					value: "byo",
					hint: "Resend, SES, Mailgun, Postmark, …",
				},
				{
					label: "SMS",
					value: "sms",
					hint: "The SMS Works, Twilio, Amazon SNS",
				},
				{
					label: "Push notifications",
					value: "push",
					hint: "Web Push, Firebase Cloud Messaging",
				},
				{
					label: "Chat",
					value: "chat",
					hint: "Slack, Discord, Teams, Telegram",
				},
				{
					label: "WhatsApp",
					value: "whatsapp",
					hint: "Twilio, Meta Cloud API",
				},
			]
		)
		if (mode === "cloud") await cloud_init(prompts, files)
		else if (mode === "sms") await sms_init(prompts, files)
		else if (mode === "chat" || mode === "push" || mode === "whatsapp")
			await channel_init(prompts, files, mode)
		else await byo_init(prompts, files)
	} finally {
		prompts.close()
	}
}

async function main(): Promise<void> {
	const command = argv[2]
	if (command === "-V" || command === "--version") return console.log(version())
	if (command === "init") {
		const channel = (["sms", "chat", "push", "whatsapp"] as const).find((c) =>
			argv.includes(`--${c}`)
		)
		return init(channel)
	}
	if (command === "sync") return sync()
	if (command === "env") return env_command(argv.slice(3))
	if (command === "dev") return dev_command(argv.slice(3))
	if (command && (await api_command(command, argv.slice(3)))) return
	help()
	if (command && command !== "-h" && command !== "--help") {
		console.log(red(`Unknown command: ${command}`))
		exit(1)
	}
}

main().catch((error) => {
	if (error instanceof PromptCancelledError) {
		console.log(dim("\nCancelled."))
		exit(130)
	}
	console.error(red(error instanceof Error ? error.message : String(error)))
	exit(1)
})
