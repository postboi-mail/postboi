import { bold, cyan, dim } from "./prompts.js"

/**
 * The CLI's help as data, rendered two ways: coloured for the terminal (`--help`) and as
 * Markdown for the docs site (`scripts/cli-docs.ts` → `/raw/cli`). One list, so the page
 * cannot say something the binary doesn't.
 */

export interface HelpEntry {
	command: string
	summary: string
	/** Sub-commands, flags, notes — one line each. */
	details?: Array<string>
}

export interface HelpSection {
	title: string
	note?: string
	entries: Array<HelpEntry>
	/** Lines after the entries, for the section as a whole. */
	footer?: Array<string>
}

export const HELP: Array<HelpSection> = [
	{
		title: "Usage",
		entries: [
			{
				command: "init",
				summary: "Set up the Postboi provider or a provider of your own",
				details: [
					"--agent: zero prompts, zero sign-in — provisions a claimable sandbox account (made for AI coding agents and CI)",
					"--sms · --whatsapp · --push · --chat: set up that channel instead",
				],
			},
			{
				command: "sync",
				summary: "Pull synced team credentials and refresh the generated from/template types",
			},
			{
				command: "env",
				summary: "The synced credentials",
				details: ["push · pull [--force] · remove <KEY>"],
			},
			{ command: "vapid", summary: "Mint a VAPID key pair for Web Push, printed to stdout" },
			{
				command: "doctor",
				summary: "Is this project wired? Token, provider, from address, webhooks, skill",
				details: ["--json · exit 1 on a failure"],
			},
			{
				command: "skill",
				summary: "Install the agent skill, so AI coding agents know the library",
			},
			{
				command: "dev",
				summary: "Local inbox for mail sent in development",
				details: [
					"--port <n> --demo --no-sound --no-intro",
					"(Vite projects already serve it at /__postboi)",
				],
			},
			{
				command: "inspect",
				summary: "Lint an email's HTML — client compatibility, clipping, dead links",
				details: ["<file.html> · --links --subject <s> --json (exit 1 on warnings)"],
			},
		],
	},
	{
		title: "Account",
		note: "Postboi provider — full reference: https://api.postboi.app",
		entries: [
			{ command: "whoami", summary: "The account behind your token" },
			{
				command: "send",
				summary: "One email, now",
				details: [
					"--to <emails> --subject <s> --text <t>, --html <h> or --file <body> [--at <ISO>]",
				],
			},
			{
				command: "send-address",
				summary: "Default sending address",
				details: ["[name@yourdomain.com]"],
			},
			{
				command: "lists",
				summary: "Lists",
				details: [
					"add <name> · send <list> --subject <s> --text, --html or --file <body> · delete <ref>",
				],
			},
			{
				command: "recipients",
				summary: "A list's recipients",
				details: ["<list> add <email>… · <list> remove <email>"],
			},
			{
				command: "contacts",
				summary: "The audience",
				details: ["add <email> [--name --phone --data] · <email> · remove <email>"],
			},
			{
				command: "domains",
				summary: "Sending domains",
				details: ["add <domain> · check <ref> · inbound <domain> [--off] · delete <ref>"],
			},
			{
				command: "webhooks",
				summary: "Webhooks",
				details: ["add <url> · rotate <id> · deliveries <id> · delete <id>"],
			},
			{
				command: "members",
				summary: "Members",
				details: ["invite <email> · remove <ref> · revoke <ref>"],
			},
			{
				command: "messages",
				summary: "Recent messages",
				details: ["[status] · <id> (status, opens, fields) · cancel <id>"],
			},
			{
				command: "exports",
				summary: "Exports",
				details: [
					"download [--form <form>] [--xlsx] [--out <file>]",
					"add <name> --to <emails> --weekly · run · pause · resume · delete <id>",
				],
			},
			{
				command: "suppressions",
				summary: "Suppressed addresses",
				details: ["add <email or +phone> · remove <email or +phone>"],
			},
			{
				command: "forms",
				summary: "The forms submissions are filed under",
				details: ["(named in your code)"],
			},
			{
				command: "notifications",
				summary: "A list's digests",
				details: ["<list> · <list> add --to <emails> --weekly or --on-signup · <list> delete <id>"],
			},
			{
				command: "testing",
				summary: "Email tests",
				details: ["add [--label] [--clients] · <id> (the report) · clients · delete <id>"],
			},
		],
		footer: [
			"A bare noun lists; `list` says the same. Add --json to any of",
			"them for the API's response as JSON (errors carry the API's code).",
		],
	},
	{
		title: "Temp inboxes",
		note: "tempboi.email, no account or POSTBOI_TOKEN needed",
		entries: [
			{
				command: "inbox",
				summary: "Make a throwaway inbox and print its address",
				details: [
					"new [--name <n>] [--ttl 2h] [--json] [--env]",
					"--env prints export POSTBOI_INBOX=… POSTBOI_INBOX_TOKEN=… for eval",
				],
			},
			{
				command: "inbox watch",
				summary: "Print mail as it arrives, one line each",
				details: [
					"[address] --all --json (NDJSON) --tag <t> --from <s> --subject <s>",
					"--forward <url>: POST each as an email.received webhook, signed with POSTBOI_WEBHOOK_SECRET when set",
					"--exec <cmd>: run per mail with SUBJECT FROM TO CODE LINK ID set and the mail's JSON on stdin",
				],
			},
			{
				command: "inbox wait",
				summary: "Wait for one mail, then exit",
				details: [
					"[address] --from <s> --subject <s> --tag <t> (/regex/ works) --timeout <sec> --new",
					"--code or --link prints only that (exit 3 if absent) · --json · exit 2 on timeout",
				],
			},
			{
				command: "inbox read",
				summary: "One mail in full",
				details: ["[id or latest] --html --raw --headers --json"],
			},
			{ command: "inbox open", summary: "The inbox's web page, in your browser" },
			{
				command: "inbox ls",
				summary: "Inboxes made on this machine",
				details: ["rm [address] · extend <ttl> [address]"],
			},
		],
		footer: [
			"The inbox made or used last is the default; POSTBOI_INBOX and",
			"POSTBOI_INBOX_TOKEN override it, POSTBOI_INBOX_URL moves the host.",
		],
	},
	{
		title: "Options",
		entries: [
			{ command: "-h, --help", summary: "Show this help" },
			{ command: "-V, --version", summary: "Show the version" },
		],
	},
]

