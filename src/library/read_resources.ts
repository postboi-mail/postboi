import type { NewsletterRequest } from "./newsletters.js"
export interface MigrationStatus {
	id: string
	provider: "mailchimp" | "activecampaign"
	status:
		| "inventory"
		| "inventory_ready"
		| "staging"
		| "review"
		| "applying"
		| "complete"
		| "paused"
		| "failed"
	retry_at: string | null
	error: string | null
	created_at: string
	updated_at: string
}
export interface MigrationCounts {
	total: number
	subscribed: number
	pending: number
	unsubscribed: number
	globally_blocked: number
	unknown?: number
}
export interface MigrationReview {
	job: MigrationStatus
	counts: Array<{ kind: string; count: number; applied: number }>
	lists: Array<{
		id: string
		name: string
		member_count: number
		destination_id: string | null
		destination_name: string | null
	}>
	audiences: Array<{
		list_id: string
		name: string
		destination_id: string | null
		destination_name: string | null
		source: MigrationCounts
		destination: MigrationCounts | null
		unknown_field_values: number
		explanation: string
	}>
	sample: Array<{ kind: string; scope: string; source_id: string; value: unknown }>
	warnings: Array<string>
	unsupported: Array<{ kind: string; count: number }>
	remaining_tasks: number
	opt_out_fields: Array<{
		list_id: string
		list_name: string
		fields: Array<{ key: string; label: string; affected: number }>
		decision: string | null
	}>
}
export interface MigrationPage {
	migrations: Array<MigrationStatus>
	offset: number
	limit: 50
	next_offset: number | null
}
export interface MigrationSourcePage {
	resources: Array<{
		cursor: number
		kind: string
		scope: string
		source_id: string
		value: unknown
	}>
	next: string | null
}
export interface PostmasterPoint {
	date: string
	spam_rate: number
}
export interface PostmasterDomain {
	domain_id: string
	domain: string
	verification: string
	state: string
	synced_at: string | null
	last_attempt_at: string | null
	last_error: string | null
	compliance: Array<{
		scope: "domain" | "subdomain"
		domain: string
		requirement: string
		status: "COMPLIANT" | "NEEDS_WORK" | "UNKNOWN"
	}>
	latest: PostmasterPoint | null
	signal: "disconnected" | "reconnect" | "error" | "missing" | "stale" | "attention" | "reported"
}
export interface PostmasterPage {
	domains: Array<PostmasterDomain>
	offset: number
	limit: 25
	next_offset: number | null
	limitations: Array<string>
}
export interface PostmasterReport {
	domain: PostmasterDomain
	points: Array<PostmasterPoint>
	limitations: Array<string>
}
export interface PostmasterFeedback {
	points: Array<{
		domain: string
		feedback_id: string
		scope: string
		campaign_id: string | null
		date: string
		spam_rate: number
		fetched_at: string
		local_native_gmail_accepted: number
		observation: "stale" | "reported"
	}>
	holds: Array<{
		id: string
		scope: string
		campaign_id: string
		domain: string
		feedback_id: string
		through_date: string
		reason: string
		held_at: string
		released_at: string | null
	}>
	jobs: Array<{
		domain: string
		state: string
		synced_at: string | null
		last_attempt_at: string | null
		last_error: string | null
	}>
	policy: { enabled: boolean }
	offset: number
	limit: 25
	next_offset: number | null
	limitations: Array<string>
}
function query(input: Record<string, string | number | undefined>) {
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(input))
		if (value !== undefined) params.set(key, String(value))
	return params.size ? `?${params}` : ""
}
/** Retained provider migration reads. Connecting and applying require the interactive dashboard. */
export function migration_resources(request: NewsletterRequest) {
	return {
		list: (input: { offset?: number } = {}) =>
			request<MigrationPage>(`/migrations${query(input)}`, { method: "GET" }),
		review: async (id: string) =>
			(
				await request<{ migration: MigrationReview }>(`/migrations/${encodeURIComponent(id)}`, {
					method: "GET",
				})
			).migration,
		/** One retained private source record per page. Never execute its original HTML or reader links. */
		export: (id: string, input: { after?: string } = {}) =>
			request<MigrationSourcePage>(`/migrations/${encodeURIComponent(id)}/export${query(input)}`, {
				method: "GET",
			}),
	}
}
/** Read cached Google observations. These methods never call Google or alter sending policy. */
export function postmaster_resources(request: NewsletterRequest) {
	return {
		list: (input: { offset?: number } = {}) =>
			request<PostmasterPage>(`/postmaster${query(input)}`, { method: "GET" }),
		report: (domain_id: string) =>
			request<PostmasterReport>(`/postmaster/${encodeURIComponent(domain_id)}`, { method: "GET" }),
		feedback: (input: { offset?: number } = {}) =>
			request<PostmasterFeedback>(`/postmaster/feedback${query(input)}`, { method: "GET" }),
	}
}
