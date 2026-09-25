/**
 * `poll()` — the companion to `receive()` for providers that don't push webhooks.
 *
 * SMTP, Microsoft 365 and Cloudflare Email Service emit no delivery-event webhooks, but
 * each has somewhere the events can be fetched from: a POP3 bounce mailbox, the Graph
 * message-trace API, a Cloudflare Queue fed by an Email Sending event subscription.
 * Twilio is here for a different reason — its status callbacks are set per message, at
 * send time, so polling the Message resource is what makes SMS and WhatsApp delivery
 * receipts work with nothing configured and no public endpoint.
 * `poll()` fetches what's new since the last call and returns the same normalized
 * {@link WebhookEvent}s `receive()` produces, plus an opaque cursor to hand back next time.
 *
 * ```ts
 * import { poll } from "postboi/webhooks"
 *
 * const { events, cursor } = await poll({ provider: "microsoft365", cursor: saved })
 * for (const event of events) handle(event)
 * save(cursor)
 * ```
 *
 * Credentials resolve exactly like sending: explicit `options`, else the provider's own
 * environment variables ({@link POLL_FIELDS} names them per provider).
 */
import { PostboiError } from "../index.js"
import type { Channel } from "../errors.js"
import type { ProviderField, ProviderKey } from "../registry.js"
import { ensure_env_loaded, read_env } from "../env.js"
import { resolve_key, type WebhookEvent, type WebhookEventType } from "./index.js"

/** What an adapter's poll sees: resolved options, the previous cursor, a soft cap. */
export interface PollContext {
	/** Credentials/config keyed by the registry's `arg` names (api_key, account_id, …). */
	options: Record<string, string>
	/** Opaque cursor returned by the previous poll for this provider — absent on the first. */
	cursor?: string
	/** Soft cap on events per call; adapters may return fewer, never wildly more. */
	limit?: number
}

/** What one poll produced: the events, the cursor to carry forward, and whether more wait. */
export interface PollResult {
	events: Array<WebhookEvent>
	/** Hand back to the next {@link poll}. Undefined means "no state to carry". */
	cursor?: string
	/** True when the provider had more ready than `limit` allowed — poll again soon. */
	more?: boolean
}

/**
 * A provider poll adapter: fetch the delivery events that happened since `cursor`,
 * normalized. Implement this to poll a source postboi doesn't cover (and pass it straight
 * to {@link poll} as `provider`).
 */
export interface PollAdapter {
	/** Stable provider identifier used in events and errors. */
	provider: string
	poll(ctx: PollContext): Promise<PollResult>
}

/** A loaded poll module: the adapter plus its mock builder (for tests). */
export interface PollModule {
	default: PollAdapter
	/**
	 * Build a realistic {@link PollResult} for `mock_poll` — the polling analog of a mock
	 * request. `channel` picks between the channels a multi-channel provider reports on
	 * (Twilio's SMS and WhatsApp share one Message resource); adapters that only ever
	 * report on email ignore it.
	 */
	mock?: (options: { type: WebhookEventType; channel?: Channel }) => Promise<PollResult>
}

/**
 * Lazy loaders for every provider's poll adapter. Presence here is the capability signal:
 * a key in {@link POLL_MODULES} polls, a key in `MODULES` receives webhooks, and a
 * provider in neither has no delivery-event story at all.
 */
export const POLL_MODULES: Record<string, () => Promise<PollModule>> = {
	cloudflare: () => import("./poll_cloudflare.js"),
	microsoft365: () => import("./poll_microsoft365.js"),
	smtp: () => import("./poll_smtp.js"),
	twilio: () => import("./poll_twilio.js"),
}

/**
 * The configuration each poll adapter needs, keyed by provider — env var name,
 * constructor-style `arg` name, and (by the absence of a `default`) whether it's
 * required. The machine-readable half of the capability surface: callers can decide
 * whether polling is configured without loading any adapter chunk.
 *
 * Cloudflare, Microsoft 365 and Twilio reuse the registry's send credentials, so one
 * synced credential drives both send and poll. SMTP's bounce mailbox is a different
 * endpoint than the relay, so it carries its own `POP3_*` names (mirrored in the
 * registry's `smtp` fields so `postboi sync` moves them).
 */
