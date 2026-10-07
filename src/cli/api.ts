import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"
import { stdin, stdout } from "node:process"
import { ensure_env_loaded, read_env } from "../library/env.js"
import { html_to_text } from "../library/utils.js"
import {
	screenshots_settled,
	type TestingPreview,
	type TestingRun,
} from "../library/inspect/hosted.js"
import { command_help, help_text } from "./help.js"
import { cloud_base, open_browser, type PostboiDomain } from "./postboi.js"
import { bold, create_prompts, cyan, dim, green, red, strip_ansi, yellow } from "./prompts.js"

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

/** The token every account command sends, or the `no_token` refusal main() prints. */
export async function postboi_token(): Promise<string> {
	await ensure_env_loaded()
	const token = read_env("POSTBOI_TOKEN")
	if (!token) {
		throw new ApiCommandError(
			"No POSTBOI_TOKEN found. Run `postboi init` to sign in first.",
			"no_token"
		)
	}
	return token
}

export async function api<T>(
	path: string,
	init: { method?: string; body?: unknown } = {},
	fetch_fn: FetchLike = fetch
): Promise<T> {
	const token = await postboi_token()
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
	// 204 is a deliberate "done, nothing to say" (the DELETEs), not a broken answer.
	if (response.status === 204) return undefined as T
	if (data === undefined) throw new ApiCommandError("Unexpected empty response from the API.")
	last_response = data
	return data
}

