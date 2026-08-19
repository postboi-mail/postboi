#!/usr/bin/env node
import {
	readdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	appendFileSync,
	mkdirSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { join, delimiter, dirname } from "node:path"
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
	host_invocation,
	link_args,
	link_state,
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
	find_worker,
	suggest_worker,
	wire_worker,
	page_snippet,
	type WorkerTarget,
} from "./service_worker.js"
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
import { offer_auth_key, verify_apns, key_search_paths } from "./apns.js"
import {
	cloud_base,
	start_device_auth,
	poll_device_auth,
	open_browser,
	fetch_domains,
	fetch_env_vars,
	push_env_vars,
	start_connect,
	poll_connect,
	type ConnectResult,
	type PostboiDomain,
} from "./postboi.js"
import { credential_env_keys } from "../library/registry.js"
import { generate_vapid_keys } from "../library/push/webpush.js"
import {
	write_types,
	write_runtime,
	from_status,
	config_captcha_key,
	upsert_captcha_key,
	TYPES_TARGET,
} from "./typegen.js"
import { fetch_whatsapp_templates } from "./whatsapp_templates.js"
import { offer_skill, refresh_skill, skill_command } from "./skill.js"
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
  ${cyan("bunx postboi sync")}     Pull synced team credentials and refresh the generated from/template types
  ${cyan("bunx postboi env")}      The synced credentials ${dim("· push · pull [--force] · remove <KEY>")}
  ${cyan("bunx postboi vapid")}    Mint a VAPID key pair for Web Push, printed to stdout
  ${cyan("bunx postboi skill")}    Install the agent skill, so AI coding agents know the library
  ${cyan("bunx postboi dev")}      Local inbox for mail sent in development
  ${dim("                          · --port <n> --demo --no-sound --no-intro")}
  ${dim("                          (Vite projects already serve it at /__postboi)")}

