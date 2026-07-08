#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, delimiter } from "node:path"
import { argv, cwd, exit, platform, env } from "node:process"
import {
	PROVIDERS,
	DEFAULT_FIELDS,
	usage_snippet,
	render_config,
	render_block,
	type CliProvider,
} from "./providers.js"
import { detect_env_targets, upsert_env, remove_env, is_gitignored, type EnvTarget } from "./env.js"
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
	has_dependency,
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
	type PostboiDomain,
} from "./postboi.js"
import {
	write_types,
	write_runtime,
	from_status,
	config_captcha_key,
	upsert_captcha_key,
	TYPES_TARGET,
} from "./typegen.js"
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
  ${cyan("bunx postboi sync")}     Refresh the generated from types from your Postboi domains

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
		// Match the project: .ts needs a TS toolchain; plain-JS projects get .js (ESM) or .mjs.
		const type_module = (): boolean => {
			try {
				return JSON.parse(readFileSync("package.json", "utf8")).type === "module"
			} catch {
				return false
			}
		}
		const file = existsSync("tsconfig.json")
			? "postboi.config.ts"
			: type_module()
				? "postboi.config.js"
				: "postboi.config.mjs"
		writeFileSync(file, render_config(provider_key, defaults, options, captcha_key))
		console.log(`${green("✓")} wrote ${bold(file)}`)
	}
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
async function sync(): Promise<void> {
	await ensure_env_loaded()
	if (!existsSync(TYPES_TARGET)) {
		console.log(dim("postboi sync: postboi isn't installed here — install it, then re-run."))
		return
	}

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
	const start = await start_device_auth(base)

	console.log(`\n${bold("Authorise this device in your browser:")}\n`)
	console.log(`  ${cyan(start.url)}\n`)
	if (open_browser(start.url)) console.log(dim("  (opening in your default browser)"))
	console.log(dim("\nWaiting for authorisation…"))

	const { token, send_address } = await poll_device_auth(base, start)
	console.log(`${green("✓")} device authorised`)

	// The domain list drives the default-from hint, the post-input warning, and the
	// generated `from` types; the captcha key gets baked in for the <Captcha /> components.
	// Best-effort: an older API just means no domain info.
	const cloud_account = await fetch_domains(base, token)
	const domains: Array<PostboiDomain> = cloud_account?.domains ?? []
	if (domains.length > 0) {
		const list = domains
			.map((d) => `${d.domain} ${d.status === "verified" ? green("✓") : yellow("⌛")}`)
			.join(dim(", "))
		console.log(`${dim("Domains:")} ${list}`)
	}

	const values: Record<string, string> = { POSTBOI_TOKEN: token }

	// Every endpoint secret in one var; receive() accepts the whole set, so webhooks are
	// wired without the user copying a whsec_ from the dashboard. `postboi sync` refreshes it.
	if (cloud_account?.webhook_secrets.length)
		values.POSTBOI_WEBHOOK_SECRET = cloud_account.webhook_secrets.join(" ")

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

	const targets = await choose_env_targets(prompts, files)
	write_env_values(targets, values)
	await offer_gitignore(prompts, targets)
	await offer_host_push(prompts, files, values)
	ensure_install(files)

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
	// to postboi.config.ts — so the best case is a single env var (the API key).
	console.log(`\n${dim("Get your credentials at")} ${cyan(provider.url)}\n`)
	const values: Record<string, string> = {} // secrets → env file
	const config_options: Record<string, string> = {} // non-secrets → config file
	for (const field of provider.fields) {
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

	// 7. Make sure postboi itself is installed
	ensure_install(files)

	// 7b. Write postboi.config.ts — the committed home for provider + non-secret config.
	write_config(provider.key, config_defaults, config_options)

	// 8. Done — show how to use it
	console.log(`\n${green(bold("Done!"))} Now just send — no setup, no instance:\n`)
	console.log(
		dim('import { send } from "postboi"\n\nawait send({ to: "…", subject: "…", body: "…" })') + "\n"
	)
	console.log(`${dim("…or construct the provider yourself:")}\n`)
	console.log(dim(usage_snippet(provider)) + "\n")
}

async function init(): Promise<void> {
	const prompts = create_prompts()
	console.log()
	console.log(banner())
	console.log()

	const files = readdirSync(cwd())

	try {
		const mode = await prompts.select<"cloud" | "byo">(bold("How do you want to send?"), [
			{
				label: "Postboi",
				value: "cloud",
				hint: "zero config — sign in and start sending",
			},
			{
				label: "Bring your own provider",
				value: "byo",
				hint: "Resend, SES, Mailgun, Postmark, …",
			},
		])
		if (mode === "cloud") await cloud_init(prompts, files)
		else await byo_init(prompts, files)
	} finally {
		prompts.close()
	}
}

async function main(): Promise<void> {
	const command = argv[2]
	if (command === "-V" || command === "--version") return console.log(version())
	if (command === "init") return init()
	if (command === "sync") return sync()
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