const COLUMN = 31

/** `--help`: the sections with the commands in cyan, the details dimmed. */
export function help_text(): string {
	const out: Array<string> = []
	for (const section of HELP) {
		out.push(`${bold(section.title)}${section.note ? ` ${dim(`(${section.note})`)}` : ""}`)
		for (const entry of section.entries) {
			const name = section.title === "Options" ? entry.command : `bunx postboi ${entry.command}`
			const pad = " ".repeat(Math.max(1, COLUMN - name.length))
			out.push(`  ${section.title === "Options" ? name : cyan(name)}${pad}${entry.summary}`)
			for (const line of entry.details ?? []) {
				out.push(`  ${" ".repeat(COLUMN)}${dim(`· ${line}`)}`)
			}
		}
		for (const line of section.footer ?? []) out.push(`  ${" ".repeat(COLUMN)}${dim(line)}`)
		out.push("")
	}
	return out.join("\n")
}

/** The docs page body: one section per group, a table of command and what it does. */
export function help_markdown(): string {
	const out: Array<string> = []
	for (const section of HELP) {
		if (section.title === "Options") continue
		const heading: Record<string, string> = { Usage: "Setup and tools", Account: "The account" }
		out.push(`## ${heading[section.title] ?? section.title}`)
		out.push("")
		if (section.note) out.push(`${section.note.replace(/: (https?:\S+)/, ": <$1>")}`, "")
		// Padded to the widest cell, as the formatter would write it, so a generated file
		// is already in the shape `oxfmt --check` expects.
		// A `|` inside a cell splits it, code span or not, so it is escaped for the table —
		// and kept out of the help text altogether (see help.test.ts), because mdsvex
		// renders the escape literally where GitHub renders the pipe.
		const cell = (text: string) => text.replace(/\|/g, "\\|")
		const rows: Array<[string, string]> = [["Command", "What it does"]]
		for (const entry of section.entries) {
			const details = (entry.details ?? []).map((line) => `\`${line}\``).join(" · ")
			rows.push([
				`\`bunx postboi ${entry.command}\``,
				cell(`${entry.summary}${details ? ` — ${details}` : ""}`),
			])
		}
		const widths = [0, 1].map((i) => Math.max(...rows.map((row) => row[i].length)))
		const line = (row: [string, string]) =>
			`| ${row[0].padEnd(widths[0])} | ${row[1].padEnd(widths[1])} |`
		out.push(line(rows[0]))
		out.push(`| ${"-".repeat(widths[0])} | ${"-".repeat(widths[1])} |`)
		for (const row of rows.slice(1)) out.push(line(row))
		out.push("")
		if (section.footer) out.push(section.footer.join(" "), "")
	}
	return out.join("\n")
}
