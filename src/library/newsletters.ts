import type { CampaignBodyFormat } from "./campaign_document.js"
export type { CampaignBodyFormat } from "./campaign_document.js"
/** Saved newsletter drafts and audiences on the Postboi provider. */
export interface CampaignInput {
	name: string
	list_id: string
	subject?: string
	body?: string
	body_format?: CampaignBodyFormat
	preheader?: string
	sender?: string
	reply_to?: string
	footnote?: string
	style?: "styled" | "plain"
	letterhead?: boolean
	tracking_opens?: boolean
	tracking_clicks?: boolean
	segment_id?: string | null
}
export interface Campaign extends Omit<
	CampaignInput,
	"letterhead" | "tracking_opens" | "tracking_clicks"
> {
	id: string
	status: "draft" | "scheduled" | "sending" | "paused" | "completed" | "canceled"
	revision: number
	approved_revision: number | null
	letterhead: number
	tracking_opens: number
	tracking_clicks: number
	scheduled_at: string | null
	timezone: string | null
	parent_id: string | null
	created_at: string
	updated_at: string
}
export interface CampaignReview {
	html_bytes?: number
	blocking: Array<string>
	warnings: Array<string>
}
export interface CampaignLaunch {
	revision: number
	scheduled_at?: string
	timezone?: string
}
export interface CampaignReport {
	selected: number
	remaining: number
	queued: number
	accepted: number
	delivered: number
	opened: number
	clicked: number
	bounced: number
	complained: number
	unsubscribed: number
	failed: number
	unknown: number
	canceled: number
	excluded: number
	links: Array<{ url: string; clicks: number; unique_clicks: number }>
	providers: Array<{
		provider: string
		accepted: number
		delivered: number
		opened: number
		clicked: number
		bounced: number
		complained: number
	}>
	timeline: Array<{
		day: string
		accepted: number
		delivered: number
		opened: number
		clicked: number
	}>
}
export interface NewsletterInput {
	list_id: string
	slug: string
	description?: string
	postal_address?: string
	public_signup?: boolean
}
export interface Newsletter extends Omit<NewsletterInput, "public_signup"> {
	account_id: string
	name?: string
	public_signup: number
	created_at: string
	updated_at: string
	subscribed?: number
	pending?: number
	unsubscribed?: number
}
export interface NewsletterReconfirmationDraft {
	inactivity_days: number
	grace_days: number
	sender: string
	subject: string
	body: string
}
export interface NewsletterReconfirmationPolicy extends NewsletterReconfirmationDraft {
	list_id: string
	account_id: string
	revision: number
	authorization_revision: number
	enabled: 0 | 1
	enabled_by_user_id: string | null
	authorization_kind: "member" | "api_key" | "oauth"
	api_key_id: string | null
	reviewed_revision: number | null
	enabled_at: string | null
	updated_at: string
}
export interface NewsletterReconfirmationReview {
	policy: NewsletterReconfirmationPolicy
	candidates: { total: number; samples: Array<{ id: string; email: string; name: string | null }> }
	review_hash: string
	warnings: Array<string>
	ready: boolean
	preview: { subject: string; html: string }
	stats: Array<{ state: string; total: number }>
}
export interface NewsletterQuality {
	summary: {
		total: number
		subscribed: number
		pending: number
		unsubscribed: number
		globally_blocked: number
		checked: number
		malformed: number
		known_invalid: number
	}
	review: {
		total: number
		classified: number
		typo: number
		role: number
		disposable: number
		excluded: number
		no_mail: number
		domains: number
		domains_checked: number
	}
	pacing: { waiting: number; next_at: string | null }
	contacts: Array<{
		id: string
		email: string
		name: string | null
		status: NewsletterStatus
		globally_blocked: boolean
		known_invalid: boolean
		checked: boolean
		malformed: boolean
		safety_checked_at: string | null
		classification: { flags: Array<"typo" | "role" | "disposable">; suggestion: string | null }
		decision: "exclude" | "allow" | null
		domain: {
			name: string | null
			state: "unknown" | "mx" | "implicit_mx" | "no_mail"
			reason: string
			checked_at: string | null
			expires_at: string | null
		}
	}>
	offset: number
	next_offset: number | null
}
export interface NewsletterTag {
	id: string
	name: string
	contacts: number
	list_id: string
}
export interface SegmentRule {
	include_tag_ids?: Array<string>
	exclude_tag_ids?: Array<string>
	field?: { key: string; value: string }
}
export interface NewsletterSegment {
	id: string
	list_id: string
	name: string
	rule: string
}
export interface NewsletterRuleDraft {
	name: string
	trigger_tag_id: string
	completion_tag_id?: string | null
	subject: string
	body: string
	sender: string
	on_signup?: boolean
}
export interface NewsletterRule extends Omit<NewsletterRuleDraft, "on_signup"> {
	id: string
	account_id: string
	list_id: string
	enabled: 0 | 1
	on_signup: 0 | 1
	revision: number
	reviewed_revision: number | null
	enabled_by_user_id: string | null
	blocked: number
	authorization_revision?: number
}
export interface NewsletterRuleReview {
	id: string
	revision: number
	enabled: 0 | 1
	trigger_tag_id: string
	completion_tag_id: string | null
	on_signup: 0 | 1
	sender: string
	subject: string
	warnings: Array<string>
	ready: boolean
}
export type NewsletterStatus = "subscribed" | "pending" | "unsubscribed" | "bounced" | "complained"
export type NewsletterImportProfile = import("./newsletter_import_profiles.js").ImportProfile
export interface NewsletterImportInput {
	source_profile?: NewsletterImportProfile
	csv: string
	filename: string
	default_status: NewsletterStatus
	consent_confirmed?: boolean
	source_audience_id?: string
	mapping?: import("./newsletter_import_rules.js").ImportMapping
}
export interface NewsletterImport {
	id: string
	list_id: string
	filename: string
	total: number
	applied: number
	status?: string
	account_id: string
	source_audience_id: string | null
	content_hash: string
	summary: string
	created_at: string
}
export interface NewsletterImportPreview {
	import: NewsletterImport
	[key: string]: unknown
}
export interface NewsletterAudienceMember {
	id: string
	email: string
	name: string | null
	status: NewsletterStatus
	data: string | null
	newsletter_data: string | null
	newsletter_name: string | null
	provenance: string | null
	source: string | null
	consent_at: string | null
	subscribed_at: string | null
	tag_ids: Array<string>
	[key: string]: unknown
}
export interface NewsletterAudience {
	contacts: Array<NewsletterAudienceMember>
	total: number
	audience_total: number
	offset: number
	limit: 25
	next_offset: number | null
}
export type NewsletterRequest = <T>(
	path: string,
	init?: { method?: string; body?: unknown }
) => Promise<T>
const part = encodeURIComponent
function query(input: Record<string, string | number | undefined>) {
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(input))
		if (value !== undefined) params.set(key, String(value))
	return params.size ? `?${params}` : ""
}