export const POLL_FIELDS: Record<string, ReadonlyArray<ProviderField>> = {
	cloudflare: [
		{
			env: "CLOUDFLARE_API_TOKEN",
			arg: "api_key",
			label: "API token",
			secret: true,
			ambient: true,
		},
		{ env: "CLOUDFLARE_ACCOUNT_ID", arg: "account_id", label: "Account ID", ambient: true },
		{
			env: "CLOUDFLARE_QUEUE_ID",
			arg: "queue_id",
			label: "Event queue ID (optional, auto-provisioned)",
			default: "",
			ambient: true,
		},
	],
	microsoft365: [
		{ env: "MS365_TENANT_ID", arg: "tenant_id", label: "Tenant ID" },
		{ env: "MS365_CLIENT_ID", arg: "client_id", label: "Client ID" },
		{ env: "MS365_CLIENT_SECRET", arg: "client_secret", label: "Client secret", secret: true },
	],
	// The SMS/WhatsApp pair: one Message resource covers both, so one row polls both.
	// The optional messaging-service sid plays no part in reading statuses back.
	twilio: [
		{ env: "TWILIO_ACCOUNT_SID", arg: "account_sid", label: "Account SID", secret: true },
		{ env: "TWILIO_AUTH_TOKEN", arg: "auth_token", label: "Auth token", secret: true },
	],
	smtp: [
		{ env: "POP3_HOST", arg: "host", label: "Bounce mailbox host (POP3)", ambient: true },
		{ env: "POP3_PORT", arg: "port", label: "Bounce mailbox port", default: "995", ambient: true },
		{ env: "POP3_USER", arg: "user", label: "Bounce mailbox user", ambient: true },
		{
			env: "POP3_PASS",
			arg: "pass",
			label: "Bounce mailbox password",
			secret: true,
			ambient: true,
		},
		{
			env: "POP3_SECURE",
			arg: "secure",
			label: "Bounce mailbox implicit TLS (auto/true/false)",
			default: "auto",
			ambient: true,
		},
	],
}

/** Options for {@link poll}. */
export interface PollOptions {
	/**
	 * Which provider to poll — a key like `"microsoft365"`, or a custom
	 * {@link PollAdapter}. Defaults to the same resolution `mail()` and `receive()` use.
	 */
	provider?: ProviderKey | PollAdapter
	/** The cursor the previous {@link poll} returned. Omit on the first call. */
	cursor?: string
	/** Soft cap on events returned per call. */
	limit?: number
	/**
	 * Explicit configuration by `arg` name (see {@link POLL_FIELDS}); anything missing
	 * falls back to the provider's environment variables. Keys beyond the provider's
	 * fields pass through untouched (e.g. `{ delete: "1" }` for the SMTP poller).
	 */
	options?: Record<string, string>
}

/** Load the poll adapter for a provider key, or throw `polling_not_supported`. */
export async function poll_adapter_for(key: string): Promise<PollAdapter> {
	const load = POLL_MODULES[key]
	if (!load) {
		throw new PostboiError({
			provider: key,
			code: "polling_not_supported",
			message: `Provider "${key}" has no poll adapter. If it pushes webhooks, use receive() instead.`,
		})
	}
	return (await load()).default
}

/** Resolve an adapter's options from explicit values, env vars, then field defaults. */
async function resolve_options(
	adapter: PollAdapter,
	explicit: Record<string, string> = {}
): Promise<Record<string, string>> {
	await ensure_env_loaded()
	const options: Record<string, string> = { ...explicit }
	for (const field of POLL_FIELDS[adapter.provider] ?? []) {
		const value = explicit[field.arg] ?? read_env(field.env) ?? field.default
		if (value === undefined) {
			throw new PostboiError({
				provider: adapter.provider,
				code: "missing_credentials",
				message: `Polling ${adapter.provider} needs ${field.env} (or pass { options: { ${field.arg} } }).`,
			})
		}
		options[field.arg] = value
	}
	return options
}

/**
 * Fetch the delivery events that happened since `cursor` from a provider that doesn't
 * push webhooks. Returns normalized events plus the cursor to persist for the next call;
 * `more: true` means the provider had more ready than `limit` allowed — poll again soon.
 *
 * Throws `polling_not_supported` for providers that push webhooks (use `receive()`),
 * `missing_credentials` when a required env var is absent, `invalid_cursor` on a cursor
 * that doesn't parse (drop the stored cursor and retry), and `poll_provisioning_failed`
 * when Cloudflare's queue/subscription setup needs a manual step (the message says which).
 */
export async function poll(options: PollOptions = {}): Promise<PollResult> {
	const adapter =
		typeof options.provider === "object"
			? options.provider
			: await poll_adapter_for(options.provider ?? (await resolve_key()))

	return adapter.poll({
		options: await resolve_options(adapter, options.options),
		cursor: options.cursor,
		limit: options.limit,
	})
}

/** Parse a JSON cursor an adapter previously returned, or throw `invalid_cursor`. */
export function parse_cursor<T>(provider: string, cursor: string | undefined): T | undefined {
	if (cursor === undefined) return undefined
	try {
		const parsed = JSON.parse(cursor) as unknown
		if (parsed === null || typeof parsed !== "object") throw new Error("not an object")
		return parsed as T
	} catch {
		throw new PostboiError({
			provider,
			code: "invalid_cursor",
			message: `The stored ${provider} poll cursor doesn't parse. Drop it and poll again from scratch.`,
			raw: cursor,
		})
	}
}
