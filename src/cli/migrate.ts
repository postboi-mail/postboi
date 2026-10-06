import { ensure_env_loaded, read_env } from "../library/env.js"
import {
	api,
	ApiCommandError,
	postboi_token,
	print_domain_setup,
	table,
	take_flags,
	type DomainDetail,
} from "./api.js"
import { bold, cyan, dim, green, red, yellow } from "./prompts.js"

/**
 * `postboi migrate resend`: read a Resend account with its own API key and recreate what
 * Postboi can hold, so moving over is one command rather than an afternoon of copying.
 *
 * What moves, and what honestly can't:
 * - **Domains** are registered on Postboi and their DNS records printed. The DKIM keys are
 *   Postboi's own, so they go beside Resend's and nothing stops sending until the swap.
 * - **Audiences** become lists, contacts become recipients with `?status=subscribed` so
 *   nobody is re-confirmed, and Resend's unsubscribed contacts land unsubscribed here too.
 * - **Webhooks** are re-registered at the same URLs with the same events in Postboi's
 *   names, each with a fresh secret. Events Postboi doesn't emit are dropped and said.
 * - **Templates, API keys and the suppression list** stay where they are: Postboi has no
 *   templates API, a key is never exportable, and Resend's API offers no suppression
 *   export. The command says so rather than pretending.
 *
 * Re-running is safe: a domain, list or webhook that is already here is skipped by name
 * or URL, and recipients upsert. `--dry-run` reads Resend and writes nothing.
 *
 * One refusal never stops the rest: a domain another account owns, a list over quota or a
 * webhook URL Postboi won't take is recorded on its own row (`error`) and said, the run
 * carries on, and the exit code is 1 at the end so a script knows something was left.
 */

const RESEND = "https://api.resend.com"

/** Resend's webhook events in Postboi's names; undefined is one Postboi doesn't emit. */
export const RESEND_EVENTS: Record<string, string | undefined> = {
	"email.sent": "email.sent",
	"email.delivered": "email.delivered",
	"email.bounced": "email.bounced",
	"email.complained": "email.complained",
	"email.opened": "email.opened",
	"email.clicked": "email.clicked",
	"email.failed": "email.failed",
	"email.received": "email.received",
	// A delay is on the message's timeline on Postboi, not a webhook; the rest are about
	// things Postboi doesn't fire events for.
	"email.delivery_delayed": undefined,
	"email.scheduled": undefined,
	"email.suppressed": undefined,
}

/** Resend's event names as Postboi's, and the ones that have no equivalent. */
export function map_events(events: Array<string>): {
	events: Array<string>
	dropped: Array<string>
} {
	const kept: Array<string> = []
	const dropped: Array<string> = []
	for (const event of events) {
		const mapped = RESEND_EVENTS[event]
		if (mapped) kept.push(mapped)
		else dropped.push(event)
	}
	return { events: [...new Set(kept)], dropped }
}

interface ResendDomain {
	id: string
	name: string
	status: string
}
interface ResendAudience {
	id: string
	name: string
}
interface ResendContact {
	id: string
	email: string
	first_name?: string | null
	last_name?: string | null
	unsubscribed?: boolean
}
interface ResendWebhook {
	id: string
	endpoint: string
	events: Array<string>
	status?: string
}

export interface Recipient {
	email: string
	name?: string
}

/** What was read from Resend, before anything is written. */
export interface MigrationPlan {
	domains: Array<{ name: string; status: string }>
	lists: Array<{ name: string; subscribed: Array<Recipient>; unsubscribed: Array<Recipient> }>
	webhooks: Array<{ url: string; events: Array<string>; dropped: Array<string>; disabled: boolean }>
}

