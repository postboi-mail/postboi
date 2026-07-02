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
import { detect_env_targets, upsert_env, is_gitignored, type EnvTarget } from "./env.js"
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
import { cloud_base, start_device_auth, poll_device_auth, open_browser } from "./cloud.js"

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
  ${cyan("bunx postboi init")}     Set up Postboi Cloud or a provider of your own

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

/** Upsert each `KEY=value` into every target env file. */
function write_env_values(targets: Array<EnvTarget>, values: Record<string, string>): void {
	console.log()
	for (const target of targets) {
		let content = existsSync(target.file) ? readFileSync(target.file, "utf8") : ""
		for (const [key, value] of Object.entries(values)) {
			content = upsert_env(content, key, value, target.format)
		}
		writeFileSync(target.file, content)
		console.log(`${green("✓")} wrote ${Object.keys(values).length} var(s) to ${bold(target.file)}`)
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

/** Make sure postboi itself is installed in the project. */
async function offer_install(prompts: Prompts, files: Array<string>): Promise<void> {
	if (!existsSync("package.json")) return
	const pkg = JSON.parse(readFileSync("package.json", "utf8"))
	if (has_dependency(pkg, "postboi")) return
	const pm = detect_package_manager(files, pkg)
	const dev = is_bundled_framework(files, pkg)
	const hint = dev ? ` ${dim("(as a devDependency — bundled at build time)")}` : ""
	if (await prompts.confirm(`\nInstall ${bold("postboi")} with ${cyan(pm)}?${hint}`)) {
		const { cmd, args } = install_command(pm, "postboi", dev)
		const result = run_push({ cmd, args })
		if (result.ok) console.log(`${green("✓")} installed postboi`)
		else console.log(`${red("✗")} ${result.reason} — run \`${cmd} ${args.join(" ")}\` yourself`)
	}
}

/**
 * Postboi Cloud onboarding: authorise this device in the browser, then write the
 * resulting `POSTBOI_TOKEN`. No provider account, no DNS, no config file.
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

	// POSTBOI_FROM is a convenience default — the API also falls back to the account's
	// sending address when `from` is omitted, so the token alone is enough.
	const values: Record<string, string> = { POSTBOI_TOKEN: token }
	if (send_address) values.POSTBOI_FROM = send_address
	const targets = await choose_env_targets(prompts, files)
	write_env_values(targets, values)
	await offer_gitignore(prompts, targets)
	await offer_host_push(prompts, files, values)
	await offer_install(prompts, files)

	console.log(`\n${green(bold("Done!"))} No config file needed — just send:\n`)
	console.log(
		dim('import { mail } from "postboi"\n\nawait mail({ to: "…", subject: "…", body: "…" })') + "\n"
	)
	const from_note = send_address
		? `Emails send from ${send_address}`
		: "Emails send from your account's send.postboi.email address"
	console.log(
		dim(
			`${from_note} — set reply_to to receive replies. Verify a domain in the dashboard to send from your own.`
		) + "\n"
	)
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
		if (field.secret) values[field.env] = value
		else if (value) config_options[field.arg] = value
	}

	// 2b. Optional default fields (committed to config, not env)
	const config_defaults: Record<string, string> = {}
	if (await prompts.confirm(`\nSet ${bold("default")} from / to / reply-to / cc / bcc?`)) {
		for (const field of DEFAULT_FIELDS) {
			const value = await prompts.ask(`${field.label} ${dim("(optional)")}`)
			if (value) config_defaults[field.arg] = value
		}
	}

	// 3–6. Write env vars, gitignore them, offer a host push
	const targets = await choose_env_targets(prompts, files)
	write_env_values(targets, values)
	await offer_gitignore(prompts, targets)
	await offer_host_push(prompts, files, values)

	// 7. Make sure postboi itself is installed
	await offer_install(prompts, files)

	// 7b. Write postboi.config.ts — the committed home for provider + non-secret config.
	console.log()
	const config_source = render_config(provider.key, config_defaults, config_options)
	const existing_config = CONFIG_FILES.find((f) => existsSync(f))
	if (existing_config) {
		// Don't clobber a hand-edited file — show what to merge in instead.
		console.log(`${yellow("!")} ${bold(existing_config)} already exists — add to it:`)
		console.log(dim(`\n  provider: ${JSON.stringify(provider.key)},`))
		if (Object.keys(config_defaults).length)
			console.log(dim(`  ${render_block("default", config_defaults, "  ").trimEnd()}`))
		if (Object.keys(config_options).length)
			console.log(dim(`  ${render_block("options", config_options, "  ").trimEnd()}`))
	} else {
		writeFileSync("postboi.config.ts", config_source)
		console.log(`${green("✓")} wrote ${bold("postboi.config.ts")}`)
	}

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
				label: "Postboi Cloud",
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
