import { stdout } from "node:process"
import { ensure_env_loaded, read_env } from "../library/env.js"
import { cloud_base, open_browser, type PostboiDomain } from "./postboi.js"
import { bold, cyan, dim, green, red, yellow } from "./prompts.js"

/**
 * The resource commands (`postboi lists`, `postboi domains add …`) — thin wrappers over
 * the /v1 API, authed with the POSTBOI_TOKEN that `postboi init` wrote. Full reference:
 * https://api.postboi.email
 */

/** A failure with a message safe to print as-is — main() prints it red and exits 1. */
export class ApiCommandError extends Error {}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

async function api<T>(
	path: string,
	init: { method?: string; body?: unknown } = {},
	fetch_fn: FetchLike = fetch
): Promise<T> {
	await ensure_env_loaded()
	const token = read_env("POSTBOI_TOKEN")
	if (!token) {
		throw new ApiCommandError("No POSTBOI_TOKEN found — run `postboi init` to sign in first.")
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
		throw new ApiCommandError(`Could not reach ${cloud_base()} (${reason}). Are you online?`)
	}
	const data = (await response.json().catch(() => undefined)) as
		| (T & { message?: string })
		| undefined
	if (!response.ok) {
		throw new ApiCommandError(data?.message ?? `The API responded with ${response.status}.`)
	}
	if (data === undefined) throw new ApiCommandError("Unexpected empty response from the API.")
	return data
}

/** Visible width — cells may carry ANSI colour codes that padEnd would count. */
function width(value: string): number {
	// eslint-disable-next-line no-control-regex
	return value.replace(/\x1b\[[0-9;]*m/g, "").length
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
	console.log(dim(line(header)))
	for (const row of rows) console.log(line(row))
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
	}>("/v1/account")
	console.log(`${bold(account.name ?? "My Team")} ${dim(`(${account.id})`)}`)
	console.log(`  plan          ${account.plan}`)
	console.log(`  send address  ${account.send_address}`)
	console.log(
		`  sends         ${account.sends_today} today, ${account.sends_this_month} this month`
	)
	if (account.suspended) console.log(`  ${red("suspended — contact support@postboi.email")}`)
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
		return console.log(`${dim("Send address:")} ${account.send_address}`)
	}
	const updated = await api<{ send_address: string }>("/v1/account", {
		method: "PATCH",
		body: { send_address: address },
	})
	console.log(`${green("✓")} send address set to ${bold(updated.send_address)}`)
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
		return console.log(`${green("✓")} created ${bold(list.name)} ${dim(`(${list.id})`)}`)
	}
	if (action === "delete") {
		const ref = rest.join(" ").trim()
		if (!ref) throw new ApiCommandError("Usage: postboi lists delete <name or id>")
		const gone = await api<{ id: string }>(`/v1/lists/${encodeURIComponent(ref)}`, {
			method: "DELETE",
		})
		return console.log(`${green("✓")} deleted ${bold(ref)} ${dim(`(${gone.id})`)}`)
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
	if (rows.length === 0) return console.log(dim("No lists yet — postboi lists add <name>"))
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
		return console.log(`${green("✓")} added ${result.added}, updated ${result.updated}${pending}`)
	}
	if (action === "remove") {
		const email = emails[0]
		if (!email) throw new ApiCommandError("Usage: postboi recipients <list> remove <email>")
		await api(`${path}?email=${encodeURIComponent(email)}`, { method: "DELETE" })
		return console.log(`${green("✓")} removed ${bold(email)}`)
	}
	if (action) throw new ApiCommandError(`Unknown action: recipients ${action}. Try add or remove.`)

	const list = await api<{
		name: string
		recipients: Array<{ email: string; name?: string; status: string }>
	}>(`/v1/lists/${encodeURIComponent(ref)}`)
	if (list.recipients.length === 0) return console.log(dim(`${list.name} has no recipients yet.`))
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
	names: Array<string>
): { flags: Record<string, string>; rest: Array<string> } {
	const flags: Record<string, string> = {}
	const rest: Array<string> = []
	for (let i = 0; i < args.length; i++) {
		const match = names.find((name) => args[i] === `--${name}`)
		if (match) {
			flags[match] = args[++i] ?? ""
		} else {
			rest.push(args[i])
		}
	}
	return { flags, rest }
}

