#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { argv, cwd, exit } from "node:process"
import { PROVIDERS, DEFAULT_FIELDS, usage_snippet, type CliProvider } from "./providers.js"
import { detect_env_targets, upsert_env, is_gitignored, type EnvTarget } from "./env.js"
import { detect_hosts, push_spec, manual_hint, HOST_LABEL, type Host } from "./deploy.js"
import { detect_package_manager, has_dependency, install_command } from "./project.js"
import { create_prompts, bold, dim, cyan, green, yellow, red } from "./prompts.js"

const SETTINGS_FILES = [
	"postboi.settings.ts",
	"postboi.settings.mts",
	"postboi.settings.js",
	"postboi.settings.mjs",
]

const SETTINGS_TEMPLATE = `import { defineSettings } from "postboi"

// Project-wide config, picked up automatically by send().
export default defineSettings({
	hooks: {
		// before_send: ({ message }) => { /* mutate the message, or throw to cancel */ },
		// after_send: ({ response }) => { /* log a successful send */ },
		// on_error: ({ error }) => { /* report to Sentry, etc. */ },
	},
})
`

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
${bold("postboi")} ${dim(`v${version()}`)} — email for the rest of us

${bold("Usage")}
  ${cyan("bunx postboi init")}     Configure a provider and write its env vars

${bold("Options")}
  -h, --help        Show this help
  -V, --version     Show the version
`)
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

async function init(): Promise<void> {
	const prompts = create_prompts()
	console.log(`\n${bold(cyan("◆ postboi init"))} ${dim("— let's get you sending")}\n`)

	const files = readdirSync(cwd())

	try {
		// 1. Choose a provider
		const provider = await prompts.select<CliProvider>(
			bold("Which provider?"),
			PROVIDERS.map((p) => ({ label: p.name, value: p }))
		)

		// 2. Collect credentials (POSTBOI_PROVIDER lets the zero-config `send()` find it later)
		console.log(`\n${dim("Get your credentials at")} ${cyan(provider.url)}\n`)
		const values: Record<string, string> = { POSTBOI_PROVIDER: provider.key }
		for (const field of provider.fields) {
			values[field.env] = await prompts.ask(`${field.label} ${dim(`(${field.env})`)}`, {
				required: field.default === undefined,
				default: field.default,
			})
		}

		// 2b. Optional default fields (stored as POSTBOI_* so `send()` picks them up too)
		const default_fields: Array<{ arg: string; env: string }> = []
		if (await prompts.confirm(`\nSet ${bold("default")} from / to / reply-to / cc / bcc?`)) {
			for (const field of DEFAULT_FIELDS) {
				const value = await prompts.ask(`${field.label} ${dim("(optional)")}`)
				if (value) {
					values[field.env] = value
					default_fields.push({ arg: field.arg, env: field.env })
				}
			}
		}

		// 3. Pick env target(s)
		const detected = detect_env_targets(files)
		let targets: Array<EnvTarget>
		if (detected.length === 1) {
			targets = detected
		} else {
			const choice = await prompts.select<EnvTarget | "all">(
				`\n${bold("Write to which env file?")}`,
				[
					...detected.map((t) => ({
						label: t.file,
						value: t as EnvTarget | "all",
						hint: t.format,
					})),
					{ label: "All of them", value: "all" as const },
				]
			)
			targets = choice === "all" ? detected : [choice]
		}

		// 4. Write env vars
		console.log()
		for (const target of targets) {
			let content = existsSync(target.file) ? readFileSync(target.file, "utf8") : ""
			for (const [key, value] of Object.entries(values)) {
				content = upsert_env(content, key, value, target.format)
			}
			writeFileSync(target.file, content)
			console.log(
				`${green("✓")} wrote ${Object.keys(values).length} var(s) to ${bold(target.file)}`
			)
			if (target.note) console.log(`  ${yellow("!")} ${target.note}`)
		}

		// 5. Ensure secrets are gitignored
		const gitignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : ""
		const unignored = targets.map((t) => t.file).filter((file) => !is_gitignored(gitignore, file))
		if (
			unignored.length > 0 &&
			(await prompts.confirm(`\nAdd ${unignored.join(", ")} to .gitignore?`))
		) {
			appendFileSync(".gitignore", `\n${unignored.join("\n")}\n`)
			console.log(`${green("✓")} updated ${bold(".gitignore")}`)
		}

		// 6. Push to a deployment host
		const detected_hosts = detect_hosts(files)
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
					{ label: "Skip", value: "skip" as const },
				]
			)
			if (picked !== "skip") host = picked
		}

		if (host) {
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

		// 7. Make sure postboi itself is installed
		if (existsSync("package.json")) {
			const pkg = JSON.parse(readFileSync("package.json", "utf8"))
			if (!has_dependency(pkg, "postboi")) {
				const pm = detect_package_manager(files, pkg)
				if (await prompts.confirm(`\nInstall ${bold("postboi")} with ${cyan(pm)}?`)) {
					const { cmd, args } = install_command(pm, "postboi")
					const result = run_push({ cmd, args })
					if (result.ok) console.log(`${green("✓")} installed postboi`)
					else
						console.log(`${red("✗")} ${result.reason} — run \`${cmd} ${args.join(" ")}\` yourself`)
				}
			}
		}

		// 7b. Offer a postboi.settings.ts for project-wide hooks (Sentry, redirects, …)
		if (!SETTINGS_FILES.some((f) => existsSync(f))) {
			if (
				await prompts.confirm(
					`\nAdd a ${bold("postboi.settings.ts")} for hooks (error tracking, etc.)?`
				)
			) {
				writeFileSync("postboi.settings.ts", SETTINGS_TEMPLATE)
				console.log(`${green("✓")} wrote ${bold("postboi.settings.ts")}`)
			}
		}

		// 8. Done — show how to use it
		console.log(`\n${green(bold("Done!"))} Now just send — no setup, no instance:\n`)
		console.log(
			dim('import { send } from "postboi"\n\nawait send({ to: "…", subject: "…", body: "…" })') +
				"\n"
		)
		console.log(`${dim("…or construct the provider yourself:")}\n`)
		console.log(dim(usage_snippet(provider, default_fields)) + "\n")
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
	console.error(red(error instanceof Error ? error.message : String(error)))
	exit(1)
})
