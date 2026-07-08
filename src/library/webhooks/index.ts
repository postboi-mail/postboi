/**
 * `postboi/webhooks` — receive delivery events (delivered, opened, clicked, bounced, …)
 * from your provider the same way you send: one normalized shape, any provider.
 *
 * Point the provider's webhook at an endpoint and hand the request to {@link receive}:
 *
 * ```ts
 * import { receive } from "postboi/webhooks"
 *
 * export async function POST(request: Request) {
 * 	const events = await receive(request) // verifies the signature, normalizes
 * 	for (const event of events) {
 * 		if (event.type === "opened") {
 * 			console.log(`${event.email} opened in ${event.client?.name} (${event.client?.device})`)
 * 		}
 * 	}
 * 	return new Response(JSON.stringify({ received: events.length }))
 * }
 * ```
 *
 * On SvelteKit, use the ready-made handler from `postboi/kit` instead.
 */
import { PostboiError } from "../index.js"
import type { ProviderKey } from "../registry.js"
import { load_config } from "../config.js"
import { ensure_env_loaded, read_env } from "../env.js"
import { parse_json, sns_envelope, sns_subscribe_url } from "./shared.js"
import { WebhookVerificationError } from "./errors.js"
import type { EmailClient } from "./ua.js"

export { parse_user_agent, type EmailClient } from "./ua.js"
export { WebhookVerificationError, type WebhookVerificationCode } from "./errors.js"
export { mock_event, mock_request } from "./mock.js"

/** Normalized delivery-event types, common across every provider. */
export type WebhookEventType =
	| "sent"
	| "delivered"
	| "delayed"
	| "bounced"
	| "complained"
	| "opened"
	| "clicked"
	| "unsubscribed"
	| "failed"

/** Why a message bounced, normalized across providers. */
export interface BounceDetail {
	/** Hard bounces are permanent (bad address); soft are transient (full mailbox, …). */
	category: "hard" | "soft" | "suppressed" | "unknown"
	/** The provider's own description, when it gives one. */
	detail?: string
}

/**
 * One provider delivery event, normalized. Whatever the provider, your handler sees this
 * shape — swap providers without touching webhook code, exactly like sending.
 */
export interface WebhookEvent {
	type: WebhookEventType
	/** The provider that emitted the event, e.g. "resend". */
	provider: string
	/** The provider's message id — matches the id `send()` returned, where the provider allows. */
	message_id?: string
	/** The recipient this event is about. */
	email?: string
	/** When the event happened. */
	timestamp?: Date
	/** The message subject, when the provider includes it. */
	subject?: string
	/** Tags the message was sent with, when the provider echoes them. */
	tags?: Array<string>
	/** The clicked link — `clicked` events only. */
	url?: string
	/** Bounce classification — `bounced` events only. */
	bounce?: BounceDetail
	/** The email client behind an open/click, derived locally from the user-agent. */
	client?: EmailClient
	/** The recipient IP behind an open/click, when the provider reports it. */
	ip?: string
	/** The untouched provider payload for this event — the escape hatch. */
	raw: unknown
}

/** What an adapter's `verify` sees: the raw request parts plus the resolved secret. */
export interface VerifyContext {
	/** The raw request body — signatures are computed over these exact bytes. */
	body: string
	headers: Headers
	url: URL
	secret?: string
}

/** What an adapter's `normalize` sees alongside the raw body. */
export interface NormalizeContext {
	headers: Headers
	url: URL
}

/**
 * A provider webhook adapter: verify a request's authenticity, then map its payload to
 * normalized {@link WebhookEvent}s. Implement this to receive from a provider postboi
 * doesn't cover (and pass it straight to {@link receive} as `provider`).
 */
export interface WebhookAdapter {
	/** Stable provider identifier used in events and errors. */
	provider: string
	/** SNS-wrapped providers (SES, Scaleway) — lets `receive` confirm subscriptions. */
	sns?: boolean
	/** Throw a {@link WebhookVerificationError} unless the request is authentic. */
	verify(ctx: VerifyContext): void | Promise<void>
	/** Map the raw body to normalized events (providers may batch several per request). */
	normalize(body: string, ctx: NormalizeContext): Array<WebhookEvent> | Promise<Array<WebhookEvent>>
}

/** A loaded adapter module: the adapter plus its mock-payload builder (for tests). */
export interface AdapterModule {
	default: WebhookAdapter
	/**
	 * Build a realistic signed sample request for `mock_request`. Asymmetric schemes
	 * (SendGrid ECDSA, MailPace Ed25519) generate a keypair and return the verification
	 * key as `secret`, overriding the one passed in.
	 */
	mock?: (options: {
		type: WebhookEventType
		secret: string
		url: string
	}) => Promise<{ body: string; headers?: Record<string, string>; url?: string; secret?: string }>
}

