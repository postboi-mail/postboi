/**
 * The WhatsApp templates your account has, read straight from Meta or Twilio so
 * `bunx postboi sync` can type `template` the way it types `from`.
 *
 * Postboi never sees this list — templates are approved on the platform, so the sync
 * runs against the platform with the credentials already in your env. Best-effort
 * throughout: a missing credential, an unreachable API or a shape we don't recognise all
 * mean "no templates today", never a failed sync.
 *
 * Twilio is the reason this returns SIDs as well as names. Its API sends a `ContentSid`
 * (`HX…`), not a name, so the sync bakes the name→SID map into the package and the
 * provider resolves it — which is what lets the same `template: "order_shipped"` work on
 * both platforms.
 */
import { read_env } from "../library/env.js"
import { load_config } from "../library/config.js"
import { resolve_fields } from "../library/channels.js"
import { WHATSAPP_PROVIDERS, provider_keys } from "../library/registry.js"

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** What one sync found: the names to type, their variables, and Twilio's name→`HX…` map. */
export type WhatsappTemplates = {
	/** Approved (or pending) template names, sorted and deduplicated. */
	names: Array<string>
	/**
	 * Each template's body placeholders. A template whose placeholders couldn't be read is
	 * left out rather than recorded as empty — an omitted entry falls back to accepting any
	 * variables, where a wrong empty one would reject a valid send at compile time.
	 */
	variables: Record<string, Array<string>>
	/** Twilio only — friendly name to Content SID. Empty on Meta. */
	sids: Record<string, string>
}

export const NO_TEMPLATES: WhatsappTemplates = { names: [], variables: {}, sids: {} }

/** The `{{name}}` / `{{1}}` placeholders in a template body, in order, deduplicated. */
export function placeholders(text: string): Array<string> {
	return [...new Set(Array.from(text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g), (m) => m[1]))]
}

/**
 * Page cap. Both APIs page at 100-ish; five pages is far past any real template library
 * and stops a paging bug from looping forever.
 */
const MAX_PAGES = 5

/**
 * How long to wait for a platform that has stopped answering. Sync runs as a prepare and
 * predev hook, so an unbounded fetch doesn't fail — it hangs the dev server behind it.
 */
const TIMEOUT_MS = 10_000

/** GET and parse JSON, or undefined on any failure — this is decoration, not a send. */
async function get_json(
	url: string,
	init: RequestInit,
	fetch_fn: FetchLike
): Promise<Record<string, unknown> | undefined> {
	try {
		const response = await fetch_fn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
		if (!response.ok) return undefined
		const data: unknown = await response.json()
		return data && typeof data === "object" ? (data as Record<string, unknown>) : undefined
	} catch {
		return undefined
	}
}

/**
 * Meta's approved templates for one WhatsApp Business Account, as name→body placeholders.
 * Rejected ones are dropped — unlike a pending DNS record, a rejected template is never
 * becoming sendable — and the rest are deduplicated, because one template approved in
 * three languages comes back three times.
 *
 * Only the BODY component is read: `variables` is the body's map, while a header or button
 * placeholder is its own option on the send.
 */
export async function fetch_meta_templates(
	business_account_id: string,
	access_token: string,
	api_version: string = "v23.0",
	fetch_fn: FetchLike = fetch
): Promise<Record<string, Array<string>>> {
	const found: Record<string, Array<string>> = {}
	let url =
		`https://graph.facebook.com/${api_version}/${business_account_id}/message_templates` +
		`?fields=name,status,components&limit=100`
	for (let page = 0; page < MAX_PAGES && url; page++) {
		const data = await get_json(
			url,
			{ headers: { Authorization: `Bearer ${access_token}` } },
			fetch_fn
		)
		const list = Array.isArray(data?.data) ? (data.data as Array<Record<string, unknown>>) : []
		for (const t of list) {
			if (typeof t.name !== "string" || t.status === "REJECTED" || t.name in found) continue
			const components = Array.isArray(t.components)
				? (t.components as Array<Record<string, unknown>>)
				: []
			const body = components.find((c) => String(c.type).toUpperCase() === "BODY")
			found[t.name] = typeof body?.text === "string" ? placeholders(body.text) : []
		}
		const paging = data?.paging as { next?: unknown } | undefined
		url = typeof paging?.next === "string" ? paging.next : ""
	}
	return found
}

