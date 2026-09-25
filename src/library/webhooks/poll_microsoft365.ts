/**
 * Microsoft 365 poll adapter — the Graph message-trace API stands in for the webhooks
 * Exchange Online doesn't send. https://learn.microsoft.com/graph/api/resources/exchangemessagetrace
 *
 * One-time tenant setup beyond the send credentials:
 * - grant the app registration the **ExchangeMessageTrace.Read.All** application
 *   permission (admin-consented), and
 * - provision a service principal for Microsoft app id
 *   `8bd644d1-64a1-4d4b-ae52-2e0cbf64e373` (see the onboarding guide; takes effect
 *   within hours).
 *
 * Traces mutate in place — a message sits `pending` until its terminal status lands — so
 * the cursor re-reads a 30-minute overlap window and only ever emits terminal statuses,
 * deduplicating with the trace ids already reported. Budget: one poll costs one token
 * fetch (cached) plus a few pages, against a tenant limit of 100 requests per 5 minutes.
 */
import { PostboiError } from "../index.js"
import type { PollAdapter, PollResult } from "./poll.js"
import { parse_cursor } from "./poll.js"
import type { WebhookEvent } from "./index.js"
import { to_date } from "./shared.js"

interface Cursor {
	/** Start of the next query window (ISO). */
	since: string
	/** Trace ids already emitted, with the trace's receivedDateTime (ms) for pruning. */
	seen: Array<[id: string, received: number]>
}

interface Trace {
	id?: string
	senderAddress?: string
	recipientAddress?: string
	messageId?: string
	receivedDateTime?: string
	subject?: string
	status?: string
}

/** Trace statuses that are final, and what they normalize to. Anything else is in flight. */
const TERMINAL: Record<string, WebhookEvent["type"]> = {
	delivered: "delivered",
	failed: "bounced",
	quarantined: "failed",
	filteredasspam: "failed",
}

const GRAPH = "https://graph.microsoft.com"
/** Re-read this far behind `since` so a status that landed late still gets reported. */
const OVERLAP_MS = 30 * 60 * 1000
/** First poll looks back this far; pass an explicit cursor to reach further (90d max). */
const FIRST_WINDOW_MS = 60 * 60 * 1000
const PAGE_SIZE = 1000
const MAX_PAGES = 5

// Same client-credentials flow as the Microsoft365 provider (src/library/microsoft365.ts);
// duplicated rather than shared so the poller stays inside the webhooks chunk.
const tokens = new Map<string, { value: string; expires: number }>()
async function access_token(options: Record<string, string>): Promise<string> {
	const key = `${options.tenant_id}:${options.client_id}`
	const cached = tokens.get(key)
	if (cached && Date.now() < cached.expires) return cached.value

	const response = await fetch(
		`https://login.microsoftonline.com/${options.tenant_id}/oauth2/v2.0/token`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: options.client_id,
				client_secret: options.client_secret,
				scope: "https://graph.microsoft.com/.default",
				grant_type: "client_credentials",
			}),
		}
	)
	const data = (await response.json().catch(() => undefined)) as
		| { access_token?: string; expires_in?: number; error?: string; error_description?: string }
		| undefined
	if (!response.ok || !data?.access_token) {
		throw new PostboiError({
			provider: "microsoft365",
			status: response.status,
			message: data?.error_description ?? "Failed to obtain Microsoft Graph access token",
			code: data?.error,
			raw: data,
		})
	}
	tokens.set(key, {
		value: data.access_token,
		expires: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
	})
	return data.access_token
}