interface ContactWire {
	email: string
	name?: string
	data?: Record<string, string>
	created_at: string
	updated_at: string
}

async function contacts(args: Array<string>): Promise<void> {
	const [action, ...rest_args] = args

	if (action === "add") {
		const { flags, rest } = take_flags(rest_args, ["name", "data"])
		const email = rest[0]
		if (!email) {
			throw new ApiCommandError(
				"Usage: postboi contacts add <email> [--name <name>] [--data <json>]"
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
			body: { email, name: flags.name, data },
		})
		return console.log(`${green("✓")} saved ${bold(contact.email)}`)
	}

	if (action === "remove") {
		const email = rest_args[0]
		if (!email) throw new ApiCommandError("Usage: postboi contacts remove <email>")
		await api(`/v1/contacts/${encodeURIComponent(email)}`, { method: "DELETE" })
		return console.log(`${green("✓")} removed ${bold(email)}`)
	}

	// A bare `contacts <email>` shows one contact and the lists it's on.
	if (action) {
		const contact = await api<
			ContactWire & {
				memberships: Array<{ list: { name: string }; status: string; created_at: string }>
			}
		>(`/v1/contacts/${encodeURIComponent(action)}`)
		console.log(`${bold(contact.email)}${contact.name ? dim(` (${contact.name})`) : ""}`)
		if (contact.data && Object.keys(contact.data).length > 0) {
			console.log(`  ${dim("data:")} ${JSON.stringify(contact.data)}`)
		}
		if (contact.memberships.length === 0) return console.log(dim("  On no lists."))
		console.log()
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
	if (rows.length === 0) return console.log(dim("No contacts yet — postboi contacts add <email>"))
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
		return console.log(`${green("✓")} ${bold(detail.domain)} is verified`)
	}
	console.log(`${yellow("⌛")} ${bold(detail.domain)} is ${detail.status}`)
	if (detail.records.length > 0) {
		console.log(`\n${bold("Publish these DNS records:")}\n`)
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
		console.log(`\n${bold(`One-click setup at ${setup.provider}:`)}${dim(dmarc)}\n`)
		console.log(`  ${cyan(setup.connect_url)}\n`)
		if (stdout.isTTY && open_browser(setup.connect_url)) {
			console.log(dim("  (opening in your default browser)"))
		}
	} else if (setup?.manage_url) {
		console.log(
			`\n${dim(`Add them in your ${setup.provider} DNS console:`)} ${cyan(setup.manage_url)}`
		)
	}
	console.log(`\n${dim("Then:")} ${cyan(`bunx postboi domains check ${detail.domain}`)}`)
}