/** What the run did, for `--json` and the closing summary. */
export interface MigrationSummary {
	dry_run: boolean
	/** What was read from Resend, which under `--dry-run` is the whole answer. */
	plan: {
		domains: MigrationPlan["domains"]
		lists: Array<{ name: string; subscribed: number; unsubscribed: number }>
		webhooks: MigrationPlan["webhooks"]
	}
	domains: Array<{
		domain: string
		status?: string
		existed: boolean
		/** The DNS records still to publish, when the domain was registered by this run. */
		records?: DomainDetail["records"]
		/** Why Postboi refused it, when it did; the rest of the run went on. */
		error?: string
	}>
	lists: Array<{
		name: string
		added: number
		updated: number
		unsubscribed: number
		existed: boolean
		error?: string
	}>
	webhooks: Array<{
		url: string
		events: Array<string>
		dropped: Array<string>
		id?: string
		secret?: string
		skipped?: string
		error?: string
	}>
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Every page of a Resend list. Newer endpoints page with `has_more` and `after`; older ones answer whole. */
async function resend_list<T extends { id: string }>(
	path: string,
	key: string,
	fetch_fn: FetchLike
): Promise<Array<T>> {
	const rows: Array<T> = []
	let after: string | undefined
	for (;;) {
		const query = `limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`
		let response: Response
		try {
			response = await fetch_fn(`${RESEND}${path}?${query}`, {
				headers: { Authorization: `Bearer ${key}` },
			})
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			throw new ApiCommandError(
				`Could not reach Resend (${reason}). Are you online?`,
				"unreachable"
			)
		}
		if (response.status === 401 || response.status === 403) {
			throw new ApiCommandError(
				"Resend refused the key. Pass a full-access key with --key, or set RESEND_API_KEY.",
				"resend_unauthorized"
			)
		}
		const body = (await response.json().catch(() => undefined)) as
			| { data?: Array<T>; has_more?: boolean; message?: string }
			| undefined
		if (!response.ok) {
			throw new ApiCommandError(
				`Resend answered ${response.status} for ${path}${body?.message ? `: ${body.message}` : "."}`,
				"resend_error"
			)
		}
		const page = body?.data ?? []
		rows.push(...page)
		const last = page.at(-1)
		// A cursor that didn't move is an endpoint ignoring `after`; stop rather than spin.
		if (!body?.has_more || !last || last.id === after) return rows
		after = last.id
	}
}

function contact_name(contact: ResendContact): string | undefined {
	const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim()
	return name || undefined
}

/** Read the account: domains, audiences with their contacts, and webhooks. Writes nothing. */
export async function read_resend(
	key: string,
	only: Set<string>,
	fetch_fn: FetchLike
): Promise<MigrationPlan> {
	const plan: MigrationPlan = { domains: [], lists: [], webhooks: [] }
	if (only.has("domains")) {
		const domains = await resend_list<ResendDomain>("/domains", key, fetch_fn)
		plan.domains = domains.map((d) => ({ name: d.name.toLowerCase(), status: d.status }))
	}
	if (only.has("lists")) {
		for (const audience of await resend_list<ResendAudience>("/audiences", key, fetch_fn)) {
			const contacts = await resend_list<ResendContact>(
				`/audiences/${encodeURIComponent(audience.id)}/contacts`,
				key,
				fetch_fn
			)
			const list: MigrationPlan["lists"][number] = {
				name: audience.name,
				subscribed: [],
				unsubscribed: [],
			}
			for (const contact of contacts) {
				const recipient = { email: contact.email, name: contact_name(contact) }
				;(contact.unsubscribed ? list.unsubscribed : list.subscribed).push(recipient)
			}
			plan.lists.push(list)
		}
	}
	if (only.has("webhooks")) {
		for (const hook of await resend_list<ResendWebhook>("/webhooks", key, fetch_fn)) {
			plan.webhooks.push({
				url: hook.endpoint,
				...map_events(hook.events ?? []),
				disabled: hook.status === "disabled",
			})
		}
	}
	return plan
}

/** The app's cap on one recipients call. */
const RECIPIENTS_PER_CALL = 10_000

type Say = (line?: string) => void

/**
 * One item's writes. The API's refusal (a 4xx with its own code) is this item's and goes
 * on its row; anything else (offline, a 5xx) is the run's and still throws.
 */
async function attempt(
	say: Say,
	label: string,
	write: () => Promise<void>
): Promise<string | undefined> {
	try {
		await write()
		return undefined
	} catch (error) {
		const code = error instanceof ApiCommandError ? error.code : undefined
		const ours = !code || code === "unreachable" || code === "no_token" || code.startsWith("http_5")
		if (ours) throw error
		say(`${red("✗")} ${bold(label)}: ${(error as Error).message} ${dim(`(${code})`)}`)
		return (error as Error).message
	}
}

/** `table` and `print_domain_setup` write to stdout themselves, so under `--json` they are skipped. */
async function migrate_domains(plan: MigrationPlan, say: Say, json: boolean) {
	const out: MigrationSummary["domains"] = []
	if (plan.domains.length === 0) return out
	say(bold("\nDomains"))
	const { domains: existing } = await api<{ domains: Array<{ domain: string; status: string }> }>(
		"/v1/domains"
	)
	for (const { name } of plan.domains) {
		const already = existing.find((d) => d.domain.toLowerCase() === name)
		if (already) {
			say(`${dim("–")} ${bold(name)} is already here (${already.status})`)
			out.push({ domain: name, status: already.status, existed: true })
			continue
		}
		const row: MigrationSummary["domains"][number] = { domain: name, existed: false }
		row.error = await attempt(say, name, async () => {
			const detail = await api<DomainDetail>("/v1/domains", {
				method: "POST",
				body: { domain: name },
			})
			say(`${green("✓")} registered ${bold(detail.domain)}`)
			if (!json) print_domain_setup(detail)
			row.domain = detail.domain
			row.status = detail.status
			row.records = detail.records
		})
		out.push(row)
	}
	say(
		dim(
			"\nPostboi's DKIM records sit beside Resend's, so nothing stops sending until you switch the provider."
		)
	)
	return out
}

/** The app matches a list's name trimmed and without case, so the skip has to as well. */
function list_key(name: string): string {
	return name.trim().toLowerCase()
}

async function migrate_lists(plan: MigrationPlan, say: Say) {
	const out: MigrationSummary["lists"] = []
	if (plan.lists.length === 0) return out
	say(bold("\nAudiences → lists"))
	const { lists: existing } = await api<{ lists: Array<{ id: string; name: string }> }>("/v1/lists")
	for (const list of plan.lists) {
		const name = list.name.trim()
		const found = existing.find((l) => list_key(l.name) === list_key(name))
		const row: MigrationSummary["lists"][number] = {
			name,
			added: 0,
			updated: 0,
			unsubscribed: 0,
			existed: Boolean(found),
		}
		row.error = await attempt(say, name, async () => {
			let id: string
			if (found) {
				id = found.id
			} else {
				const created = await api<{ id: string }>("/v1/lists", {
					method: "POST",
					body: { name },
				})
				id = created.id
			}
			// `?status=subscribed`: these people already confirmed with Resend, so a
			// double-opt-in list must not write to every one of them again. An opt-out
			// says so on its own row and lands unsubscribed, never subscribed on the way.
			const everyone = [
				...list.subscribed,
				...list.unsubscribed.map((r) => ({ ...r, status: "unsubscribed" as const })),
			]
			for (let i = 0; i < everyone.length; i += RECIPIENTS_PER_CALL) {
				const result = await api<{ added: number; updated: number }>(
					`/v1/lists/${encodeURIComponent(id)}/recipients?status=subscribed`,
					{ method: "POST", body: everyone.slice(i, i + RECIPIENTS_PER_CALL) }
				)
				row.added += result.added
				row.updated += result.updated
			}
			row.unsubscribed = list.unsubscribed.length
			say(
				`${green("✓")} ${bold(name)}${found ? dim(" (existing list)") : ""}: ${row.added} added, ${row.updated} already here, ${row.unsubscribed} unsubscribed`
			)
		})
		out.push(row)
	}
	return out
}

async function migrate_webhooks(plan: MigrationPlan, say: Say) {
	const out: MigrationSummary["webhooks"] = []
	if (plan.webhooks.length === 0) return out
	say(bold("\nWebhooks"))
	const { webhooks: existing } = await api<{ webhooks: Array<{ url: string }> }>("/v1/webhooks")
	for (const hook of plan.webhooks) {
		const row: MigrationSummary["webhooks"][number] = {
			url: hook.url,
			events: hook.events,
			dropped: hook.dropped,
		}
		if (hook.disabled) {
			row.skipped = "disabled on Resend"
		} else if (existing.some((w) => w.url === hook.url)) {
			row.skipped = "already here"
		} else if (hook.events.length === 0) {
			row.skipped = "none of its events exist on Postboi"
		}
		if (row.skipped) {
			say(`${dim("–")} ${hook.url} ${dim(`(${row.skipped})`)}`)
			out.push(row)
			continue
		}
		row.error = await attempt(say, hook.url, async () => {
			const endpoint = await api<{ id: string; url: string; secret: string }>("/v1/webhooks", {
				method: "POST",
				body: { url: hook.url, name: "Imported from Resend", events: hook.events },
			})
			row.id = endpoint.id
			row.secret = endpoint.secret
			say(`${green("✓")} ${bold(endpoint.url)} ${dim(`(${endpoint.id})`)}`)
			say(`  ${dim("events:")} ${hook.events.join(", ")}`)
			say(`  ${dim("secret:")} ${endpoint.secret}`)
			if (hook.dropped.length > 0) {
				say(`  ${yellow("!")} not on Postboi, dropped: ${hook.dropped.join(", ")}`)
			}
		})
		out.push(row)
	}
	say(
		dim(
			"\nVerify with `postboi/webhooks`' Postboi adapter and the new secret; `postboi sync` writes it to POSTBOI_WEBHOOK_SECRET."
		)
	)
	return out
}

function print_plan(plan: MigrationPlan, say: Say) {
	say(bold("\nWhat would move"))
	if (plan.domains.length > 0) {
		table(
			["DOMAIN", "ON RESEND"],
			plan.domains.map((d) => [d.name, d.status])
		)
		say()
	}
	if (plan.lists.length > 0) {
		table(
			["AUDIENCE", "SUBSCRIBED", "UNSUBSCRIBED"],
			plan.lists.map((l) => [l.name, String(l.subscribed.length), String(l.unsubscribed.length)])
		)
		say()
	}
	if (plan.webhooks.length > 0) {
		table(
			["WEBHOOK", "EVENTS", "DROPPED"],
			plan.webhooks.map((w) => [
				w.url + (w.disabled ? dim(" (disabled)") : ""),
				w.events.join(",") || dim("none"),
				w.dropped.join(",") || "",
			])
		)
	}
	if (plan.domains.length + plan.lists.length + plan.webhooks.length === 0) {
		say(dim("Nothing on that Resend account to move."))
	}
}

const PARTS = ["domains", "lists", "webhooks"] as const

/** `postboi migrate resend [--key re_…] [--only domains,lists,webhooks] [--dry-run] [--json]` */
export async function migrate_command(
	args: Array<string>,
	deps: { fetch?: FetchLike; log?: (line: string) => void } = {}
): Promise<void> {
	const [provider, ...rest] = args
	if (provider !== "resend") {
		throw new ApiCommandError(
			"Usage: postboi migrate resend [--key <resend key>] [--only domains,lists,webhooks] [--dry-run] [--json]"
		)
	}
	const { flags, on, rest: unknown } = take_flags(rest, ["key", "only"], ["dry-run", "json"])
	if (unknown.length > 0) throw new ApiCommandError(`Unknown option: ${unknown[0]}`)
	const json = on.has("json")
	const dry_run = on.has("dry-run")
	const log = deps.log ?? ((line: string) => console.log(line))
	const say = (line = "") => {
		if (!json) log(line)
	}
	const fetch_fn = deps.fetch ?? fetch

	await ensure_env_loaded()
	const key = flags.key || read_env("RESEND_API_KEY")
	if (!key) {
		throw new ApiCommandError(
			"No Resend key. Pass --key re_… or set RESEND_API_KEY (a full-access key: the import reads domains, audiences and webhooks).",
			"no_resend_key"
		)
	}
	const only = new Set<string>(flags.only ? flags.only.split(",").map((p) => p.trim()) : PARTS)
	for (const part of only) {
		if (!(PARTS as ReadonlyArray<string>).includes(part)) {
			throw new ApiCommandError(`--only takes any of ${PARTS.join(", ")}; not "${part}".`)
		}
	}

	// Before the read, which can be thousands of requests: a run that will write needs
	// the token, and finding that out afterwards is the whole read wasted.
	if (!dry_run) await postboi_token()

	say(dim("Reading your Resend account…"))
	const plan = await read_resend(key, only, fetch_fn)
	if (!json) print_plan(plan, say)

	const summary: MigrationSummary = {
		dry_run,
		plan: {
			domains: plan.domains,
			lists: plan.lists.map((l) => ({
				name: l.name,
				subscribed: l.subscribed.length,
				unsubscribed: l.unsubscribed.length,
			})),
			webhooks: plan.webhooks,
		},
		domains: [],
		lists: [],
		webhooks: [],
	}
	if (dry_run) {
		say(dim("\n--dry-run: nothing written. Run it again without the flag to move them."))
	} else {
		summary.domains = await migrate_domains(plan, say, json)
		summary.lists = await migrate_lists(plan, say)
		summary.webhooks = await migrate_webhooks(plan, say)
		say(bold("\nStill on Resend, by design"))
		say(
			`  ${dim("Templates:")} Postboi has no templates API yet. Paste them into Messages → Templates in the dashboard.`
		)
		say(
			`  ${dim("Suppressions:")} Resend's API has no export. Add any you keep with ${cyan("postboi suppressions add <email>")}.`
		)
		say(
			`  ${dim("API keys:")} never exportable. ${cyan("postboi init")} wrote POSTBOI_TOKEN already.`
		)
		say(bold("\nNext"))
		say(`  1. Publish the DNS records above, then ${cyan("postboi domains check <domain>")}.`)
		say(
			`  2. Keep sending through Resend meanwhile: ${cyan('provider: "resend"')} in postboi.config.`
		)
		say(`  3. Once verified, change it to ${cyan('provider: "postboi"')}. No code changes.`)
	}
	if (json) log(JSON.stringify(summary, null, 2))
	const refused = [...summary.domains, ...summary.lists, ...summary.webhooks].filter((r) => r.error)
	if (refused.length > 0) {
		say(
			`\n${red(`${refused.length} refused`)}; the rest moved. Fix and run again: what is here is skipped.`
		)
		process.exitCode = 1
	}
}
