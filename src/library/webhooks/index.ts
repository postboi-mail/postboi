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
import type { Channel } from "../errors.js"
import type { ProviderKey, SmsProviderKey, WhatsappProviderKey } from "../registry.js"
import { load_config } from "../config.js"
import { ensure_env_loaded, read_env } from "../env.js"
import { parse_json, sns_envelope, sns_subscribe_url } from "./shared.js"
import { timing_safe_equal } from "./crypto.js"
import { WebhookVerificationError } from "./errors.js"
import type { EmailClient } from "./ua.js"

export { parse_user_agent, type EmailClient } from "./ua.js"
export { WebhookVerificationError, type WebhookVerificationCode } from "./errors.js"
export { mock_event, mock_request, mock_poll } from "./mock.js"
export {
	poll,
	poll_adapter_for,
	POLL_MODULES,
	POLL_FIELDS,
	type PollAdapter,
	type PollContext,
	type PollResult,
	type PollModule,
	type PollOptions,
} from "./poll.js"
export { parse_dsn } from "./dsn.js"
import { POLL_MODULES } from "./poll.js"

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
	/**
	 * Mail arriving at your sending address — the one event that isn't about a
	 * send. `email` is the person who wrote to you, not a recipient, and
	 * `message_id` is the send being replied to when the provider can tell.
	 * The Postboi provider, Lettermint and Sequenzy (a tracked reply); on WhatsApp
	 * via Meta it is a message to your number, with the person in `phone`. Providers
	 * without inbound never emit it.
	 */
	| "received"

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
	/**
	 * The recipient this event is about — on `received`, the sender who wrote to you.
	 * Unset on `sms` and `whatsapp` events, where the person is in `phone`.
	 */
	email?: string
	/**
	 * Which channel this event is about. Absent means email — every provider that
	 * predates multi-channel delivery events leaves it unset, and email is what they
	 * were all about.
	 */
	channel?: Channel
	/**
	 * The number this event is about, for `sms` and `whatsapp` events — in E.164, and
	 * without the `whatsapp:` prefix Twilio addresses carry. Deliberately not `email`:
	 * a handler that reads `event.email` should never be handed a phone number.
	 */
	phone?: string
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
	/** The message body — `received` events only, when the provider includes it. */
	body?: { html?: string; text?: string }
	/**
	 * The form a submission was filed under — Postboi provider events about a send that
	 * named one (`mail({ form })`) or came through a hosted endpoint.
	 */
	form?: { id: string; name: string }
	/**
	 * A submission's fields as data, `[name, value]` pairs in the order they were
	 * submitted — the same entries the rendered table was drawn from. Postboi provider
	 * events only, on the same sends `form` is set for.
	 */
	fields?: Array<[string, string]>
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
	/**
	 * Providers that check an endpoint is yours before subscribing it with a bare GET
	 * (Meta): recognise that request and return the challenge it wants echoed plus the
	 * token it presented, or `undefined` for a request that isn't one. Nothing is signed
	 * yet at that point, so {@link handshake} does the comparing — fail-closed and
	 * timing-safe, like `verify` — and an adapter only has to read the URL. A handshake
	 * that arrives as a *signed* POST is `respond`'s job instead.
	 */
	handshake?(ctx: NormalizeContext): { challenge: string; token?: string } | undefined
	/**
	 * The response a request needs in the provider's own words, when it is not an event
	 * but a handshake — SocketLabs validates an endpoint by expecting its `ValidationKey`
	 * echoed back. Consulted by the `webhook()` handler after verification; undefined
	 * means the usual `{ received }` answer.
	 */
	respond?(body: string, ctx: NormalizeContext): Response | undefined
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
		/**
		 * Which channel the sample is about, for providers whose payloads cover more
		 * than email (the Postboi provider's `sms.*` / `whatsapp.*`). Without it the
		 * shared normalized types map back to more than one wire type, and the sample
		 * would be whichever the table happened to list first.
		 */
		channel?: Channel
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
	lettermint: () => import("./lettermint.js"),
	unosend: () => import("./unosend.js"),
	sequenzy: () => import("./sequenzy.js"),
	loops: () => import("./loops.js"),
	smtp2go: () => import("./smtp2go.js"),
	socketlabs: () => import("./socketlabs.js"),
	azure: () => import("./azure.js"),
	postal: () => import("./postal.js"),
	customerio: () => import("./customerio.js"),
	ahasend: () => import("./ahasend.js"),
	infobip: () => import("./infobip.js"),
	sendpulse: () => import("./sendpulse.js"),
	zepto: () => import("./zepto.js"),
	elasticemail: () => import("./elasticemail.js"),
	plunk: () => import("./plunk.js"),
	ses: () => import("./ses.js"),
	scaleway: () => import("./scaleway.js"),
	// The channel providers that push. Twilio reports both its channels by `poll()`;
	// Meta's Cloud API pushes a real webhook, keyed like `whatsapp()`'s provider, and
	// The SMS Works pushes account-wide SMS delivery reports, keyed like `sms()`'s.
	meta: () => import("./meta.js"),
	smsworks: () => import("./smsworks.js"),
}

