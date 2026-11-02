import type { NewsletterRequest } from "./newsletters.js"
export interface Publication {
	id: string
	account_id: string
	list_id: string
	slug: string
	title: string
	description: string
	author: string
	author_bio: string
	author_url: string
	author_avatar: string
	share_image: string
	enabled: 0 | 1
	retention_days: 0 | 30 | 90 | 365
	created_at: string
	updated_at: string
}
export interface PublicationInput {
	slug: string
	title: string
	enabled: boolean
	/** Required when enabled. Acknowledges the public publication and author details. */
	confirm?: true
	description?: string
	author?: string
	author_bio?: string
	author_url?: string
	author_avatar?: string
	share_image?: string
	retention_days?: 0 | 30 | 90 | 365
}
export interface PublicationIssueSummary {
	id: string
	campaign_id: string
	slug: string
	subject: string
	visibility: "listed" | "unlisted"
	published_at: string
	expires_at: string | null
}
export interface PublicationIssue extends PublicationIssueSummary {
	publication_id: string
	revision: number
	summary: string
	html: string
	text: string
}
export interface PublicationReview {
	revision: number
	subject: string
	html: string
	text: string
	warnings: Array<string>
}
export interface PublicationApproval {
	revision: number
	slug: string
	summary: string
	visibility: "listed" | "unlisted"
	confirm: true
}
/** Hosted public pages only. Local capture never publishes a copy or falls back to hosted requests. */
export function publication_resources(request: NewsletterRequest) {
	const path = (list_id: string) => `/publications/${encodeURIComponent(list_id)}`
	const issue = (list_id: string, campaign_id: string) =>
		`${path(list_id)}/issues/${encodeURIComponent(campaign_id)}`
	return {
		all: async () =>
			(await request<{ publications: Array<Publication> }>("/publications", { method: "GET" }))
				.publications,
		get: (list_id: string) => request<Publication>(path(list_id), { method: "GET" }),
		configure: (list_id: string, input: PublicationInput) =>
			request<Publication>(path(list_id), { method: "PUT", body: input }),
		issues: {
			all: (list_id: string, options: { offset?: number } = {}) =>
				request<{
					issues: Array<PublicationIssueSummary>
					offset: number
					limit: 100
					next_offset: number | null
				}>(
					`${path(list_id)}/issues${options.offset === undefined ? "" : `?offset=${encodeURIComponent(options.offset)}`}`,
					{ method: "GET" }
				),
			get: (list_id: string, campaign_id: string) =>
				request<PublicationIssue>(issue(list_id, campaign_id), { method: "GET" }),
			/** Inert generic public copy. No subscriber values and no publication. */
			review: (list_id: string, campaign_id: string, revision: number) =>
				request<PublicationReview>(
					`${issue(list_id, campaign_id)}/review?revision=${encodeURIComponent(revision)}`,
					{ method: "GET" }
				),
			publish: (list_id: string, campaign_id: string, input: PublicationApproval) =>
				request<{ ok: true; url: string }>(issue(list_id, campaign_id), {
					method: "POST",
					body: input,
				}),
			unpublish: (list_id: string, campaign_id: string) =>
				request<{ ok: true }>(issue(list_id, campaign_id), { method: "DELETE" }),
		},
	}
}