/**
 * Lazy loaders for every provider's webhook adapter, keyed like `mail()`'s providers.
 * Dynamic imports keep each adapter (and the crypto it needs) in its own chunk.
 */
export const MODULES: Record<string, () => Promise<AdapterModule>> = {
	postboi: () => import("./postboi.js"),
	resend: () => import("./resend.js"),
	sendgrid: () => import("./sendgrid.js"),
	mailgun: () => import("./mailgun.js"),
	postmark: () => import("./postmark.js"),
	brevo: () => import("./brevo.js"),
	mailersend: () => import("./mailersend.js"),
	mandrill: () => import("./mandrill.js"),
	sparkpost: () => import("./sparkpost.js"),
	mailjet: () => import("./mailjet.js"),
	mailtrap: () => import("./mailtrap.js"),
	mailpace: () => import("./mailpace.js"),
	zepto: () => import("./zepto.js"),
	elasticemail: () => import("./elasticemail.js"),
	plunk: () => import("./plunk.js"),
	ses: () => import("./ses.js"),
	scaleway: () => import("./scaleway.js"),
}

/** Options for {@link receive}. */
export interface ReceiveOptions {
	/**
	 * Which provider the request comes from — a key like `"resend"`, or a custom
	 * {@link WebhookAdapter}. Defaults to the same resolution `mail()` uses:
	 * `POSTBOI_PROVIDER`, then `postboi.config.ts`, then a `POSTBOI_TOKEN` → the
	 * Postboi provider.
	 */
	provider?: ProviderKey | "postboi" | WebhookAdapter
	/**
	 * The signing secret / verification key. Defaults to the provider's
	 * `<PROVIDER>_WEBHOOK_SECRET` environment variable.
	 */
	secret?: string
	/**
	 * Set false to skip signature verification and only normalize. Verification is
	 * otherwise required — a missing secret is an error, never a silent pass.
	 */
	verify?: boolean
}

/** Resolve the provider key the same way the zero-config `mail()` does. */
async function resolve_key(): Promise<string> {
	const config = await load_config()
	await ensure_env_loaded()
	const key =
		read_env("POSTBOI_PROVIDER") ??
		config.provider ??
		(read_env("POSTBOI_TOKEN") ? "postboi" : undefined)
	if (!key) {
		throw new PostboiError({
			provider: "postboi",
			code: "no_provider",
			message:
				"No provider configured. Run `bunx postboi init`, set POSTBOI_PROVIDER, or pass { provider } to receive().",
		})
	}
	return key
}

/** Load the adapter for a provider key, or throw `webhooks_not_supported`. */
export async function adapter_for(key: string): Promise<WebhookAdapter> {
	const load = MODULES[key]
	if (!load) {
		throw new PostboiError({
			provider: key,
			code: "webhooks_not_supported",
			message: `Provider "${key}" has no webhook support — it does not emit delivery events postboi can receive.`,
		})
	}
	return (await load()).default
}

/**
 * Verify and normalize an incoming provider webhook. Reads the request once, checks the
 * signature (fail-closed — no secret is an error unless `verify: false`), and returns the
 * normalized {@link WebhookEvent}s. SNS subscription confirmations (SES, Scaleway) are
 * confirmed automatically and return `[]`.
 *
 * Throws {@link WebhookVerificationError} on a bad signature — return a 401 for those —
 * and {@link PostboiError} (`invalid_payload`) on a body that doesn't parse.
 */
export async function receive(
	request: Request,
	options: ReceiveOptions = {}
): Promise<Array<WebhookEvent>> {
	const adapter =
		typeof options.provider === "object"
			? options.provider
			: await adapter_for(options.provider ?? (await resolve_key()))

	await ensure_env_loaded()
	const secret =
		options.secret ?? read_env(`${adapter.provider.toUpperCase()}_WEBHOOK_SECRET`) ?? undefined

	const body = await request.text()
	const url = new URL(request.url)
	const ctx: VerifyContext = { body, headers: request.headers, url, secret }

	if (options.verify !== false) {
		if (!secret) {
			throw new WebhookVerificationError({
				provider: adapter.provider,
				message: `No webhook secret configured for ${adapter.provider}. Set ${adapter.provider.toUpperCase()}_WEBHOOK_SECRET or pass { secret } — or { verify: false } to explicitly skip verification.`,
				code: "missing_secret",
			})
		}
		await adapter.verify(ctx)
	}

	// SNS wraps events in an envelope; a SubscriptionConfirmation just needs its URL hit.
	if (adapter.sns) {
		const envelope = sns_envelope(parse_json(adapter.provider, body))
		const subscribe = envelope && sns_subscribe_url(envelope)
		if (subscribe) {
			await fetch(subscribe)
			return []
		}
	}

	return adapter.normalize(body, { headers: request.headers, url })
}
