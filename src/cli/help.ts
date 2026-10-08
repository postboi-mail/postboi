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
					"Installs postboi, adds the postboi() Vite plugin, writes postboi.config and runs sync",
					"--agent: zero prompts, zero sign-in. Provisions a claimable sandbox account (made for AI coding agents and CI)",
					"--sms · --whatsapp · --push · --chat: set up that channel instead",
				],
			},
			{
				command: "sync",
				summary: "Pull synced team credentials and refresh the generated from/template types",
				details: [
					"Bakes the captcha key for <Captcha />; warns when node_modules is behind the lockfile",
				],
			},
			{
				command: "env",
				summary: "The synced credentials",
				details: ["push · pull [--force] · remove <KEY>"],
			},
			{
				command: "vapid",
				summary:
					"Mint a VAPID key pair for Web Push, printed to stdout. --export prints managed push's pair",
			},
			{
				command: "doctor",
				summary:
					"Is this project wired? Install, token, provider, from address, webhooks, captcha key, skill",
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
				summary: "Lint an email's HTML: client compatibility, clipping, dead links",
				details: ["<file.html> · --links --subject <s> --json (exit 1 on warnings)"],
			},
		],
	},
	{
		title: "Account",
		note: "Postboi provider. Full reference: https://api.postboi.app",
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
				command: "migrate resend",
				summary: "Move a Resend account here: domains, audiences as lists, webhooks",
				details: [
					"[--key <resend key>] [--only domains,lists,webhooks] [--dry-run] [--json]",
					"Reads RESEND_API_KEY when --key is absent. Safe to run twice: what is here already is skipped",
				],
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
				summary: "Email tests: a report and real-client screenshots",
				details: [
					"run <file.html or -> pastes it, waits for every screenshot and saves them to screenshots/<series>/<group>/<client>.png",
					"run: --series (default: the file name) --clients a,b or --set <name> or --all (batched) --fresh --out <dir> --no-wait --share --yes; exits 1 on an error report or a failed capture",
					"run and add --html upload the local images and fonts the HTML points at (src, srcset, url(), VML) and point it at the copies; --no-assets sends it as it is",
					"download <id> [--out dir]: wait out an existing run and save its screenshots",
					"add [--label] [--series] [--clients or --set] [--html <file>] · <id> (the report) · clients · delete <id>",
					"sets · sets save <name> --clients a,b · sets delete <name> · share <id> [--revoke]",
				],
			},
			{
				command: "views",
				summary: "Web versions of emails, for a View in browser link whoever sends them",
				details: [
					"publish <file.html> [--slug <s>] [--context <file.json or .js>] [--provider onesignal, braze, iterable, customerio, klaviyo, mailchimp, sendgrid or none]",
					"publish: --public <var[:integer, date or enum]>,… or --public all makes reader variables URL params; the rest come through the sender's data feed",
					"publish: prints the link in the sender's merge syntax and the feed setup; --write puts the link in the file and data-web-hide on unsubscribe links (--yes skips asking)",
					"publish: --reader <template path> puts the reader's id on the link as u, for view.viewed webhooks (opt-in: anyone can edit it; off turns it off)",
					"publish: uploads the local images and fonts the HTML points at (kept, unlike test uploads) and publishes it pointing at the copies (the file keeps its paths); --no-assets publishes it as it is",
					"stats <slug> [--days 30]: views and visitors per day, by public params, and how many were identified",
					"open <slug> [--data <json>] [--param key=value] · delete <slug> · keys [rotate] · feed-key",
				],
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
			"The inbox made or used last is the default; POSTBOI_INBOX_TOKEN overrides",
			"it (the token alone finds its inbox), POSTBOI_INBOX_URL moves the host.",
		],
	},
	{
		title: "Agent mailboxes",
		note: "agentboi.email; no POSTBOI_TOKEN needed to make one",
		entries: [
			{
				command: "mailbox new",
				summary: "Make an address your agent keeps, and print it",
				details: [
					"[--address <name>] [--name <label>] [--domain <yours>] [--json] [--env]",
					"With POSTBOI_TOKEN it is your team's; without, it sends once you open its claim link",
					"--env prints export POSTBOI_MAILBOX_KEY=… for eval",
				],
			},
			{
				command: "mailbox watch",
				summary: "Print mail as it arrives, one line each, with who is talking",
				details: [
					"[address] --all --json (NDJSON) --trust <owner, thread, stranger or suspect> --tag --from --subject",
					"--exec <cmd>: run per mail with ID THREAD TRUST FROM SUBJECT REPLY_TEXT CODE LINK set",
				],
			},
			{
				command: "mailbox wait",
				summary: "Wait for one mail, then exit",
				details: [
					"[address] --from --subject --tag --trust (/regex/ works) --timeout <sec> --new",
					"--code or --link prints only that (exit 3 if absent) · --json · exit 2 on timeout",
				],
			},
			{
				command: "mailbox read",
				summary: "One mail in full: what they wrote, minus the quoted thread",
				details: ["[id or latest] [address] --html --raw --json"],
			},
			{
				command: "mailbox reply",
				summary: "Answer a mail in its thread",
				details: ['<id> [address] --text "…" (or --html) --cc a,b --bcc c --subject "…"'],
			},
			{
				command: "mailbox send",
				summary: "A new message from the mailbox",
				details: ['[address] --to a@b.com,c@d.com --subject "…" --text "…"'],
			},
			{ command: "mailbox threads", summary: "Its conversations, newest activity first" },
			{
				command: "mailbox ls",
				summary: "Mailboxes on this machine",
				details: ["key [address]: a new key, the old one stops · rm [address]"],
			},
		],
		footer: [
			"The mailbox made or used last is the default; POSTBOI_MAILBOX_KEY overrides",
			"it (the key alone finds its mailbox), POSTBOI_MAILBOX_URL moves the host.",
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
/** The whole reference, or only the sections named in `only`. */
function entry_lines(section: HelpSection, entry: HelpEntry): Array<string> {
	const name = section.title === "Options" ? entry.command : `bunx postboi ${entry.command}`
	const pad = " ".repeat(Math.max(1, COLUMN - name.length))
	return [
		`  ${section.title === "Options" ? name : cyan(name)}${pad}${entry.summary}`,
		...(entry.details ?? []).map((line) => `  ${" ".repeat(COLUMN)}${dim(`· ${line}`)}`),
	]
}

/** One command's entry, for `postboi <command> --help`. Undefined for a command with none. */
export function command_help(command: string): string | undefined {
	for (const section of HELP) {
		const entry = section.entries.find((candidate) => candidate.command === command)
		if (entry) return entry_lines(section, entry).join("\n")
	}
	return undefined
}

export function help_text(only?: Array<string>): string {
	const out: Array<string> = []
	for (const section of HELP) {
		if (only && !only.includes(section.title)) continue
		out.push(`${bold(section.title)}${section.note ? ` ${dim(`(${section.note})`)}` : ""}`)
		for (const entry of section.entries) out.push(...entry_lines(section, entry))
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
				cell(`${entry.summary}${details ? `: ${details}` : ""}`),
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
