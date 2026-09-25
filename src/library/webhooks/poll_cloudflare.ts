/**
 * Cloudflare Email Service poll adapter — Email Sending publishes lifecycle events
 * (`cf.email.sending.message.delivered|deferred|bounced|failed|rejected|complained`) to a
 * Cloudflare Queue via an event subscription, and this adapter pulls that queue over the
 * Queues HTTP pull API. https://developers.cloudflare.com/email-service/observability/
 *
 * Provisioning: with no queue id configured, the adapter finds or creates a queue named
 * `postboi-email-events` and attaches an HTTP-pull consumer — both with the same API
 * token. The event *subscription* itself (Queues → the queue → Subscriptions → Email
 * Sending, scoped per sending domain) has no publicly documented REST shape yet, so that
 * one step stays manual: until the first event arrives (proof the subscription exists),
 * the adapter throws `poll_provisioning_failed` naming the queue and the remaining step.
 * Setting `CLOUDFLARE_QUEUE_ID` (or passing `queue_id`) skips provisioning entirely.
 *
 * Delivery contract: pulled messages are acked in-call after normalization, so events are
 * at-most-once from the library's view — persist the returned events before doing
 * anything that can fail. This queue must have no other consumer, or the two will steal
 * from each other.
 */
import { PostboiError } from "../index.js"
import type { PollAdapter, PollResult } from "./poll.js"
import { parse_cursor } from "./poll.js"
import type { WebhookEvent, WebhookEventType, BounceDetail } from "./index.js"
import { to_date } from "./shared.js"

interface Cursor {
	queue_id: string
}

const QUEUE_NAME = "postboi-email-events"
const API = "https://api.cloudflare.com/client/v4"
const DEFAULT_LIMIT = 100
const VISIBILITY_MS = 60_000

/** `cf.email.sending.message.<suffix>` → normalized type. */
const TYPES: Record<string, WebhookEventType> = {
	delivered: "delivered",
	deferred: "delayed",
	bounced: "bounced",
	failed: "failed",
	rejected: "failed",
	complained: "complained",
}

interface CfEnvelope {
	success?: boolean
	errors?: Array<{ code?: number; message?: string }>
	result?: unknown
	result_info?: { total_count?: number }
}

async function cf(
	options: Record<string, string>,
	method: string,
	path: string,
	body?: unknown
): Promise<CfEnvelope> {
	const response = await fetch(`${API}/accounts/${options.account_id}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${options.api_key}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const data = (await response.json().catch(() => undefined)) as CfEnvelope | undefined
	if (!response.ok || data?.success === false) {
		throw new PostboiError({
			provider: "cloudflare",
			status: response.status,
			code: data?.errors?.[0]?.code,
			message: data?.errors?.[0]?.message ?? `Cloudflare API request failed (${response.status})`,
			raw: data,
		})
	}
	return data ?? {}
}

/** Find or create the postboi queue and make sure it has an HTTP-pull consumer. */
async function provision(options: Record<string, string>): Promise<string> {
	try {
		const listing = await cf(options, "GET", `/queues?page=1&per_page=100`)
		const queues = (listing.result ?? []) as Array<{ queue_id?: string; queue_name?: string }>
		let queue_id = queues.find((queue) => queue.queue_name === QUEUE_NAME)?.queue_id
		if (!queue_id) {
			const created = await cf(options, "POST", `/queues`, { queue_name: QUEUE_NAME })
			queue_id = (created.result as { queue_id?: string } | undefined)?.queue_id
		}
		if (!queue_id) {
			throw new PostboiError({
				provider: "cloudflare",
				code: "poll_provisioning_failed",
				message: `Cloudflare accepted the "${QUEUE_NAME}" queue but returned no queue id.`,
			})
		}
		// The pull API only works once the queue has an http_pull consumer; creating one
		// that already exists fails, which is success for our purposes.
		await cf(options, "POST", `/queues/${queue_id}/consumers`, { type: "http_pull" }).catch(
			() => undefined
		)
		return queue_id
	} catch (error) {
		if (error instanceof PostboiError && error.code === "poll_provisioning_failed") throw error
		const detail = error instanceof Error ? error.message : String(error)
		throw new PostboiError({
			provider: "cloudflare",
			code: "poll_provisioning_failed",
			message:
				`Couldn't set up the "${QUEUE_NAME}" queue for Email Sending events: ${detail}. ` +
				`The API token needs Queues edit access. Otherwise, create a queue with an HTTP-pull consumer and an Email Sending event subscription yourself, and set CLOUDFLARE_QUEUE_ID.`,
			raw: error,
		})
	}
}

interface QueueMessage {
	body?: unknown
	lease_id?: string
	timestamp_ms?: number
}

