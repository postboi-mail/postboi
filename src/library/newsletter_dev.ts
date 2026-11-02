import type { InboxStore } from "./inbox_server.js"
import type {
	Campaign,
	CampaignInput,
	CampaignReview,
	CampaignReport,
	Newsletter,
	NewsletterStatus,
	NewsletterTag,
	NewsletterSegment,
	SegmentRule,
	NewsletterImport,
	NewsletterRule,
	NewsletterRuleDraft,
} from "./newsletters.js"
import {
	parse_newsletter_csv,
	type NewsletterImportRow,
	type ImportMapping,
} from "./newsletter_import_rules.js"
import { escape_html, html_to_text } from "./utils.js"
import { campaign_csv } from "./newsletter_csv.js"
import { parse_segment_rule, valid_newsletter_slug } from "./newsletter_segment_rules.js"
import { fill_template, TemplateLimitError } from "./newsletter_template.js"

interface Member {
	id: string
	email: string
	name: string | null
	status: NewsletterStatus
	data: Record<string, string>
	tags: Array<string>
	provenance?: NewsletterImportRow["provenance"]
	consent_at?: string | null
	source?: string
}
interface List {
	id: string
	name: string
	members: Map<string, Member>
}
interface Draft extends Campaign {
	selected: Array<string>
	snapshots: Record<string, Member>
	captured: Array<string>
	excluded: Array<string>
	frozen?: CampaignInput
	frozen_postal?: string
	launch_key?: string
}
interface Link {
	purpose: "confirm" | "preferences"
	list_id: string
	email: string
	expires: number
	consent_revision: number
	settings_revision: string
	used?: boolean
}
interface ImportRun {
	key: string
	item: NewsletterImport
	rows: Array<NewsletterImportRow>
}
export interface DevNewsletterReply {
	status?: number
	body?: unknown
	html?: string
	text?: string
	type?: string
}
export class DevNewsletterError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string
	) {
		super(message)
	}
}
function refuse(status: number, code: string, message: string): never {
	throw new DevNewsletterError(status, code, message)
}
function text(value: unknown, cap = 200000): string {
	return typeof value === "string" ? value.slice(0, cap) : ""
}
function email(value: unknown): string {
	const normalized = text(value, 255).trim().toLowerCase()
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254)
		refuse(400, "invalid_email", "Enter a valid email address.")
	return normalized
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		refuse(400, "invalid_input", "Expected a JSON object.")
	return value as Record<string, unknown>
}
function page(url: URL) {
	const offset = Number(url.searchParams.get("offset") ?? 0),
		limit = Number(url.searchParams.get("limit") ?? 100)
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 1000
	)
		refuse(400, "invalid_page", "Use offset >= 0 and a limit from 1 to 1000.")
	return { offset, limit }
}
function time() {
	return new Date().toISOString()
}
function id(prefix: string) {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`
}
const statuses: Array<NewsletterStatus> = [
	"subscribed",
	"pending",
	"unsubscribed",
	"bounced",
	"complained",
]

/** A bounded, in-memory rehearsal. It has no provider, hosted client, timers or delivery assertions. */
export function create_newsletter_dev(store: InboxStore, base = "/__postboi") {
	const lists = new Map<string, List>(),
		newsletters = new Map<string, Newsletter>(),
		campaigns = new Map<string, Draft>()
	const tags = new Map<string, NewsletterTag>(),
		segments = new Map<string, NewsletterSegment>(),
		imports = new Map<string, ImportRun>()
	const rules = new Map<string, NewsletterRule>()
	const rule_intents = new Map<
		string,
		{
			rule_id: string
			email: string
			revision: number
			authorization_revision: number
			state: "pending" | "captured" | "blocked"
		}
	>()
	const links = new Map<string, Link>(),
		suppressed = new Set<string>()
	const optouts = new Set<string>(),
		consent_revisions = new Map<string, number>()
	const prefix = `${base}/api/newsletter`
	function list(ref: string): List {
		const found = lists.get(ref) ?? [...lists.values()].find((entry) => entry.name === ref)
		return found ?? refuse(404, "not_found", "No such local list.")
	}
	function newsletter(ref: string) {
		return (
			newsletters.get(list(ref).id) ??
			refuse(404, "not_found", "Configure this list as a newsletter first.")
		)
	}
	function campaign(ref: string) {
		return campaigns.get(ref) ?? refuse(404, "not_found", "No such local campaign.")
	}
	function member(list_id: string, ref: string) {
		return [...list(list_id).members.values()].find(
			(entry) => entry.id === ref || entry.email === ref
		)
	}
	function membership_key(list_id: string, address: string) {
		return `${list_id}:${address}`
	}
	function revoke(list_id: string, address: string) {
		const key = membership_key(list_id, address)
		if (!consent_revisions.has(key) && consent_revisions.size >= 10000)
			refuse(413, "local_limit", "Restart the inbox to clear this local consent history.")
		consent_revisions.set(key, (consent_revisions.get(key) ?? 0) + 1)
		optouts.add(key)
		const saved = member(list_id, address)
		if (saved) saved.status = "unsubscribed"
	}
	function put_member(
		target: List,
		row: Partial<Member> & { email: string },
		preserve = true
	): Member {
		const address = email(row.email),
			existing = target.members.get(address)
		if (!existing && [...lists.values()].reduce((n, entry) => n + entry.members.size, 0) >= 10000)
			refuse(413, "local_limit", "A local rehearsal is limited to 10,000 memberships.")
		if (
			row.data &&
			(typeof row.data !== "object" ||
				Array.isArray(row.data) ||
				!Object.values(row.data).every((value) => typeof value === "string") ||
				new TextEncoder().encode(JSON.stringify(row.data)).length > 100000)
		)
			refuse(400, "invalid_data", "Local reader data must be text fields under 100 KB.")
		let status = row.status ?? existing?.status ?? "pending"
		if (!statuses.includes(status)) refuse(400, "invalid_status", "Unknown subscription status.")
		if (status === "bounced" || status === "complained") suppressed.add(address)
		if (newsletters.has(target.id)) {
			if (
				["unsubscribed", "bounced", "complained"].includes(status) ||
				(preserve &&
					existing &&
					!optouts.has(membership_key(target.id, address)) &&
					["unsubscribed", "bounced", "complained"].includes(existing.status))
			)
				revoke(target.id, address)
			if (preserve && optouts.has(membership_key(target.id, address))) status = "unsubscribed"
		}
		const saved: Member = {
			id: existing?.id ?? id("contact"),
			email: address,
			name: row.name ?? existing?.name ?? null,
			status,
			data: { ...existing?.data, ...row.data },
			tags: [...new Set([...(existing?.tags ?? []), ...(row.tags ?? [])])],
			provenance: row.provenance ?? existing?.provenance,
			consent_at: row.consent_at ?? existing?.consent_at,
			source: row.source ?? existing?.source,
		}
		target.members.set(address, saved)
		return saved
	}
	function link(purpose: Link["purpose"], list_id: string, address: string) {
		for (const [key, value] of links)
			if (value.expires <= Date.now() || value.used) links.delete(key)
		if (links.size >= 20000)
			refuse(429, "local_limit", "Clear the local rehearsal before creating more reader links.")
		const token = crypto.randomUUID()
		links.set(token, {
			purpose,
			list_id,
			email: address,
			expires: Date.now() + (purpose === "confirm" ? 86400000 : 30 * 86400000),
			consent_revision: consent_revisions.get(membership_key(list_id, address)) ?? 0,
			settings_revision: JSON.stringify(newsletters.get(list_id)),
		})
		return `${prefix}/${purpose}?token=${encodeURIComponent(token)}`
	}
	function token(url: URL, purpose: Link["purpose"]) {
		const value = links.get(url.searchParams.get("token") ?? "")
		if (!value || value.purpose !== purpose || value.expires <= Date.now() || value.used)
			refuse(410, "link_expired", "This local reader link is invalid, expired or already used.")
		if (
			purpose === "confirm" &&
			(value.consent_revision !==
				(consent_revisions.get(membership_key(value.list_id, value.email)) ?? 0) ||
				value.settings_revision !== JSON.stringify(newsletters.get(value.list_id)))
		)
			refuse(
				410,
				"confirmation_changed",
				"This confirmation predates a subscription or newsletter change. Request a fresh local signup."
			)
		return value
	}
	function fields(input: Record<string, unknown>): CampaignInput {
		for (const key of [
			"name",
			"subject",
			"body",
			"preheader",
			"sender",
			"reply_to",
			"footnote",
		] as const) {
			if (input[key] !== undefined && typeof input[key] !== "string")
				refuse(400, "invalid_campaign", `${key} must be text.`)
		}
		for (const [key, limit] of [
			["name", 150],
			["subject", 500],
			["body", 200000],
			["preheader", 500],
			["footnote", 2000],
		] as const)
			if (typeof input[key] === "string" && input[key].length > limit)
				refuse(413, "body_too_large", `Keep ${key} under ${limit} characters.`)
		const name = text(input.name, 151).trim(),
			list_id = text(input.list_id)
		if (!name || name.length > 150)
			refuse(400, "invalid_name", "Give the campaign a name under 150 characters.")
		list(list_id)
		return {
			name,
			list_id: list(list_id).id,
			subject: text(input.subject, 999),
			body: text(input.body),
			sender: text(input.sender, 254),
			preheader: text(input.preheader, 500),
			reply_to: text(input.reply_to, 254),
			footnote: text(input.footnote, 2000),
			style: input.style === "plain" ? "plain" : "styled",
			letterhead: input.letterhead !== false && input.letterhead !== 0,
			tracking_opens: input.tracking_opens !== false && input.tracking_opens !== 0,
			tracking_clicks: input.tracking_clicks !== false && input.tracking_clicks !== 0,
			segment_id: typeof input.segment_id === "string" ? input.segment_id : null,
		}
	}
	function create(input: Record<string, unknown>, parent_id: string | null = null): Draft {
		if (campaigns.size >= 100)
			refuse(413, "local_limit", "Restart the inbox before creating more than 100 local campaigns.")
		const value = fields(input)
		const draft: Draft = {
			...value,
			id: id("campaign"),
			revision: 1,
			approved_revision: null,
			status: "draft",
			scheduled_at: null,
			timezone: null,
			parent_id,
			letterhead: Number(value.letterhead),
			tracking_opens: Number(value.tracking_opens),
			tracking_clicks: Number(value.tracking_clicks),
			created_at: time(),
			updated_at: time(),
			selected: [],
			snapshots: {},
			captured: [],
			excluded: [],
		}
		campaigns.set(draft.id, draft)
		return draft
	}
	function review(draft: Draft): CampaignReview {
		const blocking: Array<string> = [],
			warnings: Array<string> = [
				"Local rehearsal. Captured mail is not a provider delivery or an observed open.",
			]
		if (!draft.subject?.trim()) blocking.push("Add a subject.")
		if (!draft.body?.trim()) blocking.push("Write the email body.")
		if (!draft.sender?.trim()) blocking.push("Choose a sender.")
		if (!newsletters.get(draft.list_id)?.postal_address?.trim())
			blocking.push("Add the organisation postal address to its newsletter.")
		if (draft.sender && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.sender))
			blocking.push("Use a valid sender address.")
		if (new TextEncoder().encode(draft.body ?? "").length > 200000)
			blocking.push("Shorten the email body.")
		return { blocking, warnings }
	}
	function eligible(draft: Draft): Array<Member> {
		const segment = draft.segment_id ? segments.get(draft.segment_id) : undefined
		if (draft.segment_id && (!segment || segment.list_id !== draft.list_id))
			refuse(400, "invalid_segment", "Choose a segment from this newsletter.")
		const rule: SegmentRule | undefined = segment ? JSON.parse(segment.rule) : undefined
		return [...list(draft.list_id).members.values()].filter(
			(entry) =>
				entry.status === "subscribed" &&
				!suppressed.has(entry.email) &&
				(!rule?.include_tag_ids?.length ||
					rule.include_tag_ids.every((tag) => entry.tags.includes(tag))) &&
				!rule?.exclude_tag_ids?.some((tag) => entry.tags.includes(tag)) &&
				(!rule?.field || entry.data[rule.field.key] === rule.field.value)
		)
	}
	function render(draft: Draft, recipient?: Member, live = false, link_email = recipient?.email) {
		const content = draft.frozen ?? draft
		const values: Record<string, string> = Object.assign(Object.create(null), recipient?.data, {
			name: recipient?.name ?? "",
			email: recipient?.email ?? "reader@example.test",
			unsubscribe_url:
				live && link_email ? link("preferences", draft.list_id, link_email) : "#local-preview",
		})
		values.preferences_url = values.unsubscribe_url
		function fill(value: string, escape = false): string {
			try {
				return fill_template(value, values, {
					escape,
					zone: draft.timezone || "UTC",
					max_bytes: 600000,
				})
			} catch (cause) {
				if (cause instanceof TemplateLimitError)
					refuse(
						413,
						"rendered_too_large",
						"The personalized email exceeds 600 KB. Shorten its body or reader fields before capturing."
					)
				throw cause
			}
		}

		const footer = `<hr><p>${escape_html(draft.frozen_postal ?? newsletters.get(draft.list_id)?.postal_address ?? "")}</p><p><a href="${escape_html(values.unsubscribe_url)}">Manage subscription</a></p>`
		const html = `<!doctype html><meta charset="utf-8"><div style="max-width:600px;margin:auto;font-family:system-ui">${fill(content.body ?? "", true)}${footer}</div>`
		const rendered = {
			html,
			text: html_to_text(html),
			subject: fill(content.subject ?? ""),
			from: content.sender ?? "news@example.test",
		}
		if (new TextEncoder().encode(JSON.stringify(rendered)).byteLength > 600000)
			refuse(
				413,
				"rendered_too_large",
				"The personalized email exceeds 600 KB. Shorten its body or reader fields before capturing."
			)
		return rendered
	}
	function capture(draft: Draft, recipient: Member, to = recipient.email, test = false) {
		const rendered = render(draft, recipient, true, test ? to : recipient.email)
		return store.add({
			to: [{ address: to }],
			from: { address: rendered.from },
			subject: `${test ? "[Test] " : ""}${rendered.subject}`,
			html: rendered.html,
			text: rendered.text,
			headers: { "X-Postboi-Local-Campaign": draft.id },
			attachments: [],
			meta: [
				["Campaign", draft.name],
				["Mode", test ? "Local test" : "Local campaign capture"],
			],
		})
	}
	function report(draft: Draft): CampaignReport & { local: true } {
		const canceled =
			draft.status === "canceled"
				? draft.selected.length - draft.captured.length - draft.excluded.length
				: 0
		return {
			local: true,
			selected: draft.selected.length,
			remaining: Math.max(
				0,
				draft.selected.length - draft.captured.length - draft.excluded.length - canceled
			),
			queued: 0,
			accepted: draft.captured.length,
			delivered: 0,
			opened: 0,
			clicked: 0,
			bounced: 0,
			complained: 0,
			unsubscribed: 0,
			failed: 0,
			unknown: 0,
			canceled,
			excluded: draft.excluded.length,
			links: [],
			providers: [],
			timeline: [],
		}
	}
	function rule_draft(body: Record<string, unknown>, list_id: string): NewsletterRuleDraft {
		if (Object.hasOwn(body, "enabled"))
			refuse(400, "invalid_rule", "Save a paused rule, then explicitly review and enable it.")
		for (const [key, cap] of [
			["name", 100],
			["subject", 998],
			["body", 250000],
			["sender", 998],
			["trigger_tag_id", 255],
		] as const)
			if (typeof body[key] !== "string" || !body[key].trim() || body[key].length > cap)
				refuse(400, "invalid_rule", `Include ${key} within ${cap} characters.`)
		if (body.on_signup !== undefined && typeof body.on_signup !== "boolean")
			refuse(400, "invalid_rule", "on_signup must be boolean.")
		const trigger = text(body.trigger_tag_id),
			completion = body.completion_tag_id == null ? null : text(body.completion_tag_id)
		if (
			tags.get(trigger)?.list_id !== list_id ||
			(completion && tags.get(completion)?.list_id !== list_id) ||
			completion === trigger
		)
			refuse(
				400,
				"invalid_rule",
				"Choose distinct trigger and completion tags from this newsletter."
			)
		return {
			name: text(body.name).trim(),
			subject: text(body.subject).trim(),
			body: text(body.body, 250000),
			sender: text(body.sender),
			trigger_tag_id: trigger,
			completion_tag_id: completion,
			on_signup: body.on_signup === true,
		}
	}
	function rule_review(rule: NewsletterRule) {
		const draft_review = review({ ...rule } as unknown as Draft)
		return {
			id: rule.id,
			revision: rule.revision,
			enabled: rule.enabled,
			trigger_tag_id: rule.trigger_tag_id,
			completion_tag_id: rule.completion_tag_id ?? null,
			on_signup: rule.on_signup,
			sender: rule.sender,
			subject: rule.subject,
			warnings: [
				...draft_review.blocking,
				...draft_review.warnings,
				"Local review cannot verify hosted sender domains, team permissions, API key expiry or OAuth grants.",
			],
			ready: draft_review.blocking.length === 0,
		}
	}
	function block_intents(rule: NewsletterRule) {
		for (const intent of rule_intents.values())
			if (intent.rule_id === rule.id && intent.state === "pending") {
				intent.state = "blocked"
				rule.blocked++
			}
	}
	function trigger_rules(list_id: string, reader: Member, event_id: string, tag_id?: string) {
		if (reader.status !== "subscribed" || suppressed.has(reader.email)) return
		for (const rule of rules.values()) {
			if (
				rule.list_id !== list_id ||
				!rule.enabled ||
				(tag_id ? rule.trigger_tag_id !== tag_id : !rule.on_signup)
			)
				continue
			const key = JSON.stringify([rule.id, reader.id, event_id])
			if (rule_intents.has(key)) continue
			if (rule_intents.size >= 2000)
				refuse(413, "local_limit", "Restart the inbox before queuing more automation intents.")
			rule_intents.set(key, {
				rule_id: rule.id,
				email: reader.email,
				revision: rule.revision,
				authorization_revision: rule.authorization_revision ?? 0,
				state: "pending",
			})
		}
	}
	function state() {
		return {
			local: true,
			campaigns: [...campaigns.values()].map((draft) => ({
				...draft,
				report: report(draft),
				review: review(draft),
			})),
			tags: [...tags.values()],
			rules: [...rules.values()],
			rule_intents: [...rule_intents.values()],
			newsletters: [...newsletters.values()],
			lists: [...lists.values()].map((target) => ({
				id: target.id,
				name: target.name,
				recipients: target.members.size,
			})),
			pending: [...links.entries()]
				.filter(
					([, value]) => value.purpose === "confirm" && !value.used && value.expires > Date.now()
				)
				.map(([key, value]) => ({
					email: value.email,
					list_id: value.list_id,
					confirm_url: `${prefix}/confirm?token=${key}`,
				})),
		}
	}
	function handle(path: string, method: string, raw: unknown, url: URL): DevNewsletterReply {
		if (path === "/state" && method === "GET") return { body: state() }
		if ((path === "/confirm" || path === "/preferences") && ["GET", "POST"].includes(method)) {
			const purpose = path === "/confirm" ? "confirm" : "preferences",
				reader = token(url, purpose)
			if (method === "POST") {
				const target = member(reader.list_id, reader.email)
				if (!target) refuse(404, "not_found", "No such local subscriber.")
				if (purpose === "confirm") {
					if (!suppressed.has(target.email)) {
						target.status = "subscribed"
						optouts.delete(membership_key(reader.list_id, reader.email))
						trigger_rules(reader.list_id, target, "signup")
					}
					reader.used = true
				} else revoke(reader.list_id, reader.email)
				return {
					html: `<!doctype html><meta charset="utf-8"><p>${purpose === "confirm" ? "Local subscription confirmed." : "Local subscription stopped."}</p><a href="${base}/newsletters">Back to newsletters</a>`,
				}
			}
			return {
				html: `<!doctype html><meta charset="utf-8"><h1>${purpose === "confirm" ? "Confirm subscription" : "Manage subscription"}</h1><p>${escape_html(reader.email)}</p><p>This affects only the local dev inbox.</p><form method="post"><button>${purpose === "confirm" ? "Confirm subscription" : "Unsubscribe"}</button></form>`,
			}
		}
		if (!path.startsWith("/v1/")) refuse(404, "not_found", "Unknown local newsletter operation.")
		const parts = path.slice(4).split("/").map(decodeURIComponent),
			[kind, ref, operation, subref] = parts
		const input = raw === undefined ? {} : raw
		if (kind === "lists") {
			if (!ref) {
				if (method === "GET") return { body: { lists: state().lists } }
				const body = object(input),
					name = text(body.name, 151).trim()
				if (
					!name ||
					name.length > 150 ||
					[...lists.values()].some((target) => target.name === name)
				)
					refuse(409, "name_taken", "Use a unique local list name under 150 characters.")
				if (lists.size >= 100) refuse(413, "local_limit", "The inbox supports 100 local lists.")
				const target: List = { id: id("list"), name, members: new Map() }
				lists.set(target.id, target)
				return {
					status: 201,
					body: { id: target.id, name, confirmation: { enabled: true }, created_at: time() },
				}
			}
			const target = list(ref)
			if (operation === "recipients") {
				if (method === "POST") {
					if (!Array.isArray(input) || input.length > 1000)
						refuse(400, "invalid_input", "Provide at most 1000 recipients.")
					let added = 0,
						updated = 0,
						pending = 0
					for (const item of input) {
						const row = object(item),
							address = email(row.email)
						if (target.members.has(address)) updated++
						else added++
						const saved = put_member(target, {
							email: address,
							name: text(row.name) || null,
							data:
								row.data && typeof row.data === "object"
									? (row.data as Record<string, string>)
									: {},
							status: (url.searchParams.get("status") ??
								row.status ??
								"pending") as NewsletterStatus,
						})
						if (saved.status === "pending") pending++
					}
					return { body: { added, updated, pending, list: { id: target.id, name: target.name } } }
				}
				if (method === "PATCH") {
					const body = object(input),
						saved = member(target.id, email(body.email))
					if (!saved) refuse(404, "not_found", "No such recipient.")
					if (
						body.status === "subscribed" &&
						newsletters.has(target.id) &&
						optouts.has(membership_key(target.id, saved.email))
					)
						refuse(
							409,
							"newsletter_confirmation_required",
							"Request and confirm a fresh signup before restoring this reader."
						)
					put_member(
						target,
						{ ...saved, status: body.status as NewsletterStatus },
						newsletters.has(target.id)
					)
					return { body: { email: saved.email, status: member(target.id, saved.email)!.status } }
				}
				if (method === "DELETE") {
					const address = email(url.searchParams.get("email"))
					if (
						newsletters.has(target.id) &&
						["unsubscribed", "bounced", "complained"].includes(
							target.members.get(address)?.status ?? ""
						)
					)
						revoke(target.id, address)
					target.members.delete(address)
					return { body: { ok: true } }
				}
				return { body: { recipients: [...target.members.values()] } }
			}
			if (method === "DELETE") {
				if ([...campaigns.values()].some((draft) => draft.list_id === target.id))
					refuse(
						409,
						"list_in_use",
						"Restart the local rehearsal to remove a list used by campaigns."
					)
				lists.delete(target.id)
				newsletters.delete(target.id)
				return { body: { id: target.id } }
			}
			if (operation || method !== "GET")
				refuse(
					405,
					"method_not_allowed",
					"This local list operation is not supported. Use newsletter campaigns to rehearse sending."
				)
			return {
				body: {
					id: target.id,
					name: target.name,
					recipients: [...target.members.values()],
					confirmation: { enabled: true },
				},
			}
		}
		if (kind === "newsletters") {
			if (!ref) {
				if (method === "GET")
					return {
						body: {
							newsletters: [...newsletters.values()].map((value) => ({
								...value,
								subscribed: [...list(value.list_id).members.values()].filter(
									(entry) => entry.status === "subscribed"
								).length,
							})),
						},
					}
				const body = object(input),
					target = list(text(body.list_id)),
					slug = text(body.slug, 100)
				if (
					!valid_newsletter_slug(slug) ||
					[...newsletters.values()].some(
						(value) => value.slug === slug && value.list_id !== target.id
					)
				)
					refuse(
						400,
						"invalid_slug",
						"Choose a unique lowercase slug using letters, numbers and hyphens."
					)
				const saved: Newsletter = {
					list_id: target.id,
					account_id: "local",
					name: target.name,
					slug,
					description: text(body.description, 2000),
					postal_address: text(body.postal_address, 2000),
					public_signup: Number(body.public_signup === true),
					created_at: newsletters.get(target.id)?.created_at ?? time(),
					updated_at: time(),
				}
				if (!newsletters.has(target.id))
					for (const entry of target.members.values())
						if (["unsubscribed", "bounced", "complained"].includes(entry.status))
							revoke(target.id, entry.email)
				newsletters.set(target.id, saved)
				return { status: 201, body: { newsletter: saved } }
			}
			const current = newsletter(ref),
				target = list(current.list_id)
			if (operation === "audience") {
				const { offset } = page(url),
					limit = 25,
					search = (url.searchParams.get("search") ?? "").toLowerCase()
				if (search.length > 200 || offset > 10000000)
					refuse(
						400,
						"invalid_page",
						"Search is limited to 200 characters and offset to 10,000,000."
					)
				const members = [...target.members.values()].filter((entry) =>
					`${entry.email} ${entry.name}`.toLowerCase().includes(search)
				)
				return {
					body: {
						contacts: members.slice(offset, offset + limit).map((entry) => ({
							...entry,
							data: JSON.stringify(entry.data),
							newsletter_data: JSON.stringify(entry.data),
							newsletter_name: entry.name,
							provenance: entry.provenance ? JSON.stringify(entry.provenance) : null,
							source: entry.source ?? "local",
							consent_at: entry.consent_at ?? null,
							subscribed_at: null,
							tag_ids: entry.tags,
						})),
						total: members.length,
						audience_total: target.members.size,
						offset,
						limit,
						next_offset: offset + limit < members.length ? offset + limit : null,
					},
				}
			}
			if (operation === "signups" && method === "POST") {
				const body = object(input)
				if (body.consent !== true)
					refuse(400, "consent_required", "Consent is required before requesting a confirmation.")
				const address = email(body.email)
				if (!target.members.has(address))
					put_member(target, {
						email: address,
						name: text(body.name, 200) || null,
						status: "pending",
					})
				const confirm = link("confirm", target.id, address)
				store.add({
					to: [{ address }],
					from: { address: "news@example.test" },
					subject: `Confirm your subscription to ${target.name}`,
					html: `<p>Confirm your local subscription.</p><a href="${escape_html(confirm)}">Confirm subscription</a>`,
					text: `Confirm subscription: ${confirm}`,
					attachments: [],
					meta: [["Mode", "Local newsletter confirmation"]],
				})
				return { status: 202, body: { ok: true } }
			}
			if (operation === "tags") {
				if (method === "GET")
					return {
						body: { tags: [...tags.values()].filter((value) => value.list_id === target.id) },
					}
				const body = object(input)
				if (method === "DELETE") {
					const value = tags.get(text(body.tag_id))
					if (!value || value.list_id !== target.id) refuse(404, "not_found", "No such tag.")
					const subscriber = member(target.id, text(body.contact_id))
					if (subscriber) subscriber.tags = subscriber.tags.filter((key) => key !== value.id)
					return { body: { ok: true } }
				}
				const name = text(body.name, 101).trim()
				if (!name || name.length > 100)
					refuse(400, "invalid_tag", "Use a tag name under 100 characters.")
				const tag = [...tags.values()].find(
					(value) => value.list_id === target.id && value.name === name
				) ?? { id: id("ntag"), list_id: target.id, name, contacts: 0 }
				tags.set(tag.id, tag)
				const ids = body.contact_ids ?? []
				if (!Array.isArray(ids) || ids.length > 100)
					refuse(400, "invalid_input", "Tag at most 100 contacts at once.")
				let added = 0
				for (const key of ids) {
					const subscriber = member(target.id, String(key))
					if (subscriber && !subscriber.tags.includes(tag.id)) {
						subscriber.tags.push(tag.id)
						trigger_rules(target.id, subscriber, text(body.event_id) || id("event"), tag.id)
						added++
					}
				}
				tag.contacts = [...target.members.values()].filter((entry) =>
					entry.tags.includes(tag.id)
				).length
				return { status: 201, body: { tag_id: tag.id, added } }
			}
			if (operation === "rules") {
				const action = parts[4]
				if (!subref) {
					if (method === "GET")
						return {
							body: { rules: [...rules.values()].filter((rule) => rule.list_id === target.id) },
						}
					if (method !== "POST") refuse(405, "method_not_allowed", "Create a rule with POST.")
					if (rules.size >= 100)
						refuse(413, "local_limit", "Restart before creating more than 100 local rules.")
					const draft = rule_draft(object(input), target.id)
					const rule: NewsletterRule = {
						...draft,
						id: id("rule"),
						account_id: "local",
						list_id: target.id,
						enabled: 0,
						on_signup: draft.on_signup ? 1 : 0,
						revision: 1,
						reviewed_revision: null,
						enabled_by_user_id: null,
						blocked: 0,
						authorization_revision: 0,
					}
					rules.set(rule.id, rule)
					return { status: 201, body: rule }
				}
				const rule = rules.get(subref)
				if (!rule || rule.list_id !== target.id)
					refuse(404, "not_found", "No such newsletter rule.")
				if (!action && method === "GET") return { body: rule }
				if (action === "review" && method === "GET") return { body: rule_review(rule) }
				const body = object(input)
				if (action === "preview" && method === "POST") {
					const sample = body.sample_contact_id
						? member(target.id, text(body.sample_contact_id))
						: undefined
					if (body.sample_contact_id && !sample)
						refuse(404, "not_found", "No such sample reader in this newsletter.")
					const rendered = render({ ...rule } as unknown as Draft, sample)
					return { body: { subject: rendered.subject, html: rendered.html } }
				}
				if (action === "run" && method === "POST") {
					let captured = 0
					for (const intent of [...rule_intents.values()]
						.filter((intent) => intent.rule_id === rule.id && intent.state === "pending")
						.slice(0, 20)) {
						const reader = member(target.id, intent.email)
						if (
							!rule.enabled ||
							intent.revision !== rule.revision ||
							intent.authorization_revision !== rule.authorization_revision ||
							!reader ||
							reader.status !== "subscribed" ||
							suppressed.has(reader.email) ||
							!rule_review(rule).ready
						) {
							intent.state = "blocked"
							rule.blocked++
							continue
						}
						try {
							capture({ ...rule } as unknown as Draft, reader)
						} catch (cause) {
							if (!(cause instanceof DevNewsletterError) || cause.code !== "rendered_too_large")
								throw cause
							intent.state = "blocked"
							rule.blocked++
							continue
						}
						intent.state = "captured"
						captured++
						if (rule.completion_tag_id && !reader.tags.includes(rule.completion_tag_id))
							reader.tags.push(rule.completion_tag_id)
					}
					return {
						body: {
							local: true,
							captured,
							pending: [...rule_intents.values()].filter(
								(intent) => intent.rule_id === rule.id && intent.state === "pending"
							).length,
							blocked: rule.blocked,
							delivered: 0,
							opened: 0,
						},
					}
				}
				if (
					(method === "PATCH" && !action) ||
					(method === "POST" && ["enable", "pause"].includes(action))
				) {
					if (!Number.isSafeInteger(body.revision) || body.revision !== rule.revision)
						refuse(409, "revision_conflict", "Review the current rule revision first.")
					if (method === "PATCH") {
						if (rule.enabled) refuse(409, "rule_enabled", "Pause the rule before editing it.")
						const draft = rule_draft(body, target.id)
						block_intents(rule)
						Object.assign(rule, draft, {
							on_signup: draft.on_signup ? 1 : 0,
							revision: rule.revision + 1,
							reviewed_revision: null,
							enabled_by_user_id: null,
						})
					} else if (action === "enable") {
						if (body.confirm !== true)
							refuse(
								400,
								"confirmation_required",
								"Explicitly approve this revision with confirm:true."
							)
						if (rule.enabled) refuse(409, "rule_enabled", "This rule is already enabled.")
						if (!rule_review(rule).ready)
							refuse(400, "invalid_rule", "Resolve rule review warnings before enabling.")
						block_intents(rule)
						rule.authorization_revision = (rule.authorization_revision ?? 0) + 1
						rule.enabled = 1
						rule.reviewed_revision = rule.revision
						rule.enabled_by_user_id = "local"
					} else {
						rule.enabled = 0
						block_intents(rule)
					}
					return { body: rule }
				}
				refuse(405, "method_not_allowed", "Unknown newsletter rule operation.")
			}
			if (operation === "segments") {
				if (method === "GET")
					return {
						body: {
							segments: [...segments.values()].filter((value) => value.list_id === target.id),
						},
					}
				const body = object(input),
					rule = parse_segment_rule(body.rule)
				if (!rule) refuse(400, "invalid_segment", "Include a valid segment rule.")
				const ids = [
					...(Array.isArray(rule.include_tag_ids) ? rule.include_tag_ids : []),
					...(Array.isArray(rule.exclude_tag_ids) ? rule.exclude_tag_ids : []),
				]
				if (ids.length > 40 || ids.some((key) => tags.get(String(key))?.list_id !== target.id))
					refuse(400, "invalid_segment", "Choose up to 40 tags from this newsletter.")
				const saved = {
					id: id("segment"),
					list_id: target.id,
					name: text(body.name, 100),
					rule: JSON.stringify(rule),
				}
				if (!saved.name) refuse(400, "invalid_segment", "Name the segment.")
				segments.set(saved.id, saved)
				return { status: 201, body: { id: saved.id } }
			}
			if (operation === "imports") {
				if (subref) {
					const run = imports.get(subref)
					if (!run || run.item.list_id !== target.id) refuse(404, "not_found", "No such import.")
					if (method !== "POST") refuse(405, "method_not_allowed", "Apply imports with POST.")
					const rows = run.rows.slice(run.item.applied, run.item.applied + 100)
					for (const row of rows) {
						if (row.status === "bounced" || row.status === "complained") suppressed.add(row.email)
						const tag_ids: Array<string> = []
						for (const name of row.tags) {
							const tag = [...tags.values()].find(
								(entry) => entry.list_id === target.id && entry.name === name
							) ?? { id: id("ntag"), list_id: target.id, name, contacts: 0 }
							tags.set(tag.id, tag)
							tag_ids.push(tag.id)
						}
						put_member(target, {
							email: row.email,
							name: target.members.get(row.email)?.name ?? row.name,
							status:
								row.status === "bounced" || row.status === "complained"
									? "unsubscribed"
									: row.status,
							data: row.data,
							tags: tag_ids,
							consent_at: row.consent_at,
							provenance: row.provenance,
							source: run.item.source_audience_id ?? run.item.filename,
						})
					}
					for (const tag of tags.values())
						if (tag.list_id === target.id)
							tag.contacts = [...target.members.values()].filter((entry) =>
								entry.tags.includes(tag.id)
							).length
					run.item.applied += rows.length
					run.item.status = run.item.applied === run.item.total ? "applied" : "applying"
					return { body: { applied: rows.length, remaining: run.item.total - run.item.applied } }
				}
				if (method === "GET")
					return {
						body: {
							imports: [...imports.values()]
								.filter((value) => value.item.list_id === target.id)
								.map((value) => value.item),
						},
					}
				const body = object(input)
				if (
					typeof body.csv !== "string" ||
					new TextEncoder().encode(body.csv).length > 2 * 1024 * 1024
				)
					refuse(413, "local_limit", "Use a CSV under 2 MB in the local rehearsal.")
				const parsed = parse_newsletter_csv(text(body.csv, 10000000), {
					source_profile: body.source_profile as
						| import("./newsletter_import_profiles.js").ImportProfile
						| undefined,
					default_status: body.default_status as NewsletterStatus,
					consent_confirmed: body.consent_confirmed === true,
					mapping: body.mapping as ImportMapping | undefined,
				})
				if ("error" in parsed) refuse(400, "invalid_import", parsed.error)
				const key = JSON.stringify([target.id, parsed.rows, body.source_audience_id ?? null])
				const previous = [...imports.values()].find((run) => run.key === key)
				if (previous) return { status: 201, body: { import: previous.item } }
				if (imports.size >= 20) refuse(413, "local_limit", "Restart before staging more imports.")
				const item: NewsletterImport = {
					id: id("nimp"),
					account_id: "local",
					source_audience_id:
						typeof body.source_audience_id === "string" ? body.source_audience_id : null,
					content_hash: id("local"),
					list_id: target.id,
					filename: text(body.filename, 200),
					total: parsed.rows.length,
					applied: 0,
					status: "previewed",
					summary: JSON.stringify({ ...parsed, rows: undefined, sample: parsed.rows.slice(0, 5) }),
					created_at: time(),
				}
				imports.set(item.id, { key, item, rows: parsed.rows })
				return { status: 201, body: { import: item } }
			}
			if (!operation && method === "GET")
				return {
					body: {
						newsletter: current,
						tags: [...tags.values()].filter((value) => value.list_id === target.id),
						segments: [...segments.values()].filter((value) => value.list_id === target.id),
					},
				}
		}
		if (kind === "campaigns") {
			if (!ref) {
				if (method === "GET") return { body: { campaigns: [...campaigns.values()] } }
				return { status: 201, body: create(object(input)) }
			}
			const draft = campaign(ref)
			if (!operation) {
				if (method === "GET") return { body: draft }
				if (method !== "PUT" || draft.status !== "draft")
					refuse(409, "campaign_immutable", "Only a draft can be edited.")
				const body = object(input)
				if (body.revision !== draft.revision)
					refuse(409, "revision_conflict", "Reload the current draft revision before saving.")
				Object.assign(draft, fields(body), {
					revision: draft.revision + 1,
					updated_at: time(),
					letterhead: Number(body.letterhead !== false && body.letterhead !== 0),
					tracking_opens: Number(body.tracking_opens !== false && body.tracking_opens !== 0),
					tracking_clicks: Number(body.tracking_clicks !== false && body.tracking_clicks !== 0),
				})
				return { body: draft }
			}
			if (method === "GET") {
				if (operation === "review") return { body: review(draft) }
				if (operation === "preview") return { html: render(draft).html }
				if (operation === "report") return { body: report(draft) }
				if (operation === "recipients" || operation === "export") {
					const { offset, limit } = page(url)
					const rows = draft.selected.map((key) => {
						const reader = member(draft.list_id, key)
						return {
							contact_id: key,
							email: reader?.email,
							status: draft.captured.includes(key)
								? "captured"
								: draft.excluded.includes(key)
									? "excluded"
									: draft.status === "canceled"
										? "canceled"
										: "queued",
						}
					})
					if (operation === "export")
						return {
							text: campaign_csv(
								rows.slice(offset, offset + limit).map((row) => ({
									email: row.email ?? null,
									name: member(draft.list_id, row.contact_id)?.name ?? null,
									state: row.status,
									reason: null,
									message_id: null,
									status: row.status,
									accepted_at: null,
									delivered_at: null,
									opened_at: null,
									error: null,
								}))
							),
							type: "text/csv; charset=utf-8",
						}
					return {
						body: {
							recipients: rows.slice(offset, offset + limit),
							next_offset: offset + limit < rows.length ? offset + limit : null,
						},
					}
				}
			}
			if (method !== "POST") refuse(405, "method_not_allowed", "Use POST for campaign commands.")
			const body = object(input)
			if (operation === "duplicate")
				return {
					status: 201,
					body: create({ ...draft, name: `${draft.name.slice(0, 143)} (copy)` }),
				}
			if (operation === "resend")
				refuse(
					409,
					"local_delivery_unobserved",
					"Local captures cannot prove delivery or non-opens. Duplicate the draft to rehearse another send."
				)
			if (operation === "test") {
				const to = email(body.email),
					sample = body.sample_contact_id
						? member(draft.list_id, text(body.sample_contact_id))
						: undefined
				if (body.sample_contact_id && !sample)
					refuse(404, "not_found", "Choose a sample from this audience.")
				const captured = capture(
					draft,
					sample ?? { id: "test", email: to, name: null, data: {}, tags: [], status: "pending" },
					to,
					true
				)
				return { body: { id: captured.id, local: true } }
			}
			if (operation === "launch") {
				if (draft.status !== "draft" || body.revision !== draft.revision)
					refuse(409, "revision_conflict", "Launch the current draft revision only once.")
				const checked = review(draft)
				if (checked.blocking.length) refuse(400, "review_required", checked.blocking.join(" "))
				let scheduled_at = time()
				if (body.scheduled_at !== undefined) {
					if (
						typeof body.scheduled_at !== "string" ||
						!/(?:Z|[+-]\d\d:\d\d)$/.test(body.scheduled_at) ||
						!Number.isFinite(Date.parse(body.scheduled_at))
					)
						refuse(400, "invalid_schedule", "Use an absolute ISO time with Z or an offset.")
					scheduled_at = new Date(body.scheduled_at).toISOString()
				}
				try {
					new Intl.DateTimeFormat("en", { timeZone: text(body.timezone) || "UTC" })
				} catch {
					refuse(400, "invalid_timezone", "Choose an IANA timezone.")
				}
				draft.frozen_postal = newsletter(draft.list_id).postal_address
				draft.frozen = structuredClone(
					fields({
						...draft,
						letterhead: Boolean(draft.letterhead),
						tracking_opens: Boolean(draft.tracking_opens),
						tracking_clicks: Boolean(draft.tracking_clicks),
					})
				)
				const selected = eligible(draft)
				if (
					[...campaigns.values()].reduce((n, value) => n + value.selected.length, 0) +
						selected.length >
					20000
				)
					refuse(
						413,
						"local_limit",
						"Restart the inbox before freezing more than 20,000 local recipient snapshots."
					)
				draft.selected = selected.map((entry) => entry.id)
				draft.snapshots = Object.fromEntries(
					selected.map((entry) => [entry.id, structuredClone(entry)])
				)
				draft.approved_revision = draft.revision
				draft.scheduled_at = scheduled_at
				draft.timezone = text(body.timezone) || "UTC"
				draft.status = scheduled_at > time() ? "scheduled" : "sending"
				return { body: draft }
			}
			if (operation === "pause") {
				if (!["sending", "scheduled"].includes(draft.status))
					refuse(409, "invalid_state", "Pause a launched campaign.")
				draft.status = "paused"
				return { body: draft }
			}
			if (operation === "resume") {
				if (draft.status !== "paused") refuse(409, "invalid_state", "Resume a paused campaign.")
				draft.status = (draft.scheduled_at ?? "") > time() ? "scheduled" : "sending"
				return { body: draft }
			}
			if (operation === "cancel") {
				if (draft.status === "completed")
					refuse(409, "invalid_state", "A completed campaign cannot be canceled.")
				draft.status = "canceled"
				return { body: draft }
			}
			if (operation === "run") {
				if (
					draft.status === "paused" ||
					draft.status === "canceled" ||
					(draft.scheduled_at ?? "9999") > time()
				)
					return { body: { captured: 0, ...report(draft) } }
				if (!["sending", "scheduled", "completed"].includes(draft.status))
					refuse(409, "invalid_state", "Launch before running local work.")
				let processed = 0,
					captured = 0
				for (const key of draft.selected) {
					if (draft.captured.includes(key) || draft.excluded.includes(key)) continue
					const reader = member(draft.list_id, key)
					if (!reader || reader.status !== "subscribed" || suppressed.has(reader.email))
						draft.excluded.push(key)
					else {
						capture(draft, draft.snapshots[key] ?? reader)
						draft.captured.push(key)
						captured++
					}
					if (++processed >= 100) break
				}
				if (draft.captured.length + draft.excluded.length === draft.selected.length)
					draft.status = "completed"
				else draft.status = "sending"
				return { body: { captured, ...report(draft) } }
			}
		}
		refuse(404, "not_found", "Unknown local newsletter operation.")
	}
	return { handle, state }
}