/** Options for {@link receive}. */
export interface ReceiveOptions {
	/**
	 * Which provider the request comes from — a key like `"resend"`, a channel one that
	 * pushes (`"meta"`, `"smsworks"`), or a custom {@link WebhookAdapter}. Defaults to
	 * the same resolution `mail()` uses: `POSTBOI_PROVIDER`, then `postboi.config.ts`,
	 * then a `POSTBOI_TOKEN` → the Postboi provider — and, only when none of those
	 * names an email provider, the WhatsApp provider (`POSTBOI_WHATSAPP_PROVIDER` /
	 * `whatsapp.provider`) or the SMS provider (`POSTBOI_SMS_PROVIDER` / `sms.provider`)
	 * when it pushes webhooks. A project with both names the channel one here: the
	 * endpoint Meta or The SMS Works calls is never the one the email provider calls.
	 * A key with no adapter (Twilio types but polls) is a `webhooks_not_supported`
	 * error at runtime, not a type error — `poll()` is where its receipts are.
	 */
	provider?: ProviderKey | SmsProviderKey | WhatsappProviderKey | "postboi" | WebhookAdapter
	/**
	 * The signing secret / verification key. Defaults to the provider's
	 * `<PROVIDER>_WEBHOOK_SECRET` environment variable. For Svix-style providers
	 * (the Postboi provider, Resend) this may be several whitespace- or comma-separated
	 * secrets — any that verifies passes, so one handler can serve multiple endpoints
	 * or ride out a secret rotation.
	 */
	secret?: string
	/**
	 * The token a provider's endpoint {@link handshake} must present (Meta's verify
	 * token — a string you choose and type into the app dashboard). Defaults to
	 * `<PROVIDER>_WEBHOOK_VERIFY_TOKEN`. Separate from `secret` on purpose: it travels
	 * in a query string, and query strings end up in access logs.
	 */
	verify_token?: string
	/**
	 * Set false to skip signature verification and only normalize. Verification is
	 * otherwise required — a missing secret is an error, never a silent pass.
	 */
	verify?: boolean
}

/**
 * Resolve the provider key the same way the zero-config `mail()` does. A project with
 * no email provider at all falls through to its WhatsApp one, if that pushes webhooks
 * (Meta does; Twilio polls) — so a WhatsApp-only app gets zero-config `receive()` too.
 */