/** The event envelope the Email Sending subscription publishes onto the queue. */
interface EmailEvent {
	type?: string
	payload?: {
		eventId?: string
		messageId?: string
		message_id?: string
		recipient?: string
		to?: string
		subject?: string
		smtpResponse?: string
		smtp_response?: string
		smtpCode?: number
		bounceType?: string
		terminal?: boolean
		timestamp?: string | number
	}
}

function bounce(kind: string, payload: EmailEvent["payload"]): BounceDetail | undefined {
	if (kind !== "bounced" && kind !== "rejected") return undefined
	const detail = payload?.smtpResponse ?? payload?.smtp_response ?? payload?.bounceType
	if (kind === "rejected") return { category: "suppressed", detail }
	const code = payload?.smtpCode ?? Number((detail ?? "").match(/^\s*(\d{3})/)?.[1])
	return {
		category: code >= 500 ? "hard" : code >= 400 ? "soft" : "hard",
		detail,
	}
}

function normalize(message: QueueMessage): WebhookEvent | undefined {
	const raw = typeof message.body === "string" ? safe_json(message.body) : message.body
	const event = (raw ?? {}) as EmailEvent
	const kind = event.type?.split(".").pop() ?? ""
	const type = TYPES[kind]
	if (!type) return undefined
	const payload = event.payload
	return {
		type,
		provider: "cloudflare",
		message_id: payload?.messageId ?? payload?.message_id,
		email: payload?.recipient ?? payload?.to,
		timestamp: to_date(payload?.timestamp ?? message.timestamp_ms),
		subject: payload?.subject,
		bounce: type === "bounced" ? bounce(kind, payload) : undefined,
		raw: raw ?? message.body,
	}
}

function safe_json(body: string): unknown {
	try {
		return JSON.parse(body)
	} catch {
		return undefined
	}
}

const adapter: PollAdapter = {
	provider: "cloudflare",

	async poll(ctx): Promise<PollResult> {
		const cursor = parse_cursor<Cursor>("cloudflare", ctx.cursor)
		const configured = ctx.options.queue_id || cursor?.queue_id
		const queue_id = configured || (await provision(ctx.options))

		const pulled = await cf(ctx.options, "POST", `/queues/${queue_id}/messages/pull`, {
			batch_size: Math.min(ctx.limit ?? DEFAULT_LIMIT, 100),
			visibility_timeout_ms: VISIBILITY_MS,
		})
		const result = (pulled.result ?? {}) as {
			messages?: Array<QueueMessage>
			message_backlog_count?: number
		}
		const messages = result.messages ?? []
		const backlog = result.message_backlog_count ?? 0

		// A freshly provisioned queue with nothing on it can't prove the (manual) event
		// subscription exists — keep saying so until the first event lands.
		if (!configured && messages.length === 0 && backlog === 0) {
			throw new PostboiError({
				provider: "cloudflare",
				code: "poll_provisioning_failed",
				message:
					`Queue "${QUEUE_NAME}" (${queue_id}) is ready, but no Email Sending events have arrived. ` +
					`Add the event subscription once (dashboard: Queues → ${QUEUE_NAME} → Subscriptions → Email Sending, or \`wrangler queues subscription create ${QUEUE_NAME} --source email.sending\`). Then this clears when the first event lands, or set CLOUDFLARE_QUEUE_ID=${queue_id} to start pulling quietly now.`,
			})
		}

		const events: Array<WebhookEvent> = []
		const leases: Array<{ lease_id: string }> = []
		for (const message of messages) {
			const event = normalize(message)
			if (event) events.push(event)
			if (message.lease_id) leases.push({ lease_id: message.lease_id })
		}
		if (leases.length > 0) {
			await cf(ctx.options, "POST", `/queues/${queue_id}/messages/ack`, { acks: leases })
		}

		return {
			events,
			cursor: JSON.stringify({ queue_id } satisfies Cursor),
			more: backlog > messages.length,
		}
	},
}

export default adapter

/** A realistic queue message run through the adapter's own normalization. */
export async function mock(options: { type: WebhookEventType }): Promise<PollResult> {
	const kind = Object.entries(TYPES).find(([, type]) => type === options.type)?.[0] ?? "delivered"
	const message: QueueMessage = {
		body: {
			type: `cf.email.sending.message.${kind}`,
			payload: {
				eventId: "mock-event-id",
				messageId: "mock-message-id",
				recipient: "recipient@example.com",
				subject: "Mock subject",
				smtpResponse: kind === "bounced" ? "550 5.1.1 mailbox unavailable" : "250 OK",
				terminal: kind !== "deferred",
				timestamp: new Date().toISOString(),
			},
		},
		lease_id: "mock-lease",
		timestamp_ms: Date.now(),
	}
	const event = normalize(message)
	return {
		events: event ? [event] : [],
		cursor: JSON.stringify({ queue_id: "mock-queue-id" } satisfies Cursor),
	}
}