async function domains(args: Array<string>): Promise<void> {
	const [action, ref] = args
	if (action === "add") {
		if (!ref) throw new ApiCommandError("Usage: postboi domains add <domain>")
		const detail = await api<DomainDetail>("/v1/domains", { method: "POST", body: { domain: ref } })
		console.log(`${green("✓")} registered ${bold(detail.domain)}\n`)
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
		return console.log(
			`${green("✓")} removed ${bold(ref)} ${dim("(DNS records at your registrar are untouched)")}`
		)
	}
	if (action) {
		throw new ApiCommandError(`Unknown action: domains ${action}. Try add, check, or delete.`)
	}

	const identity = await api<{ send_address: string; domains: Array<PostboiDomain> }>("/v1/domains")
	console.log(`${dim("Send address:")} ${identity.send_address}\n`)
	if (identity.domains.length === 0) {
		return console.log(dim("No custom domains yet — postboi domains add <domain>"))
	}
	table(
		["DOMAIN", "STATUS"],
		identity.domains.map((d) => [
			d.domain,
			d.status === "verified" ? green(d.status) : yellow(d.status),
		])
	)
	if (identity.domains.some((d) => d.status !== "verified")) {
		console.log(
			`\n${dim("Pending? See its records:")} ${cyan("bunx postboi domains check <domain>")}`
		)
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
		console.log(`${green("✓")} created ${bold(endpoint.url)} ${dim(`(${endpoint.id})`)}`)
		console.log(`  ${dim("secret:")} ${endpoint.secret}`)
		return console.log(
			`  ${dim("`postboi sync` writes it to POSTBOI_WEBHOOK_SECRET for receive().")}`
		)
	}
	if (action === "delete") {
		if (!ref) throw new ApiCommandError("Usage: postboi webhooks delete <id>")
		await api(`/v1/webhooks/${encodeURIComponent(ref)}`, { method: "DELETE" })
		return console.log(`${green("✓")} deleted ${bold(ref)}`)
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
		if (deliveries.length === 0) return console.log(dim("No deliveries yet."))
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
	if (rows.length === 0) return console.log(dim("No webhooks yet — postboi webhooks add <url>"))
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
		return console.log(
			`${green("✓")} invited ${bold(invite.email)} ${dim(`(expires ${day(invite.expires_at)})`)}`
		)
	}
	if (action === "remove") {
		if (!ref) throw new ApiCommandError("Usage: postboi members remove <email or user id>")
		const gone = await api<{ email: string }>(`/v1/members/${encodeURIComponent(ref)}`, {
			method: "DELETE",
		})
		return console.log(`${green("✓")} removed ${bold(gone.email)}`)
	}
	if (action === "revoke") {
		if (!ref) throw new ApiCommandError("Usage: postboi members revoke <email or invite id>")
		const gone = await api<{ email: string }>(`/v1/members/invites/${encodeURIComponent(ref)}`, {
			method: "DELETE",
		})
		return console.log(`${green("✓")} revoked the invite for ${bold(gone.email)}`)
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
		console.log(
			`  ${invite.email}  ${yellow("invited")} ${dim(`(expires ${day(invite.expires_at)})`)}`
		)
	}
}

// ── Messages & suppressions ────────────────────────────────────────────────

async function messages(args: Array<string>): Promise<void> {
	const status = args[0]
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
	if (rows.length === 0) return console.log(dim("No messages."))
	table(
		["WHEN", "TO", "SUBJECT", "STATUS", "ID"],
		rows.map((m) => [
			m.created_at.slice(0, 16).replace("T", " "),
			m.to.join(","),
			m.subject,
			m.status === "delivered" || m.status === "sent"
				? green(m.status)
				: ["bounced", "complained", "failed", "rejected"].includes(m.status)
					? red(m.status)
					: yellow(m.status),
			dim(m.id),
		])
	)
}

async function suppressions(args: Array<string>): Promise<void> {
	const [action, email] = args
	if (action === "add") {
		if (!email) throw new ApiCommandError("Usage: postboi suppressions add <email>")
		await api("/v1/suppressions", { method: "POST", body: { email } })
		return console.log(`${green("✓")} suppressed ${bold(email)}`)
	}
	if (action === "remove") {
		if (!email) throw new ApiCommandError("Usage: postboi suppressions remove <email>")
		await api(`/v1/suppressions?email=${encodeURIComponent(email)}`, { method: "DELETE" })
		return console.log(`${green("✓")} unsuppressed ${bold(email)}`)
	}
	if (action) {
		throw new ApiCommandError(`Unknown action: suppressions ${action}. Try add or remove.`)
	}

	const { suppressions: rows } = await api<{
		suppressions: Array<{ email: string; reason: string; created_at: string }>
	}>("/v1/suppressions")
	if (rows.length === 0) return console.log(dim("No suppressed addresses."))
	table(
		["EMAIL", "REASON", "SINCE"],
		rows.map((s) => [s.email, s.reason, day(s.created_at)])
	)
}

// ── Dispatch ───────────────────────────────────────────────────────────────

const COMMANDS: Record<string, (args: Array<string>) => Promise<void>> = {
	whoami: () => whoami(),
	"send-address": send_address,
	lists,
	recipients,
	contacts,
	domains,
	webhooks,
	members,
	messages,
	suppressions,
}

/** Handle a resource command; false when `command` isn't one (main falls through to help). */
export async function api_command(command: string, args: Array<string>): Promise<boolean> {
	const handler = COMMANDS[command]
	if (!handler) return false
	await handler(args)
	return true
}
