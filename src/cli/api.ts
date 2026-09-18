import { readFileSync, writeFileSync } from "node:fs"
import { stdin, stdout } from "node:process"
import { ensure_env_loaded, read_env } from "../library/env.js"
import { cloud_base, open_browser, type PostboiDomain } from "./postboi.js"
import { bold, cyan, dim, green, red, strip_ansi, yellow } from "./prompts.js"

/**
 * The resource commands (`postboi lists`, `postboi domains add …`) — thin wrappers over
 * the /v1 API, authed with the POSTBOI_TOKEN that `postboi init` wrote. Full reference:
 * https://api.postboi.app
 */

/**
 * A failure with a message safe to print as-is — main() prints it red and exits 1. `code`
 * is the API's own (`name_taken`, `export_paused`, …) when the API said so, and is what a
 * script or an agent should branch on rather than the wording.
 */
export class ApiCommandError extends Error {
	code?: string
	constructor(message: string, code?: string) {
		super(message)
		this.code = code
	}
}

/**
 * `--json` on any account command: the API's response printed as one JSON document and
 * nothing else on stdout, so a pipeline or an agent reads the body rather than a table.
 * Set by `api_command`, read by `say`, cleared after the command.
 */
let json_mode = false
/** The last successful API response — what `--json` prints. */
let last_response: unknown