${bold("Account")} ${dim("(Postboi provider — full reference: https://api.postboi.app)")}
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
	// Windows spawns through cmd.exe (the host CLIs are .cmd shims), which joins argv with
	// no escaping — a secret with spaces or metacharacters would be split or executed.
	if (platform === "win32" && spec.unsafe_on_windows) {
		return { ok: false, reason: "this value needs quoting cmd.exe can't do safely" }
	}
	const result = spawnSync(spec.cmd, spec.args, {
		input: spec.stdin,
		stdio: [spec.stdin !== undefined ? "pipe" : "inherit", "inherit", "inherit"],
		encoding: "utf8",
		// Windows resolves npx/bunx/vercel through .cmd shims, which need a shell to launch.
		shell: platform === "win32",
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
 *
 * Empty values are dropped: an empty string can be pushed (`postboi env push KEY=`) but
 * is not a usable credential, and treating it as one would silently suppress the prompt
 * *and* the browser connect while writing nothing to the env file.
 */
async function synced_credentials(): Promise<Record<string, string>> {
	await ensure_env_loaded()
	const token = read_env("POSTBOI_TOKEN")
	if (!token) return {}
	const synced = await fetch_env_vars(cloud_base(), token)
	return Object.fromEntries(Object.entries(synced?.vars ?? {}).filter(([, value]) => value !== ""))
}

/**
 * Fill provider fields from the team's synced credentials, announcing each one. The
 * returned map answers prompts via `prefilled[field.env] ?? ask(…)` — one copy of the
 * check, the message, and the routing for every init flow.
 */
function prefill_from_team(
	team: Record<string, string>,
	fields: ReadonlyArray<{ env: string }>
): Record<string, string> {
	const prefilled: Record<string, string> = {}
	for (const field of fields) {
		if (team[field.env] !== undefined) {
			console.log(`${green("✓")} ${bold(field.env)} — using your team's synced credential`)
			prefilled[field.env] = team[field.env]
		}
	}
	return prefilled
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
 * next machine) get them from `postboi sync` with no ceremony. `POSTBOI_*` vars never
 * sync (the token is per developer, and the rest derive from the account already), and
 * values that came *from* the team aren't echoed back up — pass what the team already
 * holds as `already_synced` so a fully-prefilled init makes no request at all.
 */
async function sync_credentials_up(
	values: Record<string, string>,
	already_synced: Record<string, string> = {}
): Promise<void> {
	const syncable = Object.fromEntries(
		Object.entries(values).filter(
			([key, value]) => !key.startsWith("POSTBOI_") && already_synced[key] !== value
		)
	)
	if (Object.keys(syncable).length === 0) return
	await ensure_env_loaded()
	const token = read_env("POSTBOI_TOKEN")
	if (!token) {
		// Say so: the docs promise team sync, and a silent skip reads as a broken promise
		// when a teammate later finds nothing to pull.
		console.log(
			dim("(credentials not synced to a team — no POSTBOI_TOKEN; `bunx postboi init` signs in)")
		)
		return
	}
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

	if (!host) return

	// A missing global install is not a dead end: the project's package runner fetches
	// the host CLI on demand (bunx/npx/pnpm dlx), at the cost of a slower first run.
	const invocation = host_invocation(host, detect_package_manager(files), is_on_path)
	if (invocation.via_runner) {
		console.log(
			dim(
				`\n(${HOST_CLI[host]} isn't installed — running it via ${[invocation.cmd, ...invocation.prefix].join(" ")})`
			)
		)
	}

	// Pushing into the void helps nobody: an unlinked project fails on every var with the
	// host's own error. Offer the link first, interactively — it's the host CLI's own
	// prompt flow — then push.
	const state = link_state(host, files, existsSync)
	if (state === "unlinked") {
		const link = link_args(host)
		if (!link) {
			// Cloudflare's "link" is the config file: secrets push to the Worker it names.
			console.log(
				`\n${yellow("!")} no wrangler config found — add wrangler.jsonc (with your Worker's \`name\`), then run:`
			)
			for (const key of Object.keys(values)) console.log(`    ${manual_hint(host, key)}`)
			return
		}
		if (
			!(await prompts.confirm(
				`\nThis directory isn't linked to a ${HOST_LABEL[host]} project yet — link it now?`
			))
		) {
			console.log(`  ${dim(`link later (${HOST_CLI[host]} ${link.join(" ")}), then run:`)}`)
			for (const key of Object.keys(values)) console.log(`    ${manual_hint(host, key)}`)
			return
		}
		const linked = run_push({ cmd: invocation.cmd, args: [...invocation.prefix, ...link] })
		if (!linked.ok) {
			console.log(`${red("✗")} linking failed — ${linked.reason}`)
			console.log(`  ${dim("link by hand, then run:")}`)
			for (const key of Object.keys(values)) console.log(`    ${manual_hint(host, key)}`)
			return
		}
	}

	console.log(`\n${dim(`Pushing to ${HOST_LABEL[host]}…`)}`)
	for (const [key, value] of Object.entries(values)) {
		const result = run_push(push_spec(invocation, host, key, value))
		if (result.ok) {
			console.log(`${green("✓")} ${key}`)
		} else {
			console.log(`${red("✗")} ${key} — ${result.reason}`)
			if (host === "railway") {
				// Railway's link state lives in its global config, so this is the first
				// place an unlinked project surfaces.
				console.log(`  ${dim(`not linked? run \`${HOST_CLI.railway} link\` first`)}`)
			}
			console.log(`  ${dim("run it yourself:")} ${manual_hint(host, key)}`)
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
	// Templates come from Meta or Twilio, not from Postboi, so this runs with or without a
	// token — and starting it first lets it overlap whatever account requests follow.
	const templates_promise = fetch_whatsapp_templates()
	const bake = async (key: string | undefined, source: string) => {
		const { sids } = await templates_promise
		// The VAPID public key rides along from local env — public by definition, and
		// baking it is what lets subscribe() and the push toggle need no key at all.
		const vapid = read_env("VAPID_PUBLIC_KEY")
		if (write_runtime(key, sids, vapid)) {
			console.log(`${green("✓")} captcha key baked for <Captcha /> ${dim(`(from ${source})`)}`)
			if (vapid) console.log(`${green("✓")} VAPID public key baked — subscribe() needs no key`)
		}
	}
	/** Say what got typed, once, however sync got here. */
	const report_templates = (names: Array<string>) => {
		if (names.length === 0) return
		console.log(
			`${green("✓")} typed ${bold("template")} to your ${names.length} WhatsApp template(s) ${dim(`(${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})`)}`
		)
	}

	const token = read_env("POSTBOI_TOKEN")
	if (!token) {
		await bake(config_key, config_file ?? "config")
		const { names, variables } = await templates_promise
		if (write_types(undefined, [], names, variables)) report_templates(names)
		console.log(dim("postboi sync: no POSTBOI_TOKEN — skipping the generated from types."))
		return
	}
	// The two GETs are independent, and sync runs as the project's predev hook — start the
	// env-vars fetch now so the network round trips overlap instead of stacking.
	const vars_promise = fetch_env_vars(cloud_base(), token)
	const account = await fetch_domains(cloud_base(), token)
	if (!account) {
		await bake(config_key, config_file ?? "config")
		const { names, variables } = await templates_promise
		if (write_types(undefined, [], names, variables)) report_templates(names)
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
	const synced = await vars_promise
	if (synced && Object.keys(synced.vars).length > 0) {
		const written = write_pulled_vars(synced.vars)
		if (written.length > 0) {
			console.log(
				`${green("✓")} pulled ${written.length} synced credential(s): ${bold(written.join(", "))}`
			)
		}
	}

	const captcha_key = account.captcha_key ?? config_key
	await bake(captcha_key, account.captcha_key ? "the Postboi provider" : (config_file ?? "config"))
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

	const { names, variables } = await templates_promise
	const file = write_types(
		account.send_address ?? read_env("POSTBOI_FROM"),
		account.domains,
		names,
		variables
	)
	if (!file) {
		console.log(dim("postboi sync: no sending addresses on this account yet."))
		return
	}
	console.log(`${green("✓")} wrote ${bold(file)}`)
	report_templates(names)
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
	if (write_runtime(cloud_account?.captcha_key, {}, read_env("VAPID_PUBLIC_KEY"))) {
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

/**
 * Ask for a provider's credential fields, a team-synced value answering its own prompt.
 * Secrets route to the env file, everything else to the committed config — one copy of
 * the loop for every init flow.
 */
async function collect_credentials(
	prompts: Prompts,
	fields: ReadonlyArray<{
		env: string
		arg: string
		label: string
		secret?: boolean
		default?: string
	}>,
	prefilled: Record<string, string>
): Promise<{
	values: Record<string, string>
	config_options: Record<string, string>
	args: Record<string, string>
}> {
	const values: Record<string, string> = {} // secrets → env file
	const config_options: Record<string, string> = {} // non-secrets → config file
	// The same answers keyed by constructor argument, secret or not — what you'd need to
	// build the provider, which is exactly what a `verify` hook wants and neither of the
	// other two maps can give it alone.
	const args: Record<string, string> = {}
	for (const field of fields) {
		const value =
			prefilled[field.env] ??
			(await prompts.ask(`${field.label} ${dim(`(${field.env})`)}`, {
				required: field.default === undefined,
				default: field.default,
			}))
		if (value) args[field.arg] = value
		if (field.secret) {
			// Optional secrets (default "") left blank are omitted, not written empty.
			if (value) values[field.env] = value
		} else if (value) config_options[field.arg] = value
	}
	return { values, config_options, args }
}

/**
 * The persistence epilogue every init flow shares: write the env file(s), offer to
 * gitignore them and push to a host, and sync anything newly typed up to the team.
 */
async function persist_credentials(
	prompts: Prompts,
	files: Array<string>,
	values: Record<string, string>,
	team: Record<string, string>
): Promise<void> {
	const targets = await choose_env_targets(prompts, files)
	write_env_values(targets, values)
	await offer_gitignore(prompts, targets)
	await offer_host_push(prompts, files, values)
	await sync_credentials_up(values, team)
}

/** Bring-your-own-provider onboarding: pick a provider, collect creds, write config. */
async function byo_init(prompts: Prompts, files: Array<string>): Promise<void> {
	// The team-credentials fetch doesn't depend on the pick, so it overlaps think-time.
	const team_promise = synced_credentials()

	// 1. Choose a provider
	const provider = await prompts.select<CliProvider>(
		bold("Which provider?"),
		PROVIDERS.map((p) => ({ label: p.name, value: p }))
	)

	// 2. Collect credentials. Secrets go to the env file; everything non-secret is committed
	// to postboi.config.ts — so the best case is a single env var (the API key). A value
	// the team already synced answers its prompt: type it once, on one machine, ever.
	const team = await team_promise
	console.log(`\n${dim("Get your credentials at")} ${cyan(provider.url)}\n`)
	const prefilled = prefill_from_team(team, provider.fields)
	const { values, config_options } = await collect_credentials(prompts, provider.fields, prefilled)

	// 2b. Optional default fields (committed to config, not env)
	const config_defaults = await ask_defaults(prompts)

	// 3–6. Write env vars, gitignore them, offer a host push, sync new values up
	await persist_credentials(prompts, files, values, team)

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

/** The shape `channel_init` needs from any channel registry. */
type ChannelProvider = {
	key: string
	name: string
	url: string
	note: string
	connect?: { env: string }
	fields: ReadonlyArray<{
		env: string
		arg: string
		label: string
		secret?: boolean
		default?: string
	}>
}

/**
 * Run the browser OAuth connect for a provider with a registered app: open the consent
 * screen, wait for the created webhook to ride back on the one-time code. Undefined on
 * any failure — the caller's paste prompt is always the fallback.
 */
async function browser_connect(provider: ChannelProvider): Promise<ConnectResult | undefined> {
	const start = await start_connect(cloud_base(), provider.key)
	if (!start) return undefined
	console.log(`\n${bold(`Pick a channel in ${provider.name}:`)}\n`)
	console.log(`  ${cyan(start.url)}\n`)
	if (open_browser(start.url)) console.log(dim("  (opening in your default browser)"))
	console.log(dim("\nWaiting for the browser…"))
	return poll_connect(cloud_base(), start)
}

/**
 * What makes one channel's init its own: the registry, the picker prompt, the channel
 * defaults worth asking for, and the done-snippet — plus two optional hooks for the
 * channels that need them: `choose` (SMS ranks its provider list by destination before
 * picking) and `mint` (Web Push generates its own VAPID credential). A compile-checked
 * map instead of per-call ternary chains, so a new channel can't silently fall through
 * to another channel's branch — and provider-key matching (the "twilio" key exists in
 * two registries) stays inside the channel that owns it.
 */
type InitSpec = {
	registry: ReadonlyArray<ChannelProvider>
	picker: string
	/**
	 * Channel-specific provider selection replacing the flat picker. Returns the pick plus
	 * any config defaults learned on the way (the SMS destination country).
	 */
	choose?: (
		prompts: Prompts
	) => Promise<{ provider: ChannelProvider; seeded: Record<string, string> }>
	/**
	 * Self-minted credentials, filled into `prefilled` before the prompts run — a
	 * capability the channel declares, not a provider-key branch in the shared flow.
	 */
	mint?: (
		prompts: Prompts,
		provider: ChannelProvider,
		prefilled: Record<string, string>
	) => Promise<void>
	/**
	 * Check the collected credentials actually work, before they're written anywhere.
	 * Returns a sentence to show when something is wrong, undefined when it's fine —
	 * declared by the channel, like `mint`, rather than branching the shared flow.
	 */
	verify?: (provider: ChannelProvider, args: Record<string, string>) => Promise<string | undefined>
	defaults: (
		prompts: Prompts,
		provider: ChannelProvider,
		seeded: Record<string, string>
	) => Promise<Record<string, string>>
	done: (provider: ChannelProvider) => Array<string>
}

const CHANNEL_INIT = {
	sms: {
		registry: SMS_PROVIDERS as ReadonlyArray<ChannelProvider>,
		picker: "Which provider?",
		// Unlike the other channels, the right SMS provider depends on **where you're
		// sending** — UK-native providers are materially cheaper into the UK and useless
		// elsewhere — so ask for a destination first and order the list by it. The pick
		// doubles as the default country used to resolve national numbers.
		async choose(prompts: Prompts) {
			const country = await prompts.select<string>(bold("Where are you sending?"), [
				...SMS_COUNTRIES,
				{ label: "Somewhere else / several countries", value: "" },
			])
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
			const seeded: Record<string, string> = country ? { country } : {}
			return { provider: provider as ChannelProvider, seeded }
		},
		// The country arrives seeded from choose(), so it's usually just Enter here.
		async defaults(prompts: Prompts, _provider: ChannelProvider, seeded: Record<string, string>) {
			const config_defaults: Record<string, string> = { ...seeded }
			for (const field of SMS_DEFAULT_FIELDS) {
				if (field.arg === "country" && seeded.country) continue
				const value = await prompts.ask(
					`\n${field.label} ${dim("(optional)")}\n${dim(field.hint ?? "")}`,
					{ required: false }
				)
				if (value) config_defaults[field.arg] = value
			}
			return config_defaults
		},
		done: () => [
			'import { sms } from "postboi"\n\nawait sms({ to: "+447788223344", message: "…" })',
			// Worth saying out loud: the safe default surprises people who expect a real send.
			"In development texts are logged, not sent — set POSTBOI_SMS_DEV=send when you want real delivery.",
		],
	},
	chat: {
		registry: CHAT_PROVIDERS as ReadonlyArray<ChannelProvider>,
		picker: "Which chat platform?",
		// Only Telegram has a default worth asking for: its destination is a chat id you
		// can't know until the bot hears from the user, where the webhook providers carry
		// the destination inside the (secret) URL.
		async defaults(prompts: Prompts, provider: ChannelProvider): Promise<Record<string, string>> {
			if (provider.key !== "telegram") return {}
			const chat_id = await prompts.ask(
				`\nDefault chat id ${dim("(optional — the id your bot should post to)")}`,
				{ required: false }
			)
			return chat_id ? { to: chat_id } : {}
		},
		// The public surface is the platform function, so the snippet names the one just
		// configured — there is no generic chat() import.
		done: (provider: ChannelProvider) => [
			`import { ${provider.key} } from "postboi"\n\nawait ${provider.key}({ message: "Deploy finished" })`,
		],
	},
	push: {
		registry: PUSH_PROVIDERS as ReadonlyArray<ChannelProvider>,
		picker: "Which push service?",
		// Web Push's "credential" is a VAPID key pair you mint yourself — no dashboard
		// hands one out, so mint it here rather than dead-ending the prompt on keys nobody
		// has. Gated on the private key: when the team's synced pair covers it, a second
		// pair would orphan every subscription collected under the first (both halves sync —
		// the public key is env-routed in the registry for exactly this reason).
		async mint(prompts: Prompts, provider: ChannelProvider, prefilled: Record<string, string>) {
			if (provider.key === "apns")
				return offer_auth_key(prompts, prefilled, key_search_paths(cwd()))
			if (provider.key !== "webpush" || prefilled.VAPID_PRIVATE_KEY !== undefined) return
			if (!(await prompts.confirm("Generate a fresh VAPID key pair?"))) return
			const pair = await generate_vapid_keys()
			prefilled.VAPID_PUBLIC_KEY = pair.public_key
			prefilled.VAPID_PRIVATE_KEY = pair.private_key
			console.log(
				`${green("✓")} generated — the public key also goes to the browser's \`subscribe({ key })\`:\n  ${dim(pair.public_key)}\n`
			)
		},
		// APNs is the only provider here whose credentials can be checked without a real
		// device, and the only one where a wrong answer is otherwise invisible until a
		// notification silently fails to arrive.
		async verify(provider: ChannelProvider, args: Record<string, string>) {
			if (provider.key !== "apns") return undefined
			console.log(dim("\nChecking the credentials with APNs…"))
			const problem = await verify_apns(args)
			if (!problem) console.log(`${green("✓")} APNs accepted the key, team and bundle ID`)
			return problem
		},
		async defaults(): Promise<Record<string, string>> {
			// A push target is per-device, so there is no global default worth committing.
			return {}
		},
		done: () => [
			'import { push } from "postboi"\n\nawait push({ to: subscription, message: "…" })',
			// The half people forget: a push target has to be registered before it exists.
			"Subscribe in the browser with `subscribe()` from postboi/push first.",
		],
	},
	whatsapp: {
		registry: WHATSAPP_PROVIDERS as ReadonlyArray<ChannelProvider>,
		picker: "WhatsApp via which provider?",
		async defaults(prompts: Prompts, provider: ChannelProvider): Promise<Record<string, string>> {
			const defaults: Record<string, string> = {}
			// Twilio addresses the sender by number; Meta's sender is the phone_number_id
			// already collected with the credentials, so `from` would be dead config there.
			if (provider.key === "twilio") {
				const from = await prompts.ask(
					`\nSender number ${dim("(optional — your WhatsApp-enabled number, e.g. +14155238886)")}`,
					{ required: false }
				)
				if (from) defaults.from = from
			}
			const country = await prompts.ask(
				`\nDefault country ${dim('(optional — resolves national numbers; an ISO code like "GB")')}`,
				{ required: false }
			)
			if (country) defaults.country = country
			return defaults
		},
		done: () => [
			'import { whatsapp } from "postboi"\n\nawait whatsapp({ to: "+447788223344", template: "…", variables: { name: "Ada" } })',
			// The constraint that shapes everything: free-form only works in-window.
			"Free-form `message` only delivers within 24h of the user's last reply — templates deliver anytime.\nIn development messages are logged, not sent — set POSTBOI_WHATSAPP_DEV=send for real delivery.",
		],
	},
} satisfies Record<"sms" | "chat" | "push" | "whatsapp", InitSpec>

/**
 * Channel onboarding — SMS, chat, push and WhatsApp all run this one skeleton, so a fix
 * to any shared step (team prefill, browser connect, host push, credential sync) reaches
 * every channel. What differs per channel lives in its {@link InitSpec} entry.
 */
/**
 * Offer to wire up the service worker — the half of Web Push that can't live on the page.
 *
 * `pushsubscriptionchange` fires nowhere but inside a worker, so a project without one
 * misses a notification every time a browser rotates a subscription. The file is found
 * where the framework keeps it, or created where the framework expects it, and the
 * handlers go in the shape that file can actually run: an import where a bundler builds
 * it, written out where it's served verbatim.
 */
async function offer_service_worker(
	prompts: Prompts,
	files: Array<string>,
	key: string | undefined
): Promise<void> {
	let pkg: PackageJson | undefined
	try {
		pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson
	} catch {
		// No package.json, or an unreadable one — the suggestion falls back to the shape
		// that runs anywhere, which is the right answer when we know nothing.
	}

	const found = find_worker(existsSync)
	const target: WorkerTarget = found ?? suggest_worker(files, pkg, existsSync)

	console.log(
		`\n${dim("Subscriptions expire and browsers rotate them. Only a service worker hears about it.")}`
	)
	const question = found
		? `${bold("Wire push into")} ${cyan(found.path)}?`
		: `${bold("Create")} ${cyan(target.path)} ${bold("to receive notifications?")}`
	if (!(await prompts.confirm(question))) {
		console.log(dim("  skipped — `receive()` from postboi/push/sw does it in one line."))
		return
	}

	const register = await prompts.ask("  Endpoint a subscription is filed at", {
		default: "/push/subscriptions",
	})

	const result = wire_worker(target, found ? readFileSync(found.path, "utf8") : undefined, {
		register,
		key,
	})

	if (result === "present") {
		console.log(`${green("✓")} ${bold(target.path)} already routes push through postboi`)
	} else if (result === "conflict") {
		// Appending would leave two `push` handlers, and every send would show twice.
		console.log(
			`${yellow("!")} ${bold(target.path)} already handles \`push\` itself — two handlers would show two notifications for one send.`
		)
		console.log(dim("  Merge it by hand, or delete yours and run this again."))
		return
	} else {
		mkdirSync(dirname(target.path), { recursive: true })
		writeFileSync(target.path, result.source)
		const how =
			target.kind === "bundled"
				? dim(" (imports postboi/push/sw — your bundler builds it)")
				: dim(" (handlers written out — this file is served as-is and can't import)")
		console.log(`${green("✓")} ${result.action} ${bold(target.path)}${how}`)
	}

	// The worker is only half of it: the page still has to subscribe, and `subscribe()`
	// looks for /sw.js unless told otherwise — the most common way a fully wired setup
	// still fails with `no_service_worker`.
	console.log(dim("\n  On the page:"))
	console.log(`    ${cyan(page_snippet(target, register))}`)
}

async function channel_init(
	prompts: Prompts,
	files: Array<string>,
	channel: "sms" | "chat" | "push" | "whatsapp"
): Promise<void> {
	// The team-credentials fetch doesn't depend on the pick, so it overlaps think-time.
	const team_promise = synced_credentials()

	// The registries are separate const-narrowed tuples; the map widens each to the shared
	// shape, which carries every field used here.
	const spec: InitSpec = CHANNEL_INIT[channel]
	const { provider, seeded } = spec.choose
		? await spec.choose(prompts)
		: {
				provider: await prompts.select<ChannelProvider>(
					bold(spec.picker),
					spec.registry.map((p) => ({ label: p.name, value: p, hint: p.note }))
				),
				seeded: {} as Record<string, string>,
			}

	const team = await team_promise
	console.log(`\n${dim("Get your credentials at")} ${cyan(provider.url)}\n`)
	// Values the team already synced answer their prompts — type it once, on one machine.
	const prefilled = prefill_from_team(team, provider.fields)

	// Providers with a registered OAuth app (`connect` in the registry) don't need their
	// webhook found and pasted at all: the browser opens the provider's consent screen,
	// the user picks a channel there, and the created webhook URL comes back on a
	// one-time code. Skipped when the team already synced one; every failure (older API,
	// offline, consent denied, tab closed) falls back to the paste prompt.
	if (provider.connect && prefilled[provider.connect.env] === undefined) {
		const method = await prompts.select<"connect" | "paste">(bold(`Set up ${provider.name}?`), [
			{
				label: "Connect in the browser",
				value: "connect",
				hint: "pick a channel there — nothing to find or paste",
			},
			{ label: "Paste a webhook URL", value: "paste" },
		])
		if (method === "connect") {
			const connected = await browser_connect(provider)
			if (connected) {
				prefilled[provider.connect.env] = connected.webhook_url
				console.log(
					`${green("✓")} connected${connected.label ? ` — posting to ${bold(connected.label)}` : ""}`
				)
			} else {
				console.log(
					yellow("! the browser connect didn't complete — paste the webhook URL instead.")
				)
			}
		}
	}

	// Self-minted credentials (Web Push's VAPID pair) — the channel's own hook.
	await spec.mint?.(prompts, provider, prefilled)
	const { values, config_options, args } = await collect_credentials(
		prompts,
		provider.fields,
		prefilled
	)

	// Check before anything is written: a credential that fails here would otherwise fail
	// as a notification that silently never arrives, days later. Not fatal on its own —
	// the check itself can fail for reasons that say nothing about the credentials — so
	// the decision to keep them is the user's.
	const problem = await spec.verify?.(provider, args)
	if (problem) {
		console.log(`${yellow("!")} ${problem}`)
		if (!(await prompts.confirm("Save them anyway?"))) {
			console.log(dim("\nNothing written. Fix the details and run init again."))
			return
		}
	}

	// Channel defaults, committed to the config's `default:` block — asked by the
	// channel's own spec, so provider-key matching lives with the channel that owns it.
	const config_defaults = await spec.defaults(prompts, provider, seeded)

	await persist_credentials(prompts, files, values, team)

	ensure_install(files)
	write_channel_config(channel, provider.key, config_defaults, config_options)
	if (channel === "whatsapp") await type_templates(provider, { ...config_options, ...values })

	// A fresh VAPID pair was just minted (or supplied) — bake the public half so the
	// browser side needs no key plumbing from the first subscribe.
	if (channel === "push" && values.VAPID_PUBLIC_KEY && existsSync(TYPES_TARGET)) {
		if (write_runtime(undefined, {}, values.VAPID_PUBLIC_KEY)) {
			console.log(`${green("✓")} VAPID public key baked — subscribe() needs no key`)
			ensure_prepare()
		}
	}

	// Web Push only: FCM, APNs and HMS deliver to a native app, which has no service worker
	// and none of this to wire.
	if (channel === "push" && provider.key === "webpush") {
		await offer_service_worker(prompts, files, values.VAPID_PUBLIC_KEY)
	}

	console.log(`\n${green(bold("Done!"))}\n`)
	for (const line of spec.done(provider)) console.log(dim(line) + "\n")
}

/**
 * Type `template` to the account's approved templates the moment WhatsApp is set up, so
 * the first send already autocompletes rather than waiting for a `sync` the user has no
 * reason to run yet. The credentials only exist in the files just written, so they go into
 * this process's env — the same place a real send would read them from.
 */
async function type_templates(
	provider: ChannelProvider,
	collected: Record<string, string>
): Promise<void> {
	if (!existsSync(TYPES_TARGET)) return
	env.POSTBOI_WHATSAPP_PROVIDER = provider.key
	for (const field of provider.fields) {
		const value = collected[field.env] ?? collected[field.arg]
		if (value) env[field.env] = value
	}
	const { names, variables, sids } = await fetch_whatsapp_templates()
	if (names.length === 0) return
	// Both writers carry forward what this run has no opinion on — the account's `from`
	// union and its baked captcha key, neither of which a channel init knows anything about.
	write_types(undefined, [], names, variables)
	write_runtime(undefined, sids)
	console.log(
		`${green("✓")} typed ${bold("template")} to your ${names.length} approved template(s)`
	)
	ensure_prepare()
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
		else if (mode === "sms" || mode === "chat" || mode === "push" || mode === "whatsapp")
			await channel_init(prompts, files, mode)
		else await byo_init(prompts, files)
	} finally {
		prompts.close()
	}
}

/**
 * Mint a *new* VAPID pair, print it and stop. Named for the credential rather than the
 * generic "keys": next to `postboi env`, which pulls the team's synced secrets, a `keys`
 * command reads like it dumps them — this one reads nothing and generates one credential.
 *
 * `init --push` writes a `.env`, which is the wrong shape when the pair belongs to a
 * Worker, a CI secret store or a password manager — this prints it and lets you put it
 * wherever it goes.
 *
 * Both halves at once, deliberately: they are one key pair, so two invocations piped
 * separately into `wrangler secret put` would install halves of two different pairs and
 * fail on every send with a 401.
 */
async function vapid_command(): Promise<void> {
	const { public_key, private_key } = await generate_vapid_keys()
	console.log(`VAPID_PUBLIC_KEY=${public_key}`)
	console.log(`VAPID_PRIVATE_KEY=${private_key}`)
	console.log(
		dim(
			"\n# The public key also goes to the browser's `subscribe({ key })`." +
				"\n# Keep the pair: every subscription is bound to the key it subscribed with."
		)
	)
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
	if (command === "skill") {
		if (!skill_command()) exit(1)
		return
	}
	if (command === "vapid") return vapid_command()
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