export async function resolve_key(): Promise<string> {
	const config = await load_config()
	await ensure_env_loaded()
	const email =
		read_env("POSTBOI_PROVIDER") ??
		config.provider ??
		(read_env("POSTBOI_TOKEN") ? "postboi" : undefined)
	// A channel provider stands in only when it pushes: Twilio names itself on both
	// channels and polls, so it is never the answer here.
	const pushes = (key: string | undefined) => (key && key in MODULES ? key : undefined)
	const whatsapp = pushes(read_env("POSTBOI_WHATSAPP_PROVIDER") ?? config.whatsapp?.provider)
	const sms = pushes(read_env("POSTBOI_SMS_PROVIDER") ?? config.sms?.provider)
	const key = email ?? whatsapp ?? sms
	if (!key) {
		throw new PostboiError({
			provider: "postboi",
			code: "no_provider",
			message:
				"No provider configured. Run `bunx postboi init`, set POSTBOI_PROVIDER (or POSTBOI_WHATSAPP_PROVIDER=meta / POSTBOI_SMS_PROVIDER=smsworks), or pass { provider } to receive().",
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
			message:
				key in POLL_MODULES
					? `Provider "${key}" doesn't push webhooks — it reports delivery by polling. Use poll() from postboi/webhooks instead.`
					: `Provider "${key}" has no webhook support — it does not emit delivery events postboi can receive.`,
		})
	}
	return (await load()).default
}

/** The adapter `provider` names — a key, a custom adapter, or the zero-config resolution. */
export async function resolve_adapter(
	provider?: ReceiveOptions["provider"]
): Promise<WebhookAdapter> {
	return typeof provider === "object" ? provider : adapter_for(provider ?? (await resolve_key()))
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
	const adapter = await resolve_adapter(options.provider)

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

/**
 * Answer a provider's endpoint handshake — the GET Meta makes once, when the callback
 * URL is saved, to check the endpoint is yours before it subscribes it. Returns the
 * challenge to send back as the response body (200, plain text), or `undefined` when
 * the request isn't a handshake at all: not a GET, a provider that never does one, or a
 * GET without the handshake's parameters. So a handler can try this first and fall
 * through to {@link receive}; `webhook()` does exactly that.
 *
 * The presented token is compared (timing-safe) with `verify_token` — defaulting to
 * `<PROVIDER>_WEBHOOK_VERIFY_TOKEN` — and, like signatures, this fails closed: no
 * configured token throws rather than confirming a stranger's subscription. Throws
 * {@link WebhookVerificationError} on a mismatch — return a 401 for those.
 *
 * `verify: false` does not apply here. It exists to normalize a payload you already
 * trust (a replay, a local experiment), and a handshake has no payload: echoing any
 * challenge would let whoever found the URL subscribe it to their own app.
 */
export async function handshake(
	request: Request,
	options: ReceiveOptions = {}
): Promise<string | undefined> {
	// Every handshake we know of rides the query string; a bare GET (a health check, a
	// browser) is turned away before any adapter is resolved or loaded for it.
	if (request.method !== "GET") return undefined
	const url = new URL(request.url)
	if (!url.search) return undefined

	const adapter = await resolve_adapter(options.provider)
	if (!adapter.handshake) return undefined
	const presented = adapter.handshake({ headers: request.headers, url })
	if (!presented) return undefined

	await ensure_env_loaded()
	const env = `${adapter.provider.toUpperCase()}_WEBHOOK_VERIFY_TOKEN`
	const expected = options.verify_token ?? read_env(env) ?? undefined
	if (!expected) {
		throw new WebhookVerificationError({
			provider: adapter.provider,
			message: `No webhook verify token configured for ${adapter.provider}. Set ${env} to the verify token you gave the provider, or pass { verify_token }.`,
			code: "missing_secret",
		})
	}
	if (!presented.token || !timing_safe_equal(presented.token, expected)) {
		throw new WebhookVerificationError({
			provider: adapter.provider,
			message: `${adapter.provider} webhook verify token did not match`,
			code: "invalid_signature",
		})
	}
	return presented.challenge
}

export { webhook, type RequestCarrier } from "./handler.js"