/** Print a line for a person; silent under `--json`, where stdout is the document. */
function say(line = ""): void {
	if (!json_mode) console.log(line)
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

async function api<T>(
	path: string,
	init: { method?: string; body?: unknown } = {},
	fetch_fn: FetchLike = fetch
): Promise<T> {
	await ensure_env_loaded()
	const token = read_env("POSTBOI_TOKEN")
	if (!token) {
		throw new ApiCommandError(
			"No POSTBOI_TOKEN found — run `postboi init` to sign in first.",
			"no_token"
		)
	}
	let response: Response
	try {
		response = await fetch_fn(`${cloud_base()}${path}`, {
			method: init.method ?? "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		})
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new ApiCommandError(
			`Could not reach ${cloud_base()} (${reason}). Are you online?`,
			"unreachable"
		)
	}
	const data = (await response.json().catch(() => undefined)) as
		| (T & { message?: string; code?: string })
		| undefined
	if (!response.ok) {
		throw new ApiCommandError(
			data?.message ?? `The API responded with ${response.status}.`,
			data?.code ?? `http_${response.status}`
		)
	}
	if (data === undefined) throw new ApiCommandError("Unexpected empty response from the API.")
	last_response = data
	return data
}

/** A GET whose answer is a file rather than JSON: the bytes and the name the server gave them. */
async function api_file(
	path: string,
	fetch_fn: FetchLike = fetch
): Promise<{ filename: string | undefined; bytes: Uint8Array }> {
	await ensure_env_loaded()
	const token = read_env("POSTBOI_TOKEN")
	if (!token) {
		throw new ApiCommandError(
			"No POSTBOI_TOKEN found — run `postboi init` to sign in first.",
			"no_token"
		)
	}
	let response: Response
	try {
		response = await fetch_fn(`${cloud_base()}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
		})
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new ApiCommandError(
			`Could not reach ${cloud_base()} (${reason}). Are you online?`,
			"unreachable"
		)
	}
	if (!response.ok) {
		const data = (await response.json().catch(() => undefined)) as
			| { message?: string; code?: string }
			| undefined
		throw new ApiCommandError(
			data?.message ?? `The API responded with ${response.status}.`,
			data?.code ?? `http_${response.status}`
		)
	}
	const disposition = response.headers.get("content-disposition") ?? ""
	return {
		filename: disposition.match(/filename="([^"]+)"/)?.[1],
		bytes: new Uint8Array(await response.arrayBuffer()),
	}
}

/** Visible width — cells may carry ANSI colour codes that padEnd would count. */
function width(value: string): number {
	return strip_ansi(value).length
}

/** Print rows as dimmed-header aligned columns. */
export function table(header: Array<string>, rows: Array<Array<string>>): void {
	const all = [header, ...rows]
	const widths = header.map((_, i) => Math.max(...all.map((row) => width(row[i] ?? ""))))
	const line = (row: Array<string>) =>
		"  " +
		row
			.map((cell, i) => cell + " ".repeat(widths[i] - width(cell)))
			.join("  ")
			.trimEnd()
	say(dim(line(header)))
	for (const row of rows) say(line(row))
}

function day(iso: string | undefined): string {
	return iso ? iso.slice(0, 10) : ""
}

// ── Account ────────────────────────────────────────────────────────────────

async function whoami(): Promise<void> {
	const account = await api<{
		id: string
		name?: string
		plan: string
		send_address: string
		suspended: boolean
		sends_today: number
		sends_this_month: number
		sandbox?: boolean
		unclaimed?: boolean
		claim_url?: string
	}>("/v1/account")
	say(`${bold(account.name ?? "My Team")} ${dim(`(${account.id})`)}`)
	say(`  plan          ${account.plan}`)
	say(`  send address  ${account.send_address}`)
	say(`  sends         ${account.sends_today} today, ${account.sends_this_month} this month`)
	if (account.suspended) say(`  ${red("suspended — contact support@postboi.app")}`)
	if (account.unclaimed && account.claim_url) {
		say(
			`  ${yellow("unclaimed")}     sandboxed until claimed — claim it at ${cyan(account.claim_url)}`
		)
	} else if (account.sandbox) {
		say(`  ${yellow("sandbox")}       sends are logged, nothing is delivered`)
	}
}

/**
 * Show or set the account's default sending address — the one stored on the account, not
 * the per-project `default.from` in postboi.config.ts. The API enforces the constraints:
 * a custom-domain address must be on a verified domain; a `@send.postboi.email` address
 * must be an unclaimed, non-reserved slug.
 */
async function send_address(args: Array<string>): Promise<void> {
	const address = args.join(" ").trim()
	if (!address) {
		const account = await api<{ send_address: string }>("/v1/account")
		return say(`${dim("Send address:")} ${account.send_address}`)
	}
	const updated = await api<{ send_address: string }>("/v1/account", {
		method: "PATCH",
		body: { send_address: address },
	})
	say(`${green("✓")} send address set to ${bold(updated.send_address)}`)
}

// ── Lists ──────────────────────────────────────────────────────────────────

async function lists(args: Array<string>): Promise<void> {
	const [action, ...rest] = args
	if (action === "add") {
		const name = rest.join(" ").trim()
		if (!name) throw new ApiCommandError("Usage: postboi lists add <name>")
		const list = await api<{ id: string; name: string }>("/v1/lists", {
			method: "POST",
			body: { name },
		})
		return say(`${green("✓")} created ${bold(list.name)} ${dim(`(${list.id})`)}`)
	}
	if (action === "delete") {
		const ref = rest.join(" ").trim()
		if (!ref) throw new ApiCommandError("Usage: postboi lists delete <name or id>")
		const gone = await api<{ id: string }>(`/v1/lists/${encodeURIComponent(ref)}`, {
			method: "DELETE",
		})
		return say(`${green("✓")} deleted ${bold(ref)} ${dim(`(${gone.id})`)}`)
	}
	if (action) throw new ApiCommandError(`Unknown action: lists ${action}. Try add or delete.`)

	const { lists: rows } = await api<{
		lists: Array<{
			id: string
			name: string
			recipients: number
			confirmation: boolean
			created_at: string
		}>
	}>("/v1/lists")
	if (rows.length === 0) return say(dim("No lists yet — postboi lists add <name>"))
	table(
		["NAME", "RECIPIENTS", "OPT-IN", "CREATED", "ID"],
		rows.map((l) => [
			bold(l.name),
			String(l.recipients),
			l.confirmation ? "double" : "single",
			day(l.created_at),
			dim(l.id),
		])
	)
}

async function recipients(args: Array<string>): Promise<void> {
	const [ref, action, ...emails] = args
	if (!ref) throw new ApiCommandError("Usage: postboi recipients <list> [add|remove <email>…]")
	const path = `/v1/lists/${encodeURIComponent(ref)}/recipients`

	if (action === "add") {
		if (emails.length === 0)
			throw new ApiCommandError("Usage: postboi recipients <list> add <email>…")
		const result = await api<{ added: number; updated: number; pending: number }>(path, {
			method: "POST",
			body: emails,
		})
		const pending = result.pending > 0 ? dim(` (${result.pending} pending confirmation)`) : ""
		return say(`${green("✓")} added ${result.added}, updated ${result.updated}${pending}`)
	}
	if (action === "remove") {
		const email = emails[0]
		if (!email) throw new ApiCommandError("Usage: postboi recipients <list> remove <email>")
		await api(`${path}?email=${encodeURIComponent(email)}`, { method: "DELETE" })
		return say(`${green("✓")} removed ${bold(email)}`)
	}
	if (action) throw new ApiCommandError(`Unknown action: recipients ${action}. Try add or remove.`)

	const list = await api<{
		name: string
		recipients: Array<{ email: string; name?: string; status: string }>
	}>(`/v1/lists/${encodeURIComponent(ref)}`)
	if (list.recipients.length === 0) return say(dim(`${list.name} has no recipients yet.`))
	table(
		["EMAIL", "NAME", "STATUS"],
		list.recipients.map((r) => [
			r.email,
			r.name ?? "",
			r.status === "subscribed" ? green(r.status) : yellow(r.status),
		])
	)
}

// ── Contacts ─────────────────────────────────────────────────────────────────

/** Pull `--name value` / `--data value` flags out of an arg list, returning the rest. */
function take_flags(
	args: Array<string>,
	names: Array<string>,
	switches: Array<string> = []
): { flags: Record<string, string>; rest: Array<string>; on: Set<string> } {
	const flags: Record<string, string> = {}
	const rest: Array<string> = []
	const on = new Set<string>()
	for (let i = 0; i < args.length; i++) {
		const match = names.find((name) => args[i] === `--${name}`)
		const flag = switches.find((name) => args[i] === `--${name}`)
		if (match) {
			flags[match] = args[++i] ?? ""
		} else if (flag) {
			on.add(flag)
		} else {
			rest.push(args[i])
		}
	}
	return { flags, rest, on }
}

interface ContactWire {
	email: string
	name?: string
	phone?: string
	data?: Record<string, string>
	created_at: string
	updated_at: string
}

async function contacts(args: Array<string>): Promise<void> {
	const [action, ...rest_args] = args

	if (action === "add") {
		const { flags, rest } = take_flags(rest_args, ["name", "phone", "data"])
		const email = rest[0]
		if (!email) {
			throw new ApiCommandError(
				"Usage: postboi contacts add <email> [--name <name>] [--phone <+E.164>] [--data <json>]"
			)
		}
		let data: Record<string, string> | undefined
		if (flags.data) {
			try {
				const parsed: unknown = JSON.parse(flags.data)
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
				data = Object.fromEntries(
					Object.entries(parsed).map(([key, value]) => [key, String(value)])
				)
			} catch {
				throw new ApiCommandError('--data must be a JSON object, e.g. \'{"plan":"pro"}\'')
			}
		}
		const contact = await api<ContactWire>("/v1/contacts", {
			method: "POST",
			body: { email, name: flags.name, phone: flags.phone, data },
		})
		return say(`${green("✓")} saved ${bold(contact.email)}`)
	}

	if (action === "remove") {
		const email = rest_args[0]
		if (!email) throw new ApiCommandError("Usage: postboi contacts remove <email>")
		await api(`/v1/contacts/${encodeURIComponent(email)}`, { method: "DELETE" })
		return say(`${green("✓")} removed ${bold(email)}`)
	}

	// A bare `contacts <email>` shows one contact and the lists it's on.
	if (action) {
		const contact = await api<
			ContactWire & {
				memberships: Array<{ list: { name: string }; status: string; created_at: string }>
			}
		>(`/v1/contacts/${encodeURIComponent(action)}`)
		say(`${bold(contact.email)}${contact.name ? dim(` (${contact.name})`) : ""}`)
		if (contact.phone) say(`  ${dim("phone:")} ${contact.phone}`)
		if (contact.data && Object.keys(contact.data).length > 0) {
			say(`  ${dim("data:")} ${JSON.stringify(contact.data)}`)
		}
		if (contact.memberships.length === 0) return say(dim("  On no lists."))
		say()
		return table(
			["LIST", "STATUS", "SINCE"],
			contact.memberships.map((m) => [
				m.list.name,
				m.status === "subscribed" ? green(m.status) : yellow(m.status),
				day(m.created_at),
			])
		)
	}

	// No action → page the whole audience.
	const { contacts: rows } = await api<{ contacts: Array<ContactWire> }>("/v1/contacts")
	if (rows.length === 0) return say(dim("No contacts yet — postboi contacts add <email>"))
	table(
		["EMAIL", "NAME", "CREATED"],
		rows.map((c) => [c.email, c.name ?? "", day(c.created_at)])
	)
}

// ── Domains ────────────────────────────────────────────────────────────────

interface DomainDetail {
	id: string
	domain: string
	status: string
	records: Array<{ type: string; name: string; value: string; priority?: number }>
	setup?: { provider: string; connect_url?: string; covers_dmarc?: boolean; manage_url?: string }
}

/** The records table + registrar shortcut a pending domain needs. */
function print_domain_setup(detail: DomainDetail): void {
	if (detail.status === "verified") {
		return say(`${green("✓")} ${bold(detail.domain)} is verified`)
	}
	say(`${yellow("⌛")} ${bold(detail.domain)} is ${detail.status}`)
	if (detail.records.length > 0) {
		say(`\n${bold("Publish these DNS records:")}\n`)
		table(
			["TYPE", "NAME", "VALUE"],
			detail.records.map((r) => [
				r.type,
				r.name,
				r.priority !== undefined ? `${r.priority} ${r.value}` : r.value,
			])
		)
	}
	const setup = detail.setup
	if (setup?.connect_url) {
		const dmarc = setup.covers_dmarc ? " (DMARC included)" : ""
		say(`\n${bold(`One-click setup at ${setup.provider}:`)}${dim(dmarc)}\n`)
		say(`  ${cyan(setup.connect_url)}\n`)
		if (stdout.isTTY && open_browser(setup.connect_url)) {
			say(dim("  (opening in your default browser)"))
		}
	} else if (setup?.manage_url) {
		say(`\n${dim(`Add them in your ${setup.provider} DNS console:`)} ${cyan(setup.manage_url)}`)
	}
	say(`\n${dim("Then:")} ${cyan(`bunx postboi domains check ${detail.domain}`)}`)
}

async function domains(args: Array<string>): Promise<void> {
	const [action, ref] = args
	if (action === "add") {
		if (!ref) throw new ApiCommandError("Usage: postboi domains add <domain>")
		const detail = await api<DomainDetail>("/v1/domains", { method: "POST", body: { domain: ref } })
		say(`${green("✓")} registered ${bold(detail.domain)}\n`)
		return print_domain_setup(detail)
	}
	if (action === "check") {
		if (!ref) throw new ApiCommandError("Usage: postboi domains check <domain>")
		const detail = await api<DomainDetail>(`/v1/domains/${encodeURIComponent(ref)}/check`, {
			method: "POST",
		})
		return print_domain_setup(detail)
	}
	if (action === "delete") {
		if (!ref) throw new ApiCommandError("Usage: postboi domains delete <domain>")
		await api(`/v1/domains/${encodeURIComponent(ref)}`, { method: "DELETE" })
		return say(
			`${green("✓")} removed ${bold(ref)} ${dim("(DNS records at your registrar are untouched)")}`
		)
	}
	if (action) {
		throw new ApiCommandError(`Unknown action: domains ${action}. Try add, check, or delete.`)
	}

	const identity = await api<{ send_address: string; domains: Array<PostboiDomain> }>("/v1/domains")
	say(`${dim("Send address:")} ${identity.send_address}\n`)
	if (identity.domains.length === 0) {
		return say(dim("No custom domains yet — postboi domains add <domain>"))
	}
	table(
		["DOMAIN", "STATUS"],
		identity.domains.map((d) => [
			d.domain,
			d.status === "verified" ? green(d.status) : yellow(d.status),
		])
	)
	if (identity.domains.some((d) => d.status !== "verified")) {
		say(`\n${dim("Pending? See its records:")} ${cyan("bunx postboi domains check <domain>")}`)
	}
}

// ── Webhooks ───────────────────────────────────────────────────────────────

async function webhooks(args: Array<string>): Promise<void> {
	const [action, ref] = args
	if (action === "add") {
		if (!ref) throw new ApiCommandError("Usage: postboi webhooks add <https url>")
		const endpoint = await api<{ id: string; url: string; secret: string }>("/v1/webhooks", {
			method: "POST",
			body: { url: ref },
		})
		say(`${green("✓")} created ${bold(endpoint.url)} ${dim(`(${endpoint.id})`)}`)
		say(`  ${dim("secret:")} ${endpoint.secret}`)
		return say(`  ${dim("`postboi sync` writes it to POSTBOI_WEBHOOK_SECRET for receive().")}`)
	}
	if (action === "delete") {
		if (!ref) throw new ApiCommandError("Usage: postboi webhooks delete <id>")
		await api(`/v1/webhooks/${encodeURIComponent(ref)}`, { method: "DELETE" })
		return say(`${green("✓")} deleted ${bold(ref)}`)
	}
	if (action === "deliveries") {
		if (!ref) throw new ApiCommandError("Usage: postboi webhooks deliveries <id>")
		const { deliveries } = await api<{
			deliveries: Array<{
				event_type: string
				status: string
				attempts: number
				last_error?: string
				created_at: string
			}>
		}>(`/v1/webhooks/${encodeURIComponent(ref)}/deliveries`)
		if (deliveries.length === 0) return say(dim("No deliveries yet."))
		return table(
			["EVENT", "STATUS", "ATTEMPTS", "WHEN", "ERROR"],
			deliveries.map((d) => [
				d.event_type,
				d.status === "delivered"
					? green(d.status)
					: d.status === "failed"
						? red(d.status)
						: yellow(d.status),
				String(d.attempts),
				d.created_at.slice(0, 16).replace("T", " "),
				dim(d.last_error ?? ""),
			])
		)
	}
	if (action) {
		throw new ApiCommandError(`Unknown action: webhooks ${action}. Try add, delete, or deliveries.`)
	}

	const { webhooks: rows } = await api<{
		webhooks: Array<{
			id: string
			name?: string
			url: string
			events: Array<string>
			disabled: boolean
		}>
	}>("/v1/webhooks")
	if (rows.length === 0) return say(dim("No webhooks yet — postboi webhooks add <url>"))
	table(
		["URL", "EVENTS", "STATE", "ID"],
		rows.map((w) => [
			w.url,
			w.events.length === 0 ? "all" : w.events.join(","),
			w.disabled ? yellow("paused") : green("active"),
			dim(w.id),
		])
	)
}

// ── Members ────────────────────────────────────────────────────────────────

async function members(args: Array<string>): Promise<void> {
	const [action, ref] = args
	if (action === "invite") {
		if (!ref) throw new ApiCommandError("Usage: postboi members invite <email>")
		const invite = await api<{ email: string; expires_at: string }>("/v1/members/invites", {
			method: "POST",
			body: { email: ref },
		})
		return say(
			`${green("✓")} invited ${bold(invite.email)} ${dim(`(expires ${day(invite.expires_at)})`)}`
		)
	}
	if (action === "remove") {
		if (!ref) throw new ApiCommandError("Usage: postboi members remove <email or user id>")
		const gone = await api<{ email: string }>(`/v1/members/${encodeURIComponent(ref)}`, {
			method: "DELETE",
		})
		return say(`${green("✓")} removed ${bold(gone.email)}`)
	}
	if (action === "revoke") {
		if (!ref) throw new ApiCommandError("Usage: postboi members revoke <email or invite id>")
		const gone = await api<{ email: string }>(`/v1/members/invites/${encodeURIComponent(ref)}`, {
			method: "DELETE",
		})
		return say(`${green("✓")} revoked the invite for ${bold(gone.email)}`)
	}
	if (action) {
		throw new ApiCommandError(`Unknown action: members ${action}. Try invite, remove, or revoke.`)
	}

	const data = await api<{
		members: Array<{ email: string; name?: string; role: string; created_at: string }>
		invites: Array<{ email: string; expires_at: string }>
	}>("/v1/members")
	table(
		["EMAIL", "NAME", "ROLE", "SINCE"],
		data.members.map((m) => [m.email, m.name ?? "", m.role, day(m.created_at)])
	)
	for (const invite of data.invites) {
		say(`  ${invite.email}  ${yellow("invited")} ${dim(`(expires ${day(invite.expires_at)})`)}`)
	}
}

// ── Send ───────────────────────────────────────────────────────────────────

/**
 * `a@b.co`, `Ada <a@b.co>`, or a comma list of them, as the API's `{ email, name }`
 * objects — the same shapes `to` takes everywhere else.
 */
export function parse_email_list(value: string): Array<{ email: string; name?: string }> {
	return value.split(/[,;\n]+/).flatMap((part) => {
		const match = part.match(/^\s*"?(.*?)"?\s*<\s*([^>]+)\s*>\s*$/)
		const email = (match ? match[2] : part).trim()
		if (!email.includes("@")) return []
		const name = match?.[1].trim()
		return [{ email, name: name || undefined }]
	})
}

const SEND_USAGE = [
	"Usage: postboi send --to <emails> --subject <s> (--text <t> | --html <h> | --file <path>|-)",
	"         [--from <a>] [--reply-to <a>] [--cc <emails>] [--bcc <emails>] [--at <ISO time>] [--tag a,b]",
].join("\n")

/** A body from `--file`: HTML when it looks like it, text otherwise. `-` reads stdin. */
function body_from_file(path: string): { html?: string; text?: string } {
	const content = path === "-" ? readFileSync(stdin.fd, "utf8") : readFileSync(path, "utf8")
	const looks_html = /\.html?$/i.test(path) || /^\s*</.test(content)
	return looks_html ? { html: content } : { text: content }
}

/**
 * One send from the terminal: the shortest proof that a project is wired, and the way
 * an agent sends a real message without writing a script. The id it prints is what
 * `messages <id>` reads back.
 */
async function send(args: Array<string>): Promise<void> {
	const { flags, rest } = take_flags(args, [
		"to",
		"subject",
		"text",
		"html",
		"file",
		"from",
		"reply-to",
		"cc",
		"bcc",
		"at",
		"tag",
	])
	const body = flags.file ? body_from_file(flags.file) : { html: flags.html, text: flags.text }
	if (rest.length || !flags.to || !flags.subject || (!body.html && !body.text)) {
		throw new ApiCommandError(SEND_USAGE)
	}
	const to = parse_email_list(flags.to)
	if (!to.length) throw new ApiCommandError("--to needs at least one email address.")
	const one = (value: string | undefined) => (value ? parse_email_list(value)[0] : undefined)
	const result = await api<{
		id: string
		sandbox?: boolean
		claim_url?: string
		idempotent_replay?: boolean
	}>("/v1/send", {
		method: "POST",
		body: {
			to,
			subject: flags.subject,
			html: body.html,
			text: body.text,
			from: one(flags.from),
			reply_to: one(flags["reply-to"]),
			cc: flags.cc ? parse_email_list(flags.cc) : undefined,
			bcc: flags.bcc ? parse_email_list(flags.bcc) : undefined,
			scheduled_at: flags.at,
			tags: flags.tag ? flags.tag.split(",").map((t) => t.trim()) : undefined,
		},
	})
	const verb = flags.at ? `scheduled for ${flags.at}` : "sent"
	say(`${green("✓")} ${verb} ${bold(result.id)} ${dim(`to ${to.map((r) => r.email).join(", ")}`)}`)
	if (result.claim_url) {
		say(`  ${yellow("sandbox")} — logged, not delivered until the project is claimed:`)
		say(`  ${cyan(result.claim_url)}`)
	} else if (result.sandbox) {
		say(`  ${yellow("sandbox")} — logged, nothing is delivered`)
	}
	say(`  ${dim(`postboi messages ${result.id} shows its delivery status.`)}`)
}

// ── Messages & suppressions ────────────────────────────────────────────────

const MESSAGE_STATUSES = [
	"scheduled",
	"queued",
	"sent",
	"delivered",
	"bounced",
	"complained",
	"rejected",
	"failed",
	"canceled",
]

interface MessageWire {
	id: string
	from: string
	to: Array<string>
	subject: string
	status: string
	form?: { id: string; name: string }
	fields?: Array<[string, string]>
	error?: string
	scheduled_at?: string
	opened_at?: string
	open_count: number
	created_at: string
}

function status_colour(status: string): string {
	if (status === "delivered" || status === "sent") return green(status)
	if (["bounced", "complained", "failed", "rejected"].includes(status)) return red(status)
	return yellow(status)
}

/** One message, read back: what happened to it, and what it carried. */
async function show_message(id: string): Promise<void> {
	const m = await api<MessageWire>(`/v1/messages/${encodeURIComponent(id)}`)
	say(`${bold(m.subject)} ${dim(`(${m.id})`)}`)
	say(`  status     ${status_colour(m.status)}${m.error ? dim(` — ${m.error}`) : ""}`)
	say(`  from       ${m.from}`)
	say(`  to         ${m.to.join(", ")}`)
	say(`  created    ${m.created_at.slice(0, 16).replace("T", " ")}`)
	if (m.scheduled_at) say(`  scheduled  ${m.scheduled_at.slice(0, 16).replace("T", " ")}`)
	if (m.opened_at) {
		say(`  opened     ${m.opened_at.slice(0, 16).replace("T", " ")} ${dim(`(${m.open_count}×)`)}`)
	}
	if (m.form) say(`  form       ${m.form.name} ${dim(`(${m.form.id})`)}`)
	if (m.fields?.length) {
		say(`  fields`)
		for (const [name, value] of m.fields) say(`    ${dim(name)}  ${value}`)
	}
	if (m.status === "scheduled") say(`  ${dim(`postboi messages cancel ${m.id} stops it.`)}`)
}

async function messages(args: Array<string>): Promise<void> {
	const [first, ref] = args
	if (first === "cancel") {
		if (!ref) throw new ApiCommandError("Usage: postboi messages cancel <id>")
		const result = await api<{ id: string; status: string }>(
			`/v1/messages/${encodeURIComponent(ref)}/cancel`,
			{ method: "POST" }
		)
		return say(`${green("✓")} canceled ${bold(result.id)}`)
	}
	// A word that isn't a status is an id: `messages msg_k3v9…` reads one back.
	if (first && !MESSAGE_STATUSES.includes(first)) return show_message(first)
	const status = first
	const query = status ? `?status=${encodeURIComponent(status)}` : ""
	const { messages: rows } = await api<{
		messages: Array<{
			id: string
			to: Array<string>
			subject: string
			status: string
			created_at: string
		}>
	}>(`/v1/messages${query}`)
	if (rows.length === 0) return say(dim("No messages."))
	table(
		["WHEN", "TO", "SUBJECT", "STATUS", "ID"],
		rows.map((m) => [
			m.created_at.slice(0, 16).replace("T", " "),
			m.to.join(","),
			m.subject,
			status_colour(m.status),
			dim(m.id),
		])
	)
}

/**
 * An email or a phone number, as the suppressions commands take it: anything with an
 * `@` is an address; anything else is a number and is suppressed per channel, SMS
 * unless `--channel whatsapp` says otherwise.
 */
function suppression_target(
	value: string,
	channel: string | undefined
): { body: Record<string, string>; query: string; label: string } {
	if (value.includes("@")) {
		return { body: { email: value }, query: `email=${encodeURIComponent(value)}`, label: value }
	}
	const on = channel ?? "sms"
	if (on !== "sms" && on !== "whatsapp") {
		throw new ApiCommandError("--channel must be sms or whatsapp.")
	}
	return {
		body: { phone: value, channel: on },
		query: `phone=${encodeURIComponent(value)}&channel=${encodeURIComponent(on)}`,
		label: `${value} (${on})`,
	}
}

async function suppressions(args: Array<string>): Promise<void> {
	const [action, ...rest_args] = args
	if (action === "add" || action === "remove") {
		const { flags, rest } = take_flags(rest_args, ["channel"])
		const value = rest[0]
		if (!value) {
			throw new ApiCommandError(
				`Usage: postboi suppressions ${action} <email | +phone> [--channel sms|whatsapp]`
			)
		}
		const target = suppression_target(value, flags.channel)
		if (action === "add") {
			await api("/v1/suppressions", { method: "POST", body: target.body })
			return say(`${green("✓")} suppressed ${bold(target.label)}`)
		}
		await api(`/v1/suppressions?${target.query}`, { method: "DELETE" })
		return say(`${green("✓")} unsuppressed ${bold(target.label)}`)
	}
	if (action) {
		throw new ApiCommandError(`Unknown action: suppressions ${action}. Try add or remove.`)
	}

	const { suppressions: rows } = await api<{
		suppressions: Array<{
			channel: string
			email?: string
			phone?: string
			reason: string
			created_at: string
		}>
	}>("/v1/suppressions")
	if (rows.length === 0) return say(dim("No suppressed addresses."))
	table(
		["ADDRESS", "CHANNEL", "REASON", "SINCE"],
		rows.map((s) => [s.email ?? s.phone ?? "", s.channel, s.reason, day(s.created_at)])
	)
}

// ── Scheduled exports ──────────────────────────────────────────────────────

interface ExportSchedule {
	frequency: string
	days: Array<number>
	month_day: number
	send_time: string
	timezone: string
}

interface ExportWire {
	id: string
	name: string
	recipients: Array<{ email: string; name?: string }>
	filter: Record<string, unknown>
	format: string
	window: string
	schedule: ExportSchedule
	paused: boolean
	next_run_at: string | null
	last_error: string | null
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

/** `mon`, `Monday`, `1`, or a comma list of them, as the API's 0–6 (0 = Sunday). */
export function parse_weekdays(value: string): Array<number> {
	return value
		.split(/[,\s]+/)
		.filter(Boolean)
		.map((part) => {
			const lower = part.toLowerCase()
			if (/^[0-6]$/.test(lower)) return Number(lower)
			const index = lower.length >= 3 ? WEEKDAYS.findIndex((day) => day.startsWith(lower)) : -1
			if (index === -1) {
				throw new ApiCommandError(`--day takes weekday names or 0-6 (0 = Sunday), not "${part}".`)
			}
			return index
		})
}

function ordinal(n: number): string {
	const rest = n % 100
	const suffix = rest >= 11 && rest <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")
	return `${n}${suffix}`
}

/** "weekly on Monday at 09:00 UTC" — said back after a create, so a default is visible. */
export function describe_schedule(schedule: ExportSchedule): string {
	const when = `at ${schedule.send_time} ${schedule.timezone}`
	if (schedule.frequency === "daily") return `daily ${when}`
	if (schedule.frequency === "monthly") {
		return `monthly on the ${ordinal(schedule.month_day)} ${when}`
	}
	const names = schedule.days.map((day) => {
		const name = WEEKDAYS[day] ?? "?"
		return name.charAt(0).toUpperCase() + name.slice(1)
	})
	return `weekly on ${names.join(", ")} ${when}`
}

/** The Sent log's filters as flags, shared by `exports add` and `exports download`. */
const FILTER_FLAGS = ["form", "subject", "from-address", "to-address", "status", "opens"]

function filter_from_flags(flags: Record<string, string>): Record<string, unknown> {
	return {
		form: flags.form,
		subject: flags.subject,
		from: flags["from-address"],
		to: flags["to-address"],
		status: flags.status ? flags.status.split(",").map((s) => s.trim()) : undefined,
		opens: flags.opens,
		since: flags.since,
		until: flags.until,
	}
}

/** Where a download lands: `--out` if given, else the name the server gave the file. */
export function download_target(
	out: string | undefined,
	filename: string | undefined,
	format: "csv" | "xlsx"
): string {
	return out || filename || `export.${format}`
}

const EXPORTS_DOWNLOAD_USAGE = [
	"Usage: postboi exports download [--out <file>|-] [--xlsx] [--no-fields] [--columns a,b]",
	"         [--form <form>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--subject <s>]",
	"         [--from-address <a>] [--to-address <a>] [--status delivered,bounced]",
	"         [--opens opened|unopened|untracked]",
].join("\n")

const EXPORTS_ADD_USAGE = [
	"Usage: postboi exports add <name> --to <emails> --daily|--weekly|--monthly",
	"         [--form <form>] [--day mon,fri] [--month-day 1] [--at HH:MM] [--tz Europe/London]",
	"         [--xlsx] [--no-fields] [--window since_last_run|previous_period|all_matching]",
	"         [--from <sender>] [--subject <s>] [--from-address <a>] [--to-address <a>]",
	"         [--status delivered,bounced] [--opens opened|unopened|untracked]",
].join("\n")

async function exports_command(args: Array<string>): Promise<void> {
	const [action, ...rest_args] = args

	if (action === "add") {
		const { flags, rest, on } = take_flags(
			rest_args,
			["to", "from", "day", "month-day", "at", "tz", "window", ...FILTER_FLAGS],
			["daily", "weekly", "monthly", "xlsx", "no-fields"]
		)
		const name = rest.join(" ").trim()
		const frequencies = ["daily", "weekly", "monthly"].filter((f) => on.has(f))
		if (!name || !flags.to || frequencies.length !== 1) {
			throw new ApiCommandError(EXPORTS_ADD_USAGE)
		}
		const schedule = {
			frequency: frequencies[0],
			days: flags.day ? parse_weekdays(flags.day) : undefined,
			month_day: flags["month-day"] ? Number(flags["month-day"]) : undefined,
			send_time: flags.at,
			timezone: flags.tz,
		}
		const filter = filter_from_flags(flags)
		const created = await api<ExportWire>("/v1/exports", {
			method: "POST",
			body: {
				name,
				recipients: flags.to,
				from: flags.from,
				filter,
				format: on.has("xlsx") ? "xlsx" : undefined,
				fields: on.has("no-fields") ? false : undefined,
				window: flags.window,
				schedule,
			},
		})
		say(
			`${green("✓")} scheduled ${bold(created.name)} ${dim(`(${created.id})`)} — ${describe_schedule(created.schedule)}`
		)
		say(`  ${dim("to:")} ${created.recipients.map((r) => r.email).join(", ")}`)
		const set = Object.entries(created.filter).filter(([, value]) => value !== undefined)
		say(
			`  ${dim("rows:")} ${
				set.length === 0
					? "the whole Sent log"
					: set.map(([key, value]) => `${key}=${String(value)}`).join(" ")
			}${created.format === "xlsx" ? dim(" · xlsx") : ""}${dim(` · ${created.window.replace(/_/g, " ")}`)}`
		)
		return say(`  ${dim(`postboi exports run ${created.id} sends one now.`)}`)
	}

	if (action === "download") {
		const { flags, rest, on } = take_flags(
			rest_args,
			["out", "columns", "since", "until", ...FILTER_FLAGS],
			["xlsx", "no-fields"]
		)
		if (rest.length) throw new ApiCommandError(EXPORTS_DOWNLOAD_USAGE)
		const params = new URLSearchParams()
		for (const [key, value] of Object.entries(filter_from_flags(flags))) {
			if (value === undefined) continue
			params.set(key, Array.isArray(value) ? value.join(",") : String(value))
		}
		if (on.has("xlsx")) params.set("format", "xlsx")
		if (on.has("no-fields")) params.set("fields", "0")
		if (flags.columns) params.set("columns", flags.columns)
		const query = params.toString()
		const file = await api_file(`/v1/exports/download${query ? `?${query}` : ""}`)
		const rows = on.has("xlsx")
			? undefined
			: Math.max(0, new TextDecoder().decode(file.bytes).split("\r\n").length - 2)
		const count = rows === undefined ? "" : dim(` — ${rows} row${rows === 1 ? "" : "s"}`)
		if (flags.out === "-") {
			stdout.write(file.bytes)
			return
		}
		const target = download_target(flags.out, file.filename, on.has("xlsx") ? "xlsx" : "csv")
		writeFileSync(target, file.bytes)
		last_response = { filename: target, bytes: file.bytes.length, rows }
		return say(`${green("✓")} wrote ${bold(target)}${count}`)
	}

	if (action === "run" || action === "pause" || action === "resume" || action === "delete") {
		const id = rest_args[0]
		if (!id) throw new ApiCommandError(`Usage: postboi exports ${action} <id>`)
		const path = `/v1/exports/${encodeURIComponent(id)}`
		if (action === "run") {
			await api(`${path}/run`, { method: "POST" })
			return say(`${green("✓")} queued ${bold(id)} ${dim("— the file goes within a minute")}`)
		}
		if (action === "delete") {
			await api(path, { method: "DELETE" })
			return say(`${green("✓")} deleted ${bold(id)}`)
		}
		const row = await api<ExportWire>(path, {
			method: "PATCH",
			body: { paused: action === "pause" },
		})
		return say(
			`${green("✓")} ${action === "pause" ? "paused" : "resumed"} ${bold(row.name)}${
				row.next_run_at ? dim(` — next ${row.next_run_at.slice(0, 16).replace("T", " ")}`) : ""
			}`
		)
	}

	if (action) {
		throw new ApiCommandError(
			`Unknown action: exports ${action}. Try add, download, run, pause, resume, or delete.`
		)
	}

	const { exports: rows } = await api<{ exports: Array<ExportWire> }>("/v1/exports")
	if (rows.length === 0) {
		return say(dim("No scheduled exports — postboi exports add <name> --to <email> --weekly"))
	}
	table(
		["NAME", "SCHEDULE", "TO", "NEXT", "STATE", "ID"],
		rows.map((row) => [
			row.name,
			describe_schedule(row.schedule),
			row.recipients.map((r) => r.email).join(","),
			row.next_run_at ? row.next_run_at.slice(0, 16).replace("T", " ") : "",
			row.paused ? yellow("paused") : row.last_error ? red("failing") : green("active"),
			dim(row.id),
		])
	)
}

// ── Dispatch ───────────────────────────────────────────────────────────────

const COMMANDS: Record<string, (args: Array<string>) => Promise<void>> = {
	whoami: () => whoami(),
	send,
	"send-address": send_address,
	lists,
	recipients,
	contacts,
	domains,
	webhooks,
	members,
	messages,
	exports: exports_command,
	suppressions,
}

/**
 * The nouns that list on a bare call. `list` is what people and agents guess first, so
 * it is accepted as the same thing; `recipients` is left out because its first word is
 * the list's name.
 */
const LISTING = new Set([
	"lists",
	"contacts",
	"domains",
	"webhooks",
	"members",
	"messages",
	"suppressions",
	"exports",
])

/** Handle a resource command; false when `command` isn't one (main falls through to help). */
export async function api_command(command: string, args: Array<string>): Promise<boolean> {
	const handler = COMMANDS[command]
	if (!handler) return false
	json_mode = args.includes("--json")
	last_response = undefined
	const rest = args.filter((arg) => arg !== "--json")
	try {
		await handler(LISTING.has(command) && rest[0] === "list" ? rest.slice(1) : rest)
		if (json_mode) console.log(JSON.stringify(last_response ?? null, null, 2))
	} finally {
		json_mode = false
	}
	return true
}

/** How main() reports a failure under `--json`: one JSON document on stderr, with the code. */
export function error_json(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	const code = error instanceof ApiCommandError ? error.code : undefined
	return JSON.stringify({ error: { message, code } })
}