/** @internal Shared resource shapes for the provider and its development capture. */
export function campaign_resources(request: NewsletterRequest) {
	const path = (id: string, operation = "") =>
		`/campaigns/${part(id)}${operation ? `/${operation}` : ""}`
	return {
		all: async () =>
			(await request<{ campaigns: Array<Campaign> }>("/campaigns", { method: "GET" })).campaigns,
		get: (id: string) => request<Campaign>(path(id), { method: "GET" }),
		create: (input: CampaignInput) =>
			request<Campaign>("/campaigns", { method: "POST", body: input }),
		/** Replace a draft using the revision returned by get/review. Never launches it. */
		update: (id: string, input: CampaignInput & { revision: number }) =>
			request<Campaign>(path(id), { method: "PUT", body: input }),
		review: (id: string) => request<CampaignReview>(path(id, "review"), { method: "GET" }),
		/** The rendered HTML document. No email is sent. */
		preview: (id: string, options: { sample_contact_id?: string } = {}) =>
			request<string>(path(id, "preview") + query(options), { method: "GET" }),
		report: (id: string) => request<CampaignReport>(path(id, "report"), { method: "GET" }),
		export: (id: string, options: { offset?: number; limit?: number } = {}) =>
			request<string>(path(id, "export") + query(options), { method: "GET" }),
		recipients: (id: string, options: { offset?: number; limit?: number } = {}) =>
			request<{ recipients: Array<Record<string, unknown>>; next_offset: number | null }>(
				path(id, "recipients") + query(options),
				{ method: "GET" }
			),
		/** Sends one test to email only. sample_contact_id supplies personalization, never routing. */
		test: (id: string, email: string, options: { sample_contact_id?: string } = {}) =>
			request<{ id: string }>(path(id, "test"), { method: "POST", body: { email, ...options } }),
		launch: (id: string, input: CampaignLaunch) =>
			request<Campaign>(path(id, "launch"), { method: "POST", body: input }),
		pause: (id: string) => request<Campaign>(path(id, "pause"), { method: "POST", body: {} }),
		resume: (id: string) => request<Campaign>(path(id, "resume"), { method: "POST", body: {} }),
		cancel: (id: string) => request<Campaign>(path(id, "cancel"), { method: "POST", body: {} }),
		duplicate: (id: string) =>
			request<Campaign>(path(id, "duplicate"), { method: "POST", body: {} }),
		/** Creates a new draft, without sending. The API needs this key to deduplicate it. */
		resend: (id: string, idempotency_key: string) =>
			request<Campaign>(path(id, "resend"), { method: "POST", body: { idempotency_key } }),
	}
}
export function newsletter_resources(request: NewsletterRequest) {
	const path = (id: string, operation = "") =>
		`/newsletters/${part(id)}${operation ? `/${operation}` : ""}`
	return {
		all: async () =>
			(await request<{ newsletters: Array<Newsletter> }>("/newsletters", { method: "GET" }))
				.newsletters,
		get: (id: string) =>
			request<{
				newsletter: Newsletter
				tags: Array<NewsletterTag>
				segments: Array<NewsletterSegment>
			}>(path(id), { method: "GET" }),
		configure: async (input: NewsletterInput) =>
			(await request<{ newsletter: Newsletter }>("/newsletters", { method: "POST", body: input }))
				.newsletter,
		audience: (id: string, options: { search?: string; offset?: number } = {}) =>
			request<NewsletterAudience>(path(id, "audience") + query(options), { method: "GET" }),
		/** Requests double opt-in. This never directly subscribes someone. */
		signup: (id: string, input: { email: string; name?: string; consent: true }) =>
			request<{ ok: true }>(path(id, "signups"), { method: "POST", body: input }),
		reconfirmation: {
			get: (id: string) =>
				request<{
					policy: NewsletterReconfirmationPolicy | null
					defaults: NewsletterReconfirmationDraft
					stats: Array<{ state: string; total: number }>
				}>(path(id, "reconfirmation"), { method: "GET" }),
			/** Saves a disabled policy. Existing policies require their current revision. */
			save: (id: string, input: NewsletterReconfirmationDraft & { revision?: number }) =>
				request<NewsletterReconfirmationPolicy>(path(id, "reconfirmation"), {
					method: "PUT",
					body: input,
				}),
			review: (id: string) =>
				request<NewsletterReconfirmationReview>(path(id, "reconfirmation/review"), {
					method: "GET",
				}),
			/** Explicit approval of the exact revision and reviewed settings. Future bounded work only. */
			enable: (id: string, input: { revision: number; review_hash: string; confirm: true }) =>
				request<NewsletterReconfirmationPolicy>(path(id, "reconfirmation/enable"), {
					method: "POST",
					body: input,
				}),
			pause: (id: string, input: { revision: number }) =>
				request<NewsletterReconfirmationPolicy>(path(id, "reconfirmation/pause"), {
					method: "POST",
					body: input,
				}),
		},
		quality: {
			get: (id: string, options: { offset?: number } = {}) =>
				request<NewsletterQuality>(path(id, "quality") + query(options), { method: "GET" }),
			/** Checks at most 200 stored addresses. Never sends mail or changes consent. */
			scan: (id: string, after?: string) =>
				request<{ checked: number; next: string | null }>(path(id, "quality"), {
					method: "POST",
					body: { operation: "scan", ...(after === undefined ? {} : { after }) },
				}),
			/** Checks at most five domains through bounded DNS. Unknown is not invalid. */
			domains: (id: string, after?: string) =>
				request<{
					checked: number
					next: string | null
					domains: Array<{
						domain: string
						state: "unknown" | "mx" | "implicit_mx" | "no_mail"
						reason: string
					}>
				}>(path(id, "quality"), {
					method: "POST",
					body: { operation: "domains", ...(after === undefined ? {} : { after }) },
				}),
			/** Explicit newsletter eligibility only. This cannot restore consent or override a delivery block. */
			decide: (id: string, email: string, decision: "exclude" | "allow") =>
				request<{ decision: "exclude" | "allow" }>(path(id, "quality"), {
					method: "POST",
					body: { operation: "decision", email, decision },
				}),
		},
		tags: {
			all: async (id: string) =>
				(await request<{ tags: Array<NewsletterTag> }>(path(id, "tags"), { method: "GET" })).tags,
			create: (
				id: string,
				name: string,
				options: { contact_ids?: Array<string>; event_id?: string } = {}
			) =>
				request<{ tag_id: string; added: number }>(path(id, "tags"), {
					method: "POST",
					body: { name, ...options },
				}),
			remove: (id: string, tag_id: string, contact_id: string) =>
				request<{ ok: true }>(path(id, "tags"), { method: "DELETE", body: { tag_id, contact_id } }),
		},
		segments: {
			all: async (id: string) =>
				(
					await request<{ segments: Array<NewsletterSegment> }>(path(id, "segments"), {
						method: "GET",
					})
				).segments,
			create: (id: string, name: string, rule: SegmentRule) =>
				request<{ id: string }>(path(id, "segments"), { method: "POST", body: { name, rule } }),
			update: (id: string, segment_id: string, name: string, rule: SegmentRule) =>
				request<{ id: string }>(path(id, `segments/${encodeURIComponent(segment_id)}`), {
					method: "PATCH",
					body: { name, rule },
				}),
		},
		rules: {
			all: async (id: string) =>
				(await request<{ rules: Array<NewsletterRule> }>(path(id, "rules"), { method: "GET" }))
					.rules,
			get: (id: string, rule_id: string) =>
				request<NewsletterRule>(path(id, `rules/${part(rule_id)}`), { method: "GET" }),
			/** Creates a paused draft. Saving never enables an automation. */
			create: (id: string, input: NewsletterRuleDraft) =>
				request<NewsletterRule>(path(id, "rules"), { method: "POST", body: input }),
			update: (id: string, rule_id: string, input: NewsletterRuleDraft & { revision: number }) =>
				request<NewsletterRule>(path(id, `rules/${part(rule_id)}`), {
					method: "PATCH",
					body: input,
				}),
			preview: (id: string, rule_id: string, input: { sample_contact_id?: string } = {}) =>
				request<{ subject: string; html: string }>(path(id, `rules/${part(rule_id)}/preview`), {
					method: "POST",
					body: input,
				}),
			review: (id: string, rule_id: string) =>
				request<NewsletterRuleReview>(path(id, `rules/${part(rule_id)}/review`), { method: "GET" }),
			/** Explicit current-revision approval. Future triggers only; never replays old intents. */
			enable: (id: string, rule_id: string, input: { revision: number; confirm: true }) =>
				request<NewsletterRule>(path(id, `rules/${part(rule_id)}/enable`), {
					method: "POST",
					body: input,
				}),
			pause: (id: string, rule_id: string, input: { revision: number }) =>
				request<NewsletterRule>(path(id, `rules/${part(rule_id)}/pause`), {
					method: "POST",
					body: input,
				}),
		},
		imports: {
			all: async (id: string) =>
				(
					await request<{ imports: Array<NewsletterImport> }>(path(id, "imports"), {
						method: "GET",
					})
				).imports,
			preview: (id: string, input: NewsletterImportInput) =>
				request<NewsletterImportPreview>(path(id, "imports"), { method: "POST", body: input }),
			/** Applies one bounded page. Repeat until status/applied shows completion. Never sends. */
			apply: (id: string, import_id: string) =>
				request<{ applied: number; remaining: number }>(path(id, `imports/${part(import_id)}`), {
					method: "POST",
					body: {},
				}),
		},
	}
}