/**
 * Twilio's Content templates as a friendly-name→SID map. Content covers every channel,
 * not just WhatsApp; filtering to WhatsApp-approved ones would mean a second request per
 * template, and a name that isn't a WhatsApp template simply fails at send the way it does
 * today.
 */
export async function fetch_twilio_templates(
	account_sid: string,
	auth_token: string,
	fetch_fn: FetchLike = fetch
): Promise<Record<string, { sid: string; variables: Array<string> }>> {
	const auth = `Basic ${Buffer.from(`${account_sid}:${auth_token}`).toString("base64")}`
	const found: Record<string, { sid: string; variables: Array<string> }> = {}
	let url = "https://content.twilio.com/v1/Content?PageSize=100"
	for (let page = 0; page < MAX_PAGES && url; page++) {
		const data = await get_json(url, { headers: { Authorization: auth } }, fetch_fn)
		const list = Array.isArray(data?.contents)
			? (data.contents as Array<Record<string, unknown>>)
			: []
		for (const c of list) {
			// A friendly name is optional in Twilio's model; without one there's nothing to
			// type, and the SID still works as the `template` value.
			if (typeof c.friendly_name !== "string" || typeof c.sid !== "string") continue
			// Twilio names every placeholder in one map, so its keys are the variables —
			// no body/header split the way Meta has.
			const variables =
				c.variables && typeof c.variables === "object" ? Object.keys(c.variables) : []
			found[c.friendly_name] = { sid: c.sid, variables }
		}
		const meta = data?.meta as { next_page_url?: unknown } | undefined
		url = typeof meta?.next_page_url === "string" ? meta.next_page_url : ""
	}
	return found
}

/**
 * The templates for whichever WhatsApp provider this project is configured with. Empty
 * when there's no provider, no credentials, or nothing approved yet — every one of which
 * simply leaves `template` accepting any string.
 *
 * Credentials come from {@link resolve_fields}, the same env-then-config resolution a real
 * send uses, so sync sees exactly what `whatsapp()` would see rather than a second guess
 * at where the token lives.
 */
export async function fetch_whatsapp_templates(
	fetch_fn: FetchLike = fetch
): Promise<WhatsappTemplates> {
	const config = await load_config()
	const keys =
		provider_keys(read_env("POSTBOI_WHATSAPP_PROVIDER")) ??
		provider_keys(config.whatsapp?.provider) ??
		[]
	// A chain's names and variables are its first provider's, the one its friendly names
	// were written against. Its Content SIDs come from whichever Twilio it holds, though:
	// a chain that fails over from Meta to Twilio sends Twilio the friendly name, and only
	// the synced SID turns that into something Twilio will take.
	// A backup that can't be listed costs the chain its SIDs, never the first's sync.
	const [first, ...rest] = await Promise.all(
		keys.map((key, i) =>
			i === 0
				? templates_for(key, config, fetch_fn)
				: templates_for(key, config, fetch_fn).catch(() => NO_TEMPLATES)
		)
	)
	if (!first) return NO_TEMPLATES
	const sids = Object.assign({}, ...rest.map((t) => t.sids), first.sids)
	return { ...first, sids }
}

/** One provider's templates, or none when it isn't one that lists them or isn't set up. */
async function templates_for(
	key: string,
	config: Awaited<ReturnType<typeof load_config>>,
	fetch_fn: FetchLike
): Promise<WhatsappTemplates> {
	const meta = WHATSAPP_PROVIDERS.find((p) => p.key === key)
	if (!meta) return NO_TEMPLATES

	const options: Record<string, unknown> = {}
	// A missing required field means the channel isn't set up yet — nothing to list.
	if (resolve_fields(meta.fields, config.whatsapp, options, meta.key)) return NO_TEMPLATES
	const value = (name: string) => (typeof options[name] === "string" ? options[name] : "")

	if (key === "meta") {
		const waba = value("business_account_id")
		if (!waba) return NO_TEMPLATES
		const found = await fetch_meta_templates(waba, value("access_token"), undefined, fetch_fn)
		return { names: Object.keys(found).sort(), variables: found, sids: {} }
	}
	const found = await fetch_twilio_templates(value("account_sid"), value("auth_token"), fetch_fn)
	const entries = Object.entries(found)
	return {
		names: Object.keys(found).sort(),
		variables: Object.fromEntries(entries.map(([name, t]) => [name, t.variables])),
		sids: Object.fromEntries(entries.map(([name, t]) => [name, t.sid])),
	}
}