/** A GET whose answer is a file rather than JSON: the bytes and the name the server gave them. */
async function api_file(
	path: string,
	fetch_fn: FetchLike = fetch
): Promise<{ filename: string | undefined; content_type: string | null; bytes: Uint8Array }> {
	const token = await postboi_token()
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
		content_type: response.headers.get("content-type"),
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
	if (account.suspended) say(`  ${red("suspended, contact support@postboi.app")}`)
	if (account.unclaimed && account.claim_url) {
		say(
			`  ${yellow("unclaimed")}     sandboxed until claimed. Claim it at ${cyan(account.claim_url)}`
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
	if (action === "send") {
		const { flags, rest: words } = take_flags(rest, [
			"subject",
			"text",
			"html",
			"file",
			"from",
			"reply-to",
			"at",
		])
		const ref = words.join(" ").trim()
		const body = flags.file ? body_from_file(flags.file) : { html: flags.html, text: flags.text }
		if (!ref || !flags.subject || (!body.html && !body.text)) {
			throw new ApiCommandError(
				"Usage: postboi lists send <list> --subject <s> (--text <t> | --html <h> | --file <path>|-) [--from <a>] [--reply-to <a>] [--at <ISO time>]"
			)
		}
		const one = (value: string | undefined) => (value ? parse_email_list(value)[0] : undefined)
		const result = await api<{ ids: Array<string>; recipients: number; scheduled_at?: string }>(
			`/v1/lists/${encodeURIComponent(ref)}/send`,
			{
				method: "POST",
				body: {
					subject: flags.subject,
					html: body.html,
					text: body.text,
					from: one(flags.from),
					reply_to: one(flags["reply-to"]),
					scheduled_at: flags.at,
				},
			}
		)
		const verb = result.scheduled_at ? `scheduled for ${result.scheduled_at}` : "sent"
		return say(
			`${green("✓")} ${verb} to ${bold(String(result.recipients))} subscribed recipient(s) of ${bold(ref)}`
		)
	}
	if (action) {
		throw new ApiCommandError(`Unknown action: lists ${action}. Try add, send, or delete.`)
	}

	const { lists: rows } = await api<{
		lists: Array<{
			id: string
			name: string
			recipients: number
			confirmation: boolean
			created_at: string
		}>
	}>("/v1/lists")
	if (rows.length === 0) return say(dim("No lists yet. Add one: postboi lists add <name>"))
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
export function take_flags(
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
	if (rows.length === 0) return say(dim("No contacts yet. Add one: postboi contacts add <email>"))
	table(
		["EMAIL", "NAME", "CREATED"],
		rows.map((c) => [c.email, c.name ?? "", day(c.created_at)])
	)
}

// ── Domains ────────────────────────────────────────────────────────────────

export interface DomainDetail {
	id: string
	domain: string
	status: string
	records: Array<{ type: string; name: string; value: string; priority?: number }>
	setup?: { provider: string; connect_url?: string; covers_dmarc?: boolean; manage_url?: string }
}

/** The records table + registrar shortcut a pending domain needs. */
export function print_domain_setup(detail: DomainDetail): void {
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
	if (action === "inbound") {
		const { on, rest } = take_flags(args.slice(1), [], ["off"])
		const domain = rest[0]
		if (!domain) throw new ApiCommandError("Usage: postboi domains inbound <domain> [--off]")
		const path = `/v1/domains/${encodeURIComponent(domain)}/inbound`
		if (on.has("off")) {
			await api(path, { method: "DELETE" })
			return say(`${green("✓")} receiving off for ${bold(domain)}`)
		}
		const detail = await api<
			DomainDetail & {
				inbound?: {
					domain: string
					status: string
					records: Array<{ type: string; name: string; value: string; priority?: number }>
				}
			}
		>(path, { method: "POST" })
		const inbound = detail.inbound
		if (!inbound) return say(`${green("✓")} receiving enabled for ${bold(domain)}`)
		if (inbound.status === "active") {
			return say(`${green("✓")} receiving mail on ${bold(inbound.domain)}`)
		}
		say(`${yellow("⌛")} receiving on ${bold(inbound.domain)} is ${inbound.status}`)
		if (inbound.records.length > 0) {
			say(`\n${bold("Publish these DNS records:")}\n`)
			table(
				["TYPE", "NAME", "VALUE"],
				inbound.records.map((r) => [
					r.type,
					r.name,
					r.priority !== undefined ? `${r.priority} ${r.value}` : r.value,
				])
			)
		}
		return say(`\n${dim("Then:")} ${cyan(`bunx postboi domains check ${domain}`)}`)
	}
	if (action === "delete") {
		if (!ref) throw new ApiCommandError("Usage: postboi domains delete <domain>")
		await api(`/v1/domains/${encodeURIComponent(ref)}`, { method: "DELETE" })
		return say(
			`${green("✓")} removed ${bold(ref)} ${dim("(DNS records at your registrar are untouched)")}`
		)
	}
	if (action) {
		throw new ApiCommandError(
			`Unknown action: domains ${action}. Try add, check, inbound, or delete.`
		)
	}

	const identity = await api<{ send_address: string; domains: Array<PostboiDomain> }>("/v1/domains")
	say(`${dim("Send address:")} ${identity.send_address}\n`)
	if (identity.domains.length === 0) {
		return say(dim("No custom domains yet. Add one: postboi domains add <domain>"))
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
	if (action === "rotate") {
		if (!ref) throw new ApiCommandError("Usage: postboi webhooks rotate <id>")
		const rotated = await api<{ id: string; secret: string }>(
			`/v1/webhooks/${encodeURIComponent(ref)}/rotate`,
			{ method: "POST" }
		)
		say(`${green("✓")} rotated the secret for ${bold(rotated.id)}`)
		say(`  ${dim("secret:")} ${rotated.secret}`)
		return say(
			`  ${dim("`postboi sync` writes it to POSTBOI_WEBHOOK_SECRET. The old one stops verifying now.")}`
		)
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
		throw new ApiCommandError(
			`Unknown action: webhooks ${action}. Try add, rotate, deliveries, or delete.`
		)
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
	if (rows.length === 0) return say(dim("No webhooks yet. Add one: postboi webhooks add <url>"))
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
		say(`  ${yellow("sandbox")}: logged, not delivered until the project is claimed:`)
		say(`  ${cyan(result.claim_url)}`)
	} else if (result.sandbox) {
		say(`  ${yellow("sandbox")}: logged, nothing is delivered`)
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
	say(`  status     ${status_colour(m.status)}${m.error ? dim(` (${m.error})`) : ""}`)
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

const SCHEDULE_FLAGS = ["day", "month-day", "at", "tz"]
const FREQUENCY_SWITCHES = ["daily", "weekly", "monthly"]

/**
 * A schedule as the API takes one, from `--daily|--weekly|--monthly` plus `--day`,
 * `--month-day`, `--at` and `--tz` — shared by `exports add` and `notifications add`.
 * Undefined when no frequency switch is on; a caller decides whether that is an error.
 */
function schedule_from_flags(
	flags: Record<string, string>,
	on: Set<string>,
	extra: Array<string> = []
): Record<string, unknown> | undefined {
	const chosen = [...FREQUENCY_SWITCHES, ...extra].filter((f) => on.has(f))
	if (chosen.length !== 1) return undefined
	if (extra.includes(chosen[0])) return { frequency: chosen[0] }
	return {
		frequency: chosen[0],
		days: flags.day ? parse_weekdays(flags.day) : undefined,
		month_day: flags["month-day"] ? Number(flags["month-day"]) : undefined,
		send_time: flags.at,
		timezone: flags.tz,
	}
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
			["to", "from", "window", ...SCHEDULE_FLAGS, ...FILTER_FLAGS],
			[...FREQUENCY_SWITCHES, "xlsx", "no-fields"]
		)
		const name = rest.join(" ").trim()
		const schedule = schedule_from_flags(flags, on)
		if (!name || !flags.to || !schedule) throw new ApiCommandError(EXPORTS_ADD_USAGE)
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
			`${green("✓")} scheduled ${bold(created.name)} ${dim(`(${created.id})`)}: ${describe_schedule(created.schedule)}`
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
		const count = rows === undefined ? "" : dim(` (${rows} row${rows === 1 ? "" : "s"})`)
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
			return say(`${green("✓")} queued ${bold(id)} ${dim("(the file goes within a minute)")}`)
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
				row.next_run_at ? dim(`, next run ${row.next_run_at.slice(0, 16).replace("T", " ")}`) : ""
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
		return say(
			dim("No scheduled exports. Add one: postboi exports add <name> --to <email> --weekly")
		)
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

// ── Forms ──────────────────────────────────────────────────────────────────

/** What submissions are filed under — the names `form:` is typed to by `sync`. */
async function forms(args: Array<string>): Promise<void> {
	if (args[0]) {
		throw new ApiCommandError(
			'Forms are named from your code (`mail({ form: "Contact" })`) and managed in the dashboard. `postboi forms` lists them.'
		)
	}
	const { forms: rows } = await api<{
		forms: Array<{ id: string; name: string; kind: string; paused: boolean; created_at: string }>
	}>("/v1/forms")
	if (rows.length === 0) {
		return say(dim('No forms yet. Name one on a send: mail({ …, form: "Contact" })'))
	}
	table(
		["NAME", "KIND", "STATE", "CREATED", "ID"],
		rows.map((f) => [
			bold(f.name),
			f.kind === "library" ? "named in code" : "hosted endpoint",
			f.paused ? yellow("paused") : green("active"),
			day(f.created_at),
			dim(f.id),
		])
	)
}

// ── Notifications (a list's digests) ───────────────────────────────────────

interface NotificationWire {
	id: string
	recipients: Array<{ email: string; name?: string } | string>
	subject?: string
	schedule: ExportSchedule | { frequency: string }
	next_run_at?: string | null
	last_run_at?: string | null
}

const NOTIFICATIONS_ADD_USAGE = [
	"Usage: postboi notifications <list> add --to <emails> --daily|--weekly|--monthly|--on-signup",
	"         [--subject <s>] [--body <html>] [--from <a>] [--day mon,fri] [--month-day 1] [--at HH:MM] [--tz Europe/London]",
].join("\n")

function describe_notification_schedule(schedule: NotificationWire["schedule"]): string {
	if (schedule.frequency === "subscribe") return "on each signup"
	return describe_schedule(schedule as ExportSchedule)
}

/** A list's notifications: a digest of new signups on a schedule, or a note on each one. */
async function notifications(args: Array<string>): Promise<void> {
	const [list, action, ...rest_args] = args
	if (!list) {
		throw new ApiCommandError("Usage: postboi notifications <list> [add … | delete <id>]")
	}
	const path = `/v1/lists/${encodeURIComponent(list)}/notifications`

	if (action === "add") {
		const { flags, rest, on } = take_flags(
			rest_args,
			["to", "subject", "body", "from", ...SCHEDULE_FLAGS],
			[...FREQUENCY_SWITCHES, "on-signup"]
		)
		const schedule = schedule_from_flags(flags, on, ["on-signup"])
		if (rest.length || !flags.to || !schedule) throw new ApiCommandError(NOTIFICATIONS_ADD_USAGE)
		if (schedule.frequency === "on-signup") schedule.frequency = "subscribe"
		const created = await api<NotificationWire>(path, {
			method: "POST",
			body: {
				recipients: flags.to,
				subject: flags.subject,
				body: flags.body,
				from: flags.from,
				schedule,
			},
		})
		return say(
			`${green("✓")} notification ${dim(`(${created.id})`)}: ${describe_notification_schedule(created.schedule)}, to ${flags.to}`
		)
	}
	if (action === "delete") {
		const id = rest_args[0]
		if (!id) throw new ApiCommandError("Usage: postboi notifications <list> delete <id>")
		await api(`${path}/${encodeURIComponent(id)}`, { method: "DELETE" })
		return say(`${green("✓")} deleted ${bold(id)}`)
	}
	if (action) {
		throw new ApiCommandError(`Unknown action: notifications ${list} ${action}. Try add or delete.`)
	}

	const { notifications: rows } = await api<{ notifications: Array<NotificationWire> }>(path)
	if (rows.length === 0) {
		return say(
			dim(
				`No notifications on ${list}. Add one: postboi notifications ${list} add --to <email> --weekly`
			)
		)
	}
	table(
		["SCHEDULE", "TO", "SUBJECT", "NEXT", "ID"],
		rows.map((n) => [
			describe_notification_schedule(n.schedule),
			n.recipients.map((r) => (typeof r === "string" ? r : r.email)).join(","),
			n.subject ?? "",
			n.next_run_at ? n.next_run_at.slice(0, 16).replace("T", " ") : "",
			dim(n.id),
		])
	)
}

// ── Testing (client previews and a report on a real send) ──────────────────

interface TestReport extends TestingRun {
	source?: string
	size?: number
	expires_at?: string
}

interface TestingClient {
	id: string
	name: string
	group?: string
	family?: string
	platform?: string
	os?: string
	dark?: boolean
	default?: boolean
}

interface TestingClients {
	data: Array<TestingClient>
	max_per_test?: number
	renders?: { left: number | null; monthly: number | null; credits: number }
}

interface ClientSet {
	id: string
	name: string
	clients: Array<string>
	created_at: string
}

/** One capture as `testing run` and `testing download` report it, and as `--json` prints it. */
export interface SavedCapture {
	run_id: string
	preview_id?: string
	client_id: string
	client_name: string
	status: string
	versus_previous: string
	path?: string
	error?: string
}

/**
 * The knobs a test turns: how often a run is polled, how long before giving up, and the
 * question asked before a big order. Tests swap these; nothing else should.
 */
export const testing_io = {
	poll_ms: 5000,
	// ponytail: the farm renders in minutes and the server settles stalled captures
	// within one; 15 min is the "request died" window.
	timeout_ms: 15 * 60_000,
	async confirm(question: string): Promise<boolean> {
		const prompts = create_prompts()
		try {
			return await prompts.confirm(question, false)
		} finally {
			prompts.close()
		}
	},
}

/** Orders above this many renders ask first on a terminal: more than a default set's worth. */
const CONFIRM_ABOVE = 10

/** A path segment from a name: the same name always lands on the same file. */
export function slug(value: string): string {
	return (
		value
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "other"
	)
}

/** `image/jpeg` → `jpg`, `image/svg+xml` → `svg`; `png` when the server didn't say. */
export function image_ext(content_type: string | null | undefined): string {
	const subtype = content_type?.split(";")[0].split("/")[1]?.split("+")[0]?.trim()
	return subtype === "jpeg" ? "jpg" : subtype || "png"
}

/** How a capture compares with the same client's capture in the previous attempt. */
export function versus_previous(preview: TestingPreview): string {
	if (preview.reused) return "reused"
	// Absent: the server predates comparisons, so there is nothing to say.
	if (preview.previous === undefined) return ""
	if (preview.previous === null) return "new"
	if (preview.previous.identical === true) return "unchanged"
	return preview.previous.identical === false ? "changed" : "unknown"
}

function run_status_colour(status: string): string {
	return status === "received" ? green(status) : status === "expired" ? red(status) : yellow(status)
}

function preview_status_colour(status: string): string {
	return status === "ready" ? green(status) : status === "failed" ? red(status) : yellow(status)
}

/** The run's dashboard page: the server's own link (it names the team), else a guess. */
function run_url(run: { id: string; url?: string }): string {
	return run.url ?? `${cloud_base()}/dashboard/testing/${run.id}`
}

/**
 * A run's previews. A current server carries them on the run, ids and image paths
 * included; an older one only on `/previews`, so that is asked as well.
 */
async function previews_of(run: TestingRun): Promise<Array<TestingPreview>> {
	if (run.screenshots) return run.previews ?? []
	const { data } = await api<{ data: Array<TestingPreview> }>(`/v1/testing/${run.id}/previews`)
	return data
}

/**
 * Poll runs until every screenshot has settled, with one live progress line on a
 * terminal and nothing otherwise. Answers each run with its previews.
 */
async function settle(
	ids: Array<string>
): Promise<Array<{ run: TestingRun; previews: Array<TestingPreview> }>> {
	const live = stdout.isTTY && !json_mode
	const counts = new Map<string, { ready: number; failed: number; total: number }>()
	function progress(): void {
		if (!live) return
		const sum = { ready: 0, failed: 0, total: 0 }
		for (const c of counts.values()) {
			sum.ready += c.ready
			sum.failed += c.failed
			sum.total += c.total
		}
		const failed = sum.failed ? `, ${sum.failed} failed` : ""
		stdout.write(
			`\r\x1b[2K  ${dim(`rendering: ${sum.ready} of ${sum.total || "?"} ready${failed}`)}`
		)
	}
	const started = Date.now()
	try {
		return await Promise.all(
			ids.map(async (id) => {
				for (;;) {
					const run = await api<TestingRun>(`/v1/testing/${encodeURIComponent(id)}`)
					const previews = await previews_of(run)
					const rows = { ...run, previews }
					counts.set(id, {
						ready: previews.filter((p) => p.status === "ready").length,
						failed: previews.filter((p) => p.status === "failed").length,
						total: run.screenshots?.total ?? previews.length,
					})
					progress()
					if (screenshots_settled(rows, Date.now() - started)) return { run, previews }
					if (Date.now() - started >= testing_io.timeout_ms) {
						const minutes = Math.round(testing_io.timeout_ms / 60_000)
						throw new ApiCommandError(
							`Run ${id} is still rendering after ${minutes} min. Collect it later with \`postboi testing download ${id}\`.`,
							"timeout"
						)
					}
					await new Promise((resolve) => setTimeout(resolve, testing_io.poll_ms))
				}
			})
		)
	} finally {
		if (live) stdout.write("\r\x1b[2K")
	}
}

/**
 * Save every ready capture to `<out>/<group>/<client>.<ext>`. No timestamps: a re-run
 * overwrites the same files, so git and any visual diff show what moved. Two clients
 * with the same name (a light and a dark variant, say) fall back to their ids.
 */
async function save_captures(
	settled: Array<{ run: TestingRun; previews: Array<TestingPreview> }>,
	out: string,
	catalog: Array<TestingClient> | undefined
): Promise<Array<SavedCapture>> {
	const all = settled.flatMap(({ run, previews }) => previews.map((preview) => ({ run, preview })))
	const name_of = (p: TestingPreview) => p.client_name ?? p.name ?? p.client_id ?? p.client ?? ""
	const id_of = (p: TestingPreview) => p.client_id ?? p.client ?? ""
	const seen = new Map<string, number>()
	for (const { preview } of all) {
		const key = slug(name_of(preview))
		seen.set(key, (seen.get(key) ?? 0) + 1)
	}
	const groups = new Map((catalog ?? []).map((c) => [c.id, c.group ?? c.platform]))

	async function save_one({
		run,
		preview,
	}: {
		run: TestingRun
		preview: TestingPreview
	}): Promise<SavedCapture> {
		const base: SavedCapture = {
			run_id: run.id,
			preview_id: preview.id,
			client_id: id_of(preview),
			client_name: name_of(preview),
			status: preview.status,
			versus_previous: versus_previous(preview),
			error: preview.error,
		}
		if (preview.status !== "ready" || !preview.url) return base
		const image = await api_file(preview.url.replace(/^https?:\/\/[^/]+/, ""))
		const group = slug(preview.group ?? groups.get(id_of(preview)) ?? preview.platform ?? "other")
		const name_slug = slug(name_of(preview))
		const file = (seen.get(name_slug) ?? 0) > 1 ? slug(id_of(preview)) : name_slug
		const path = join(out, group, `${file}.${image_ext(image.content_type)}`)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, image.bytes)
		return { ...base, path }
	}

	// A few at a time: `--all` would otherwise open a hundred image requests at once.
	const saved: Array<SavedCapture> = []
	for (let i = 0; i < all.length; i += 6) {
		saved.push(...(await Promise.all(all.slice(i, i + 6).map(save_one))))
	}
	return saved
}

/**
 * The end of `run` and `download`: the captures, the report, where to look, and the exit
 * code: 1 when the report is an error or a capture failed, so CI can gate on it.
 */
function finish(
	series: string,
	out: string,
	settled: Array<{ run: TestingRun; previews: Array<TestingPreview> }>,
	captures: Array<SavedCapture>,
	shares: Array<string>
): void {
	const runs = settled.map(({ run }) => run)
	const report = runs.find((run) => run.report)?.report
	const used = runs.reduce((sum, run) => sum + (run.renders?.used ?? 0), 0)
	const failed = captures.some((capture) => capture.status === "failed")
	if (report?.status === "error" || failed) process.exitCode = 1

	if (captures.length) {
		table(
			["CLIENT", "STATUS", "VS PREVIOUS", "FILE"],
			captures.map((c) => [
				c.client_name,
				preview_status_colour(c.status),
				c.versus_previous,
				c.path ?? dim(c.error ?? ""),
			])
		)
		say()
	}
	for (const note of runs.flatMap((run) => run.screenshots?.notes ?? [])) say(`  ${yellow(note)}`)
	if (report) {
		const n = report.findings?.length ?? 0
		const colour = report.status === "error" ? red : report.status === "pass" ? green : yellow
		say(`  report   ${colour(report.status)}, ${n} finding${n === 1 ? "" : "s"}`)
	}
	if (runs.some((run) => run.renders)) say(`  renders  ${used} used`)
	for (const run of runs) say(`  ${dim("dashboard")} ${cyan(run_url(run))}`)
	for (const link of shares) say(`  ${dim("share")}     ${cyan(link)}`)

	last_response = {
		series,
		out,
		runs,
		captures,
		renders: { used },
		share_urls: shares,
	}
}

async function share_links(ids: Array<string>): Promise<Array<string>> {
	return Promise.all(
		ids.map(async (id) => {
			const answer = await api<{ share_url: string }>(
				`/v1/testing/${encodeURIComponent(id)}/share`,
				{ method: "POST" }
			)
			return answer.share_url
		})
	)
}

const RUN_USAGE = [
	"Usage: postboi testing run <file.html or -> [--subject <s>] [--text <file>] [--series <name>]",
	"         [--clients a,b | --set <name> | --all] [--fresh] [--out <dir>] [--no-wait] [--share] [--yes] [--json]",
].join("\n")

/**
 * `testing run`: built HTML in, screenshots on disk. Orders the run (batched past the
 * per-run cap, all in one series), pastes the HTML, waits for every capture, saves them
 * under `--out`, and sums it up.
 */
async function testing_run(args: Array<string>): Promise<void> {
	const { flags, rest, on } = take_flags(
		args,
		["subject", "text", "series", "clients", "set", "out"],
		["all", "fresh", "no-wait", "share", "yes"]
	)
	const file = rest[0]
	const pickers = [flags.clients, flags.set, on.has("all") || undefined].filter(Boolean)
	if (!file || rest.length > 1 || pickers.length > 1) throw new ApiCommandError(RUN_USAGE)

	const html = file === "-" ? readFileSync(stdin.fd, "utf8") : readFileSync(file, "utf8")
	const text = flags.text ? readFileSync(flags.text, "utf8") : undefined
	const series =
		flags.series || (file === "-" ? flags.subject || "email" : basename(file, extname(file)))
	const subject =
		flags.subject ??
		(html_to_text(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "") || series)
	const out = flags.out || join("screenshots", slug(series))

	const clients = await api<TestingClients>("/v1/testing/clients")
	const max = clients.max_per_test ?? 25
	// No picker means the curated default, said explicitly: a continued series would
	// otherwise keep its previous pick (after `--all`, just the last batch's clients).
	const defaults = clients.data.filter((c) => c.default).map((c) => c.id)
	let batches: Array<Array<string> | undefined> = [defaults.length ? defaults : undefined]
	let estimate = defaults.length
	if (on.has("all") || flags.clients) {
		const ids = on.has("all")
			? clients.data.map((c) => c.id)
			: flags.clients.split(",").map((c) => c.trim())
		if (!ids.length) throw new ApiCommandError("No screenshot clients on this server to order.")
		batches = Array.from({ length: Math.ceil(ids.length / max) }, (_, i) =>
			ids.slice(i * max, (i + 1) * max)
		)
		estimate = ids.length
	} else if (flags.set) {
		// Only for the estimate: the server resolves the set itself and names the
		// known ones when this one doesn't exist.
		const sets = await api<{ data: Array<ClientSet> }>("/v1/testing/sets").catch(() => undefined)
		const found = sets?.data.find((s) => s.name.toLowerCase() === flags.set.toLowerCase())
		if (found) estimate = found.clients.length
	}

	const left = clients.renders?.left
	if (typeof left === "number" && estimate > left) {
		const skipped = estimate - left
		say(
			yellow(
				`Only ${left} render${left === 1 ? "" : "s"} left: ${skipped} client${skipped === 1 ? "" : "s"} will be skipped. Top up on the dashboard's Testing page.`
			)
		)
	}
	if (estimate > CONFIRM_ABOVE && !on.has("yes") && !json_mode && stdin.isTTY && stdout.isTTY) {
		const ok = await testing_io.confirm(`Order up to ${estimate} renders?`)
		if (!ok) throw new ApiCommandError("Nothing ordered.", "cancelled")
	}

	async function order(ids: Array<string> | undefined): Promise<TestingRun> {
		const run = await api<TestingRun>("/v1/testing", {
			method: "POST",
			body: {
				series,
				clients: ids,
				set: flags.set,
				fresh: on.has("fresh") || undefined,
			},
		})
		await api(`/v1/testing/${run.id}/source`, {
			method: "POST",
			body: { subject, html, text },
		})
		say(`${green("✓")} ${bold(run.id)} ${dim(`${ids ? `${ids.length} clients` : "pasted"}`)}`)
		return run
	}
	// The first batch goes alone: it starts the series entry the others then join, where
	// starting them together would race to start one entry each.
	const first = await order(batches[0])
	const runs = [first, ...(await Promise.all(batches.slice(1).map(order)))]

	if (on.has("no-wait")) {
		const shares = on.has("share") ? await share_links(runs.map((r) => r.id)) : []
		for (const run of runs) {
			say(`  ${dim("dashboard")} ${cyan(run_url(run))}`)
			say(`  ${dim(`postboi testing download ${run.id} collects the screenshots.`)}`)
		}
		for (const link of shares) say(`  ${dim("share")}     ${cyan(link)}`)
		last_response = { series, out, runs, share_urls: shares }
		return
	}

	const settled = await settle(runs.map((run) => run.id))
	const captures = await save_captures(settled, out, clients.data)
	const shares = on.has("share") ? await share_links(runs.map((r) => r.id)) : []
	finish(series, out, settled, captures, shares)
}

/** `testing download <id>`: wait out an existing run and collect its captures. */
async function testing_download(args: Array<string>): Promise<void> {
	const { flags, rest } = take_flags(args, ["out"])
	const id = rest[0]
	if (!id || rest.length > 1) {
		throw new ApiCommandError("Usage: postboi testing download <id> [--out <dir>]")
	}
	const settled = await settle([id])
	const run = settled[0].run
	const series = run.label ?? run.id
	const out = flags.out || join("screenshots", slug(series))
	// Older servers leave the group off a preview; the catalog has it.
	const needs_catalog = settled[0].previews.some((p) => !p.group)
	const catalog = needs_catalog
		? (await api<TestingClients>("/v1/testing/clients").catch(() => undefined))?.data
		: undefined
	const captures = await save_captures(settled, out, catalog)
	finish(series, out, settled, captures, [])
}

/** `testing sets`: the saved client sets `--set` names. */
async function testing_sets(args: Array<string>): Promise<void> {
	const [action, ...rest_args] = args
	if (action === "save") {
		const { flags, rest } = take_flags(rest_args, ["clients"])
		const name = rest.join(" ").trim()
		if (!name || !flags.clients) {
			throw new ApiCommandError("Usage: postboi testing sets save <name> --clients a,b")
		}
		const set = await api<ClientSet>("/v1/testing/sets", {
			method: "POST",
			body: { name, clients: flags.clients.split(",").map((c) => c.trim()) },
		})
		return say(`${green("✓")} saved ${bold(set.name)} ${dim(`(${set.clients.length} clients)`)}`)
	}
	if (action === "delete") {
		const ref = rest_args.join(" ").trim()
		if (!ref) throw new ApiCommandError("Usage: postboi testing sets delete <name or id>")
		const { data } = await api<{ data: Array<ClientSet> }>("/v1/testing/sets")
		const set = data.find((s) => s.id === ref || s.name.toLowerCase() === ref.toLowerCase())
		if (!set) throw new ApiCommandError(`No client set called ${ref}.`, "not_found")
		await api(`/v1/testing/sets/${encodeURIComponent(set.id)}`, { method: "DELETE" })
		return say(`${green("✓")} deleted ${bold(set.name)}`)
	}
	if (action)
		throw new ApiCommandError(`Unknown action: testing sets ${action}. Try save or delete.`)

	const { data } = await api<{ data: Array<ClientSet> }>("/v1/testing/sets")
	if (data.length === 0) {
		return say(dim("No client sets yet. Save one: postboi testing sets save <name> --clients a,b"))
	}
	table(
		["NAME", "CLIENTS", "ID"],
		data.map((s) => [bold(s.name), s.clients.join(", "), dim(s.id)])
	)
}

/**
 * Email testing: `testing run` takes built HTML to screenshots on disk; `testing add`
 * mints an address to send a real email to; `testing <id>` reads the report back:
 * authentication, the inspect findings, a spam score and the client screenshots.
 */
async function testing(args: Array<string>): Promise<void> {
	const [action, ...rest_args] = args

	if (action === "run") return testing_run(rest_args)
	if (action === "download") return testing_download(rest_args)
	if (action === "sets") return testing_sets(rest_args)
	if (action === "add") {
		const { flags, rest } = take_flags(rest_args, [
			"label",
			"series",
			"clients",
			"set",
			"html",
			"subject",
		])
		if (rest.length || (flags.clients && flags.set)) {
			throw new ApiCommandError(
				"Usage: postboi testing add [--label <name>] [--series <name>] [--clients a,b or --set <name>] [--html <file> [--subject <s>]]"
			)
		}
		const run = await api<TestReport>("/v1/testing", {
			method: "POST",
			body: {
				label: flags.label,
				series: flags.series,
				clients: flags.clients ? flags.clients.split(",").map((c) => c.trim()) : undefined,
				set: flags.set,
			},
		})
		say(`${green("✓")} test ${bold(run.id)}${run.label ? dim(` (${run.label})`) : ""}`)
		if (flags.html) {
			const html =
				flags.html === "-" ? readFileSync(stdin.fd, "utf8") : readFileSync(flags.html, "utf8")
			await api(`/v1/testing/${run.id}/source`, {
				method: "POST",
				body: { subject: flags.subject, html },
			})
			say(`  ${dim("pasted")} ${flags.html}`)
			say(`  ${dim("dashboard")} ${cyan(run_url(run))}`)
			return say(`  ${dim(`postboi testing download ${run.id} collects the screenshots.`)}`)
		}
		say(`  ${dim("send the email to:")} ${cyan(run.address ?? "")}`)
		if (run.expires_at)
			say(`  ${dim(`waiting until ${run.expires_at.slice(0, 16).replace("T", " ")}`)}`)
		return say(`  ${dim(`postboi testing ${run.id} reads the report once it lands.`)}`)
	}
	if (action === "clients") {
		const { data, max_per_test, renders } = await api<TestingClients>("/v1/testing/clients")
		table(
			["ID", "NAME", "GROUP", "PLATFORM", "OS", "DARK", "DEFAULT"],
			data.map((c) => [
				c.id,
				c.name,
				c.group ?? "",
				c.platform ?? "",
				c.os ?? "",
				c.dark ? "dark" : "",
				c.default ? green("yes") : "",
			])
		)
		if (renders) {
			say(`\n${dim("Renders left:")} ${renders.left === null ? "unlimited" : renders.left}`)
		}
		if (max_per_test)
			say(
				dim(
					`${renders ? "" : "\n"}Up to ${max_per_test} per test: postboi testing run <file> --clients a,b`
				)
			)
		return
	}
	if (action === "share") {
		const { rest, on } = take_flags(rest_args, [], ["revoke"])
		const id = rest[0]
		if (!id) throw new ApiCommandError("Usage: postboi testing share <id> [--revoke]")
		const path = `/v1/testing/${encodeURIComponent(id)}/share`
		if (on.has("revoke")) {
			await api(path, { method: "DELETE" })
			return say(`${green("✓")} the share link for ${bold(id)} no longer opens`)
		}
		const { share_url } = await api<{ share_url: string }>(path, { method: "POST" })
		return say(`${green("✓")} anyone with this link can read ${bold(id)}: ${cyan(share_url)}`)
	}
	if (action === "delete") {
		const id = rest_args[0]
		if (!id) throw new ApiCommandError("Usage: postboi testing delete <id>")
		await api(`/v1/testing/${encodeURIComponent(id)}`, { method: "DELETE" })
		return say(`${green("✓")} deleted ${bold(id)}`)
	}
	if (action) {
		const t = await api<TestReport>(`/v1/testing/${encodeURIComponent(action)}`)
		say(`${bold(t.label ?? t.id)} ${dim(`(${t.id})`)}`)
		say(`  status   ${run_status_colour(t.status)}`)
		if (t.status === "waiting") {
			return say(`  ${dim("send the email to:")} ${cyan(t.address ?? "")}`)
		}
		if (t.from) say(`  from     ${t.from}`)
		if (t.subject) say(`  subject  ${t.subject}`)
		if (t.authentication) {
			const a = t.authentication
			const mark = (v: string | null | undefined) =>
				v === "pass" ? green("pass") : v ? red(v) : dim("none")
			say(`  auth     spf ${mark(a.spf)} · dkim ${mark(a.dkim)} · dmarc ${mark(a.dmarc)}`)
		}
		if (t.spam) say(`  spam     score ${t.spam.score ?? "?"}`)
		if (t.report?.findings?.length) {
			say(`  findings ${t.report.status ?? ""}`)
			for (const f of t.report.findings as Array<{
				severity?: string
				level?: string
				title?: string
				message?: string
			}>) {
				const level = f.severity ?? f.level
				say(`    ${level === "error" ? red("✗") : yellow("!")} ${f.title ?? f.message ?? ""}`)
			}
		}
		for (const note of t.screenshots?.notes ?? []) say(`  ${yellow(note)}`)
		if (t.url) say(`  ${dim("dashboard")} ${cyan(t.url)}`)
		if (t.previews?.length) {
			say()
			table(
				["CLIENT", "PREVIEW", "NOTE"],
				t.previews.map((p) => [
					p.client_name ?? p.name ?? "",
					preview_status_colour(p.status),
					dim(p.error ?? ""),
				])
			)
		}
		return
	}

	const { data: rows } = await api<{ data: Array<TestReport> }>("/v1/testing")
	if (rows.length === 0) return say(dim("No tests yet. Try: postboi testing run email.html"))
	table(
		["LABEL", "STATUS", "SUBJECT", "WHEN", "ID"],
		rows.map((t) => [
			t.label ?? "",
			run_status_colour(t.status),
			t.subject ?? "",
			(t.created_at ?? "").slice(0, 16).replace("T", " "),
			dim(t.id),
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
	forms,
	notifications,
	testing,
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
	"forms",
	"testing",
])

/** Handle a resource command; false when `command` isn't one (main falls through to help). */
export async function api_command(command: string, args: Array<string>): Promise<boolean> {
	const handler = COMMANDS[command]
	if (!handler) return false
	// Flags a command doesn't know fall through as arguments, so `--help` would be read
	// as a file or an id. Answer it here, once, for every command.
	if (args.includes("--help") || args.includes("-h")) {
		console.log(command_help(command) ?? help_text())
		return true
	}
	json_mode = args.includes("--json")
	last_response = undefined
	const rest = args.filter((arg) => arg !== "--json")
	try {
		await handler(LISTING.has(command) && rest[0] === "list" ? rest.slice(1) : rest)
		// A command that put a file on stdout (`exports download --out -`) leaves no
		// response to print, and printing `null` after the bytes would corrupt the file.
		if (json_mode && last_response !== undefined) {
			console.log(JSON.stringify(last_response, null, 2))
		}
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