const adapter: PollAdapter = {
	provider: "microsoft365",

	async poll(ctx): Promise<PollResult> {
		const cursor = parse_cursor<Cursor>("microsoft365", ctx.cursor)
		const now = new Date()
		const since = cursor?.since ? new Date(cursor.since) : new Date(now.getTime() - FIRST_WINDOW_MS)
		// Graph caps one query at 10 days; older ground is re-covered on later polls.
		const floor = new Date(now.getTime() - 10 * 24 * 3600 * 1000 + 60_000)
		const start = new Date(Math.max(since.getTime() - OVERLAP_MS, floor.getTime()))
		const seen = new Set((cursor?.seen ?? []).map(([id]) => id))

		const token = await access_token(ctx.options)
		const filter = `receivedDateTime ge ${start.toISOString()} and receivedDateTime le ${now.toISOString()}`
		let url: string | undefined =
			`${GRAPH}/v1.0/admin/exchange/tracing/messageTraces?$filter=${encodeURIComponent(filter)}&$top=${PAGE_SIZE}`

		const events: Array<WebhookEvent> = []
		const emitted: Array<{ id: string; received: number }> = []
		let truncated = false

		for (let page = 0; url && page < MAX_PAGES; page++) {
			const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
			const data = (await response.json().catch(() => undefined)) as
				| {
						value?: Array<Trace>
						"@odata.nextLink"?: string
						error?: { code?: string; message?: string }
				  }
				| undefined
			if (response.status === 403) {
				throw new PostboiError({
					provider: "microsoft365",
					status: 403,
					code: data?.error?.code ?? "forbidden",
					message:
						"Graph refused the message-trace query. Grant the app the ExchangeMessageTrace.Read.All application permission (admin consent) and provision the service principal for app id 8bd644d1-64a1-4d4b-ae52-2e0cbf64e373. Provisioning can take a few hours.",
					raw: data,
				})
			}
			if (!response.ok) {
				throw new PostboiError({
					provider: "microsoft365",
					status: response.status,
					code: data?.error?.code,
					message: data?.error?.message ?? "Graph message-trace query failed",
					raw: data,
				})
			}

			for (const trace of data?.value ?? []) {
				const type = TERMINAL[trace.status?.toLowerCase() ?? ""]
				// Pending (and any unknown in-flight status) is picked up once terminal.
				if (!type || !trace.id || seen.has(trace.id)) continue
				if (ctx.limit !== undefined && events.length >= ctx.limit) {
					truncated = true
					break
				}
				events.push({
					type,
					provider: "microsoft365",
					message_id: trace.messageId,
					email: trace.recipientAddress,
					timestamp: to_date(trace.receivedDateTime),
					subject: trace.subject,
					bounce: type === "bounced" ? { category: "unknown", detail: trace.status } : undefined,
					raw: trace,
				})
				emitted.push({
					id: trace.id,
					received: to_date(trace.receivedDateTime)?.getTime() ?? now.getTime(),
				})
			}
			if (truncated) break
			url = data?.["@odata.nextLink"]
		}

		// Next window starts one overlap behind now (or stays put when truncated, so the
		// backlog is re-read); seen ids prune themselves once their trace falls out of
		// the ground the next query re-covers.
		const next_since = truncated ? start : new Date(now.getTime() - OVERLAP_MS)
		const window_floor = next_since.getTime() - OVERLAP_MS
		const kept = new Map<string, number>()
		for (const [id, received] of cursor?.seen ?? []) {
			if (received >= window_floor) kept.set(id, received)
		}
		for (const entry of emitted) {
			if (entry.received >= window_floor) kept.set(entry.id, entry.received)
		}
		const next: Cursor = {
			since: next_since.toISOString(),
			seen: [...kept.entries()].slice(-2000),
		}

		return {
			events,
			cursor: JSON.stringify(next),
			more: truncated || Boolean(url),
		}
	},
}

export default adapter

/** A realistic Graph trace item run through the adapter's own mapping. */
export async function mock(options: { type: WebhookEvent["type"] }): Promise<PollResult> {
	const status =
		options.type === "delivered"
			? "delivered"
			: options.type === "failed"
				? "quarantined"
				: "failed"
	const trace: Trace = {
		id: "mock-trace-id",
		senderAddress: "no-reply@example.com",
		recipientAddress: "recipient@example.com",
		messageId: "<mock-message-id@example.com>",
		receivedDateTime: new Date().toISOString(),
		subject: "Mock subject",
		status,
	}
	const type = TERMINAL[status]
	return {
		events: [
			{
				type,
				provider: "microsoft365",
				message_id: trace.messageId,
				email: trace.recipientAddress,
				timestamp: to_date(trace.receivedDateTime),
				subject: trace.subject,
				bounce: type === "bounced" ? { category: "unknown", detail: status } : undefined,
				raw: trace,
			},
		],
		cursor: JSON.stringify({
			since: new Date().toISOString(),
			seen: [["mock-trace-id", Date.now()]],
		}),
	}
}
