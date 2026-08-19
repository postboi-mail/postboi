import { title, escape_html, escape_lines, html_to_text } from "./utils.js"
import { config_loaded, get_config } from "./config.js"
import { check_captcha, merge_captcha, type CaptchaMode, type CaptchaOptions } from "./captcha.js"
import { ensure_env_loaded } from "./env.js"
import { PostboiError, SpamError, type Channel } from "./errors.js"
import {
	Transport,
	type BatchResult,
	type Duration,
	type RecipientVars,
	type RequestSpec,
	type TransportOptions,
} from "./transport.js"
// Type-only: the SMS channel's prepared shape widens `Hooks`, without pulling the SMS
// provider into the email module graph.
import type { PreparedSms } from "./sms/types.js"
import type { PreparedChat } from "./chat/types.js"
import type { PreparedPush } from "./push/types.js"
import type { PreparedWhatsapp } from "./whatsapp/types.js"

// The SMS channel's public types, surfaced from the root alongside the email ones.
export type {
	Phone,
	PreparedSms,
	SmsDefaults,
	SmsOptions,
	SmsProviderOptions,
	SmsApiKeyOptions,
} from "./sms/types.js"

// The chat channel's public types.
export type {
	ChatDefaults,
	ChatOptions,
	ChatProviderOptions,
	PreparedChat,
	WebhookChatOptions,
} from "./chat/types.js"

// The push channel's public types.
export type {
	PushDefaults,
	PushOptions,
	PushPayload,
	PushProviderOptions,
	PushTarget,
	PreparedPush,
	WebPushOptions,
	WebPushSubscription,
} from "./push/types.js"

// The WhatsApp channel's public types.
export type {
	PreparedWhatsapp,
	WhatsappDefaults,
	WhatsappOptions,
	WhatsappProviderOptions,
} from "./whatsapp/types.js"

// Errors are shared across every channel, but the package root stays their public home.
export {
	PostboiError,
	SkipSendError,
	SpamError,
	is_error,
	is_spam,
	type Channel,
	type ProviderError,
} from "./errors.js"
// The channel-agnostic base and the types that go with it. `Transport` is exported so a
// third party can implement a channel we don't ship.
export {
	Transport,
	type BatchResult,
	type Duration,
	type RecipientVars,
	type RequestSpec,
	type TransportHooks,
	type TransportOptions,
} from "./transport.js"

// Global configuration (`postboi.config.ts`) is part of the public surface from the package root.
export { configure, config, type PostboiConfig } from "./config.js"
// Spam protection (honeypot + Turnstile) is part of the public surface too.
export {
	HONEYPOT_FIELD,
	TURNSTILE_FIELD,
	TURNSTILE_REMOTE_FIELD,
	type CaptchaOptions,
} from "./captcha.js"
// The publishable key `bunx postboi sync` bakes in for the <Captcha /> components.
export { captcha_key } from "./register.js"
// The table renderer escapes for you; these are for hand-rolled HTML bodies that
// interpolate user input, so callers don't reinvent them (usually incompletely).
export { escape_html, escape_lines } from "./utils.js"

/**
 * A concrete email address used by providers.
 */
export type MailAddress = { address: string; name?: string }

/**
 * An email attachment payload all providers can consume.
 * content must be base64 encoded.
 */
export type MailAttachment = { name: string; content: string; mime_type: string }

/**
 * A flexible email value accepted by the public API.
 * You can pass either a plain string address or an object with an optional display name.
 * Also supports display-name format: "Full Name <email@domain>" or 'Full Name <email@domain>'.
 */
export type Email = MailAddress | string

/**
 * Type registry filled in by the generated types (the Postboi provider only — `bunx postboi sync`
 * writes them into this package's own `register.d.ts` in node_modules). When it declares a
 * `from` member, every `from` field in the API narrows to your permitted sending addresses.
 *
 * A `template` member does the same for WhatsApp. Those are approved at Meta or Twilio
 * rather than here, so sync fetches them from the platform with the credentials already in
 * your env — see {@link WhatsappTemplate}.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- empty on purpose: augmentation target
export interface Register {}

/**
 * The `from` addresses your account can send from, per the generated types — or any
 * {@link Email} when none have been generated (bring-your-own-provider setups, fresh
 * installs). If a genuinely valid address is rejected here, the generated types are
 * stale: run `bunx postboi sync` to regenerate them after adding or removing domains.
 */
export type FromAddress = Register extends { from: infer F extends string }
	? F | { address: F; name?: string }
	: Email

/**
 * The WhatsApp templates you can send, per the generated types — or any string when none
 * have been generated. `bunx postboi sync` reads them from Meta or Twilio directly (they
 * live there, not on your Postboi account), so a misspelled template is a type error
 * rather than a failed send. If a genuinely approved template is rejected here, the
 * generated types are stale: re-run sync.
 *
 * A raw Twilio Content SID stays valid whatever's been generated — it's what the API
 * takes, and a template approved since the last sync has no name here yet.
 */
export type WhatsappTemplate = Register extends { template: infer T extends string }
	? T | `HX${string}`
	: string

/**
 * The variables one WhatsApp template takes, per the generated types — the placeholder
 * names in its approved body, so they're required rather than guessed at. Any
 * `Record<string, string>` when nothing has been generated, or when the template isn't one
 * sync knows about (a raw Twilio `HX…`, say).
 *
 * A template with no placeholders resolves to `Record<never, string>`, which is how
 * passing variables to a template that takes none becomes a type error too.
 */
export type TemplateVariables<T extends string> = Register extends {
	template_variables: infer M
}
	? T extends keyof M
		? M[T] extends string
			? Record<M[T], string>
			: Record<string, string>
		: Record<string, string>
	: Record<string, string>

/**
 * A plain object of form fields — e.g. Express/multer's `req.body`. Passed as a `body`, it's
 * normalised to FormData and parsed the same way (special fields extracted, the rest tabled).
 * Repeated fields come through as arrays.
 */
export type FormFields = Record<string, string | Array<string>>

/** Everything accepted as a message `body`: rendered HTML, or form fields to render. */
export type BodyInput = string | FormData | FormFields

/**
 * Per-send open/click tracking flags for {@link SendOptions.tracking}. Leave a flag unset
 * to keep the provider's own default for it.
 */
export interface Tracking {
	/** Track opens for this message (tracking-pixel injection, where the provider supports it). */
	opens?: boolean
	/** Track link clicks for this message (link rewriting, where the provider supports it). */
	clicks?: boolean
}

/**
 * Options accepted by Postboi.send(...).
 *
 * Notes:
 * - Any of to/cc/bcc/reply_to can be provided as a single value or an array.
 * - For convenience, comma-separated strings are supported for `to`.
 * - If body is FormData, special keys are handled and grouped into a tidy HTML table.
 *   Special keys (excluded from the rendered body): _to, _from, _reply_to, _cc, _bcc, _subject
 *   Values for these keys may be base64 encoded; they will be decoded automatically.
 */
export interface SendOptions {
	to?: Array<Email> | Email
	/**
	 * The sender. On the Postboi provider this must be your account's sending address or an address
	 * at a domain on your account — anything else is rejected at send time with
	 * `from_not_allowed`. If the *type* rejects an address you know is valid, the generated
	 * types are stale — run `bunx postboi sync` to regenerate them.
	 */
	from?: FromAddress
	reply_to?: Array<Email> | Email
	cc?: Array<Email> | Email
	bcc?: Array<Email> | Email
	/** The subject of the email. */
	subject?: string
	/**
	 * The body of the email. If FormData — or a plain object of fields, like Express/multer's
	 * `req.body` — is provided, it will be parsed:
	 * - Special email fields are extracted (see notes above)
	 * - Remaining fields are rendered into a compact HTML table with group headers
	 *
	 * May also be a promise resolving to any of those, so a framework's `request.formData()`
	 * can be passed straight through without awaiting it yourself.
	 */
	body: BodyInput | Promise<BodyInput>
	/**
	 * Optional plain-text alternative body. When provided alongside `body`, providers
	 * that support multipart emails will send both the HTML and plain-text versions.
	 * If omitted, one is derived from the HTML (`auto_text`, on by default — construct
	 * the provider with `auto_text: false` to send HTML-only).
	 */
	text?: string
	formatter?:
		| {
				/** Optional formatter for group (fieldset) labels when rendering FormData. Set to null/false to disable. */
				fieldset?: ((label: string) => string) | null | false
				/** Optional formatter for field labels when rendering FormData. Set to null/false to disable. */
				name?: ((label: string) => string) | null | false
		  }
		/** If null/false, disables all formatting. If undefined, defaults to the built-in `title` helper. */
		| null
		| false
	/** Attachments to include. Accepts a single File or an array of File objects. */
	attachments?: File | Array<File>
	/**
	 * Idempotency key forwarded to providers that support it (the Postboi provider, Resend),
	 * so a retried request does not send a duplicate email.
	 */
	idempotency_key?: string
	/**
	 * Custom email headers, forwarded to providers that support arbitrary headers
	 * (Resend, Postmark, SendGrid, Mailgun, Brevo, SparkPost, Mandrill, Plunk, Mailtrap,
	 * Scaleway, Cloudflare). Ignored by providers without a headers slot.
	 */
	headers?: Record<string, string>
	/**
	 * An HTTPS URL recipients can use to unsubscribe. Sets the RFC 8058 one-click
	 * unsubscribe headers (`List-Unsubscribe` + `List-Unsubscribe-Post`) — required by
	 * Gmail and Yahoo for bulk senders. Your endpoint must accept the one-click `POST`.
	 * Rides the custom-headers plumbing, so it works on every headers-capable provider;
	 * explicit `headers` with the same names win.
	 */
	unsubscribe_url?: string
	/**
	 * Tags / categories for analytics and filtering, forwarded to providers that support
	 * tagging. Each provider maps them to its native concept (categories, tags, or a single
	 * category — see the README). Ignored by providers without a tagging concept.
	 */
	tags?: Array<string>
	/**
	 * Schedule the message for future delivery. Accepts a `Date`, an ISO 8601 string, or a
	 * relative {@link Duration} added to now — e.g. `{ days: 1, hours: 5 }`. Forwarded to
	 * providers with native scheduling (Resend, Brevo, SendGrid, Mailgun, the Postboi provider);
	 * ignored by providers without it, which send immediately.
	 */
	scheduled_at?: Date | string | Duration
	/**
	 * Per-send open/click tracking, forwarded to providers with per-message tracking
	 * controls (Postmark, SendGrid, Mailgun, Mandrill, SparkPost, Mailjet, Elastic Email,
	 * ZeptoMail, the Postboi provider). Only the flags you set are forwarded, so the
	 * provider's own defaults apply to the rest. Ignored by providers whose tracking is
	 * account- or domain-level (e.g. Resend).
	 */
	tracking?: Tracking
	/**
	 * Per-send spam-protection overrides (see {@link CaptchaOptions}). Only applies to
	 * FormData (or form-fields object) bodies. By default the `_honey` honeypot check is on, and
	 * Turnstile verification runs whenever `TURNSTILE_SECRET_KEY` is set.
	 */
	captcha?: CaptchaOptions
}

/**
 * The personalized-batch form of {@link SendOptions}: an array `to` plus per-recipient
 * `data`. `data` is kept off {@link SendOptions} so a plain send literal can't smuggle it
 * in — only this shape (the batch overload) accepts it.
 */
export type BatchOptions = Omit<SendOptions, "to"> & {
	to: Array<Email> | Email
	/** Per-recipient template variables, keyed by recipient address. */
	data: Record<string, RecipientVars>
}

/**
 * Constrains {@link BatchOptions.data} keys to the addresses in `to` when they are string
 * literals (so a typo'd address is a type error). Falls back to any string key when `to`
 * is a non-literal `string[]` or contains `{ address }` objects, which can't be inferred.
 */
export type BatchData<T extends ReadonlyArray<Email>> = [T[number]] extends [string]
	? string extends T[number]
		? Record<string, RecipientVars>
		: Partial<Record<T[number] & string, RecipientVars>>
	: Record<string, RecipientVars>

/**
 * One recipient of a templated batch, handed to {@link ProviderBase.build_batch_request}.
 * `message` is fully rendered (placeholders filled) for envelope-batch providers; `data`
 * and `to` are the raw inputs for providers that do the substitution server-side.
 */
export type BatchRecipient = {
	/** The recipient address (after any `before.send` redirect). */
	to: Array<Email> | Email
	/** This recipient's template variables. */
	data: RecipientVars
	/** The rendered message for this recipient — placeholders already substituted. */
	message: PreparedMessage
}

/**
 * A fully-resolved message handed to a provider's `build_request`. Defaults have been
 * applied, FormData has been rendered, and the HTML/text bodies are split out.
 */
export interface PreparedMessage {
	to: Array<Email> | Email
	from: Email
	reply_to?: Array<Email> | Email
	cc?: Array<Email> | Email
	bcc?: Array<Email> | Email
	subject: string
	html?: string
	text?: string
	attachments?: File | Array<File>
	idempotency_key?: string
	headers?: Record<string, string>
	tags?: Array<string>
	/** Normalized future delivery time; provider-format conversion happens in build_request. */
	scheduled_at?: Date
	/** Per-send tracking flags; provider-format conversion happens in build_request. */
	tracking?: Tracking
	/**
	 * Managed-captcha forwarding. Present when the body was FormData and the provider does
	 * managed verification (the Postboi provider): `token` is the widget's Turnstile token when one
	 * arrived. Providers without managed captcha never see this set.
	 */
	captcha?: { token?: string; remoteip?: string }
}

/** The normalized result of cancelling a scheduled email. */
export type CancelResponse = { id: string }

/**
 * Default field values applied to every send when the corresponding option is omitted.
 * `to`, `cc` and `bcc` accept a single value or an array, just like {@link SendOptions}.
 */
export type Defaults = {
	to?: Array<Email> | Email
	/** Default sender — see {@link SendOptions.from} for the Postboi provider rules. */
	from?: FromAddress
	cc?: Array<Email> | Email
	bcc?: Array<Email> | Email
	reply_to?: Array<Email> | Email
}

/**
 * Common options shared by all email provider constructors — the channel-agnostic
 * {@link TransportOptions} (timeout, retries, hooks) plus the email-only settings.
 */
export type CommonProviderOptions = TransportOptions<PreparedMessage> & {
	/** Default field values applied when a send omits them. */
	default?: Defaults
	/**
	 * Derive a plain-text body from the HTML body when `text` is omitted, so every email
	 * ships a multipart alternative — better spam scores and text-only clients. Defaults
	 * to true; set false to send HTML-only.
	 */
	auto_text?: boolean
	/** Spam-protection settings applied to every FormData send (see {@link CaptchaOptions}). */
	captcha?: CaptchaOptions
}

/** Options shared by providers that authenticate with a single API key/token. */
export type ApiKeyOptions = CommonProviderOptions & {
	/** The provider API key / token used to authenticate requests. */
	api_key: string
}

/**
 * The channel/message pairing hooks discriminate on. A **discriminated union** rather than
 * independent `channel` and `message` properties, so that narrowing on `ctx.channel`
 * genuinely narrows `ctx.message` — `channel === "email"` makes `message` a
 * {@link PreparedMessage}, and `message.subject` typechecks.
 */
export type HookChannelContext =
	| { channel: "email"; message: PreparedMessage }
	| { channel: "sms"; message: PreparedSms }
	| { channel: "chat"; message: PreparedChat }
	| { channel: "push"; message: PreparedPush }
	| { channel: "whatsapp"; message: PreparedWhatsapp }

/** The prepared-message union across every channel. */
export type PreparedAny = HookChannelContext["message"]

/**
 * Awaitable lifecycle hooks, run around every send on every channel. `before.send` can
 * observe, replace or cancel a message; the rest are best-effort observers (errors they
 * throw are swallowed so logging/telemetry can't break a send).
 *
 * The context is discriminated on `channel`, so **narrow on it before reading
 * channel-specific fields** — this compiles:
 *
 * ```ts
 * hooks: {
 * 	before: {
 * 		send: (ctx) => {
 * 			if (ctx.channel === "email") console.log(ctx.message.subject)
 * 			if (ctx.channel === "sms") console.log(ctx.message.to)
 * 		},
 * 	},
 * }
 * ```
 *
 * A `before.send` hook that returns a replacement must return the same channel's shape it
 * received; returning another channel's is undefined behaviour.
 */
export type Hooks = {
	before?: {
		/**
		 * Runs after normalization, before the request. Return a modified message to replace
		 * it (e.g. redirect recipients in staging), or throw to abort — throw
		 * {@link SkipSendError} for an intentional skip.
		 */
		send?: (
			ctx: { provider: string } & HookChannelContext
		) => void | PreparedAny | Promise<void | PreparedAny>
	}
	after?: {
		/** Runs after a successful send. */
		send?: (
			ctx: { provider: string; response: unknown; duration_ms: number } & HookChannelContext
		) => void | Promise<void>
	}
	on?: {
		/** Runs on any send failure — e.g. report to Sentry. */
		error?: (ctx: {
			provider: string
			channel: Channel
			/** Absent when the failure happened before the message finished preparing. */
			message?: PreparedAny
			error: PostboiError
			duration_ms: number
		}) => void | Promise<void>
		/** Runs before each retry attempt. */
		retry?: (ctx: {
			provider: string
			channel: Channel
			attempt: number
			status?: number
			reason?: unknown
			delay_ms: number
		}) => void | Promise<void>
	}
}

/**
 * Base class for all providers.
 *
 * Subclasses implement three small hooks — `build_request` (map a message to an HTTP
 * request), `parse_response` (read the success payload) and optionally `parse_error`
 * (recognise a provider error body). The base owns everything else: default/FormData
 * handling, timeouts, opt-in retries and normalized error throwing.
 */
/**
 * Explain a missing default when no config file ever loaded.
 *
 * The confusing case: `postboi.config.ts` sets `default.to`, it works locally, and every
 * send fails in production. The file is found by walking up from `process.cwd()`, but a
 * deployed serverless function doesn't contain it — nothing imports it, so file tracing
 * never includes it. The defaults are real, they just never reach the runtime, and the bare
 * "no recipient" error sends you looking in entirely the wrong place.
 */
function missing_config_hint(): string {
	if (config_loaded()) return ""
	return (
		". No postboi.config was loaded — if it sets this default, it isn't reaching the " +
		"runtime: add postboi() from postboi/vite (Vite/SvelteKit), import the config from " +
		"your server entry, or call configure() at startup."
	)
}

export abstract class EmailProvider<TResponse = unknown> extends Transport<
	TResponse,
	PreparedMessage
> {
	/** Stable provider identifier used in thrown errors. */
	protected abstract readonly provider: string

	protected readonly channel: Channel = "email"

	/**
	 * Whether a sender address must be resolvable client-side. Providers whose API can
	 * default it from the authenticated account (the Postboi provider) set this to false.
	 */
	protected readonly requires_from: boolean = true

	/**
	 * Whether the provider's API verifies Turnstile tokens itself (the Postboi provider's managed
	 * captcha). When true and no local secret is configured, FormData sends forward the
	 * token on {@link PreparedMessage.captcha} instead of verifying client-side.
	 */
	protected readonly captcha_mode: CaptchaMode = "byo"

	protected defaults: Defaults
	#auto_text: boolean
	#captcha: CaptchaOptions

	constructor(options: CommonProviderOptions = {}) {
		super(options)
		// Global config (postboi.config.ts / package.json) sit underneath per-instance
		// options, so explicit constructor arguments always win.
		const s = get_config()
		this.defaults = { ...s.default, ...options.default }
		this.#auto_text = options.auto_text ?? s.auto_text ?? true
		this.#captcha = merge_captcha(s.captcha, options.captcha)
	}

	/**
	 * Send a personalized batch: one `to` array plus per-recipient `data`. `{key}`
	 * placeholders in `subject`/`body` are filled from each recipient's variables, and the
	 * `data` keys are type-checked against `to` when they are string literals. Returns one
	 * {@link BatchResult} per recipient. Uses the provider's native batch endpoint where one
	 * exists, otherwise sends one request per recipient.
	 */
	send<const T extends ReadonlyArray<Email>>(
		options: Omit<BatchOptions, "to" | "data"> & { to: T; data: BatchData<T> }
	): Promise<Array<BatchResult<TResponse>>>
	/** Send a single email. Throws a {@link PostboiError} on any failure. */
	send(options: SendOptions): Promise<TResponse>
	/**
	 * Send many emails as individual requests with bounded concurrency (default 5).
	 * Never rejects — each message yields its own {@link BatchResult}, so one failure
	 * does not lose the rest.
	 */
	send(
		options: Array<SendOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<TResponse>>>
	async send(
		options: SendOptions | BatchOptions | Array<SendOptions>,
		batch: { concurrency?: number } = {}
	): Promise<TResponse | Array<BatchResult<TResponse>>> {
		if (Array.isArray(options)) return this.send_batch(options, batch)
		if ("data" in options && options.data && Array.isArray(options.to)) {
			return this.send_data_batch(options)
		}
		return this.with_hooks(
			() => this.prepare_send(options as SendOptions),
			(message) => this.deliver(message)
		)
	}

	/**
	 * Cancel a scheduled email using the id `send` returned. Supported by providers with a
	 * cancellation API (Resend, Brevo, the Postboi provider — and the mock, which records it);
	 * every other provider rejects with a {@link PostboiError} code `cancel_not_supported`,
	 * loudly, so a send you believe is cancelled never quietly goes out.
	 */
	cancel(_id: string): Promise<CancelResponse> {
		return Promise.reject(
			new PostboiError({
				provider: this.provider,
				message: `${this.provider} cannot cancel scheduled emails`,
				code: "cancel_not_supported",
			})
		)
	}

	/** Shared bulk-send dispatch used by the array overload of `send`. */
	protected async send_batch(
		messages: Array<SendOptions>,
		batch: { concurrency?: number } = {}
	): Promise<Array<BatchResult<TResponse>>> {
		return this.run_batch(messages, (message) => this.send(message), batch)
	}

	/**
	 * Override in providers with a native batch endpoint: map one unrendered `template` plus
	 * the per-recipient {@link BatchRecipient}s into a single HTTP request. When left
	 * undefined, {@link send_data_batch} falls back to one request per recipient.
	 */
	protected build_batch_request?(
		template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): RequestSpec | Promise<RequestSpec>

	/**
	 * Map a native batch response into one outcome per recipient (same order as `recipients`).
	 * The default applies the single-send {@link parse_response} to every recipient — correct
	 * for providers that return one aggregate id. Providers whose batch returns a per-recipient
	 * array (Resend, Postmark, Mandrill, …) override this to split it, and may return a
	 * {@link PostboiError} for any recipient the provider rejected.
	 */
	protected parse_batch_response(
		response: Response,
		data: unknown,
		recipients: Array<BatchRecipient>
	): Array<TResponse | PostboiError> {
		const single = this.parse_response(response, data)
		return recipients.map(() => single)
	}

	/**
	 * Send a personalized batch. Renders each recipient's message from the `{key}` template,
	 * runs `before.send` per recipient (so suppression/redirect still work), then dispatches:
	 * one native batch request where {@link build_batch_request} is implemented, otherwise the
	 * normal per-recipient fan-out (which carries the full hook/retry pipeline).
	 *
	 * ponytail: native batch runs `before.send` only; per-recipient `after.send`/`on.error`
	 * fire via the fan-out path. Add them to the native path if observability needs parity.
	 */
	protected async send_data_batch(options: BatchOptions): Promise<Array<BatchResult<TResponse>>> {
		const { data: data_in, ...base } = options
		const data = data_in ?? {}
		const addresses = this.parse_addresses(base.to)
		const vars_for = (a: MailAddress): RecipientVars => data[a.address] ?? {}
		const fill = (s: string | undefined, v: RecipientVars) =>
			typeof s === "string" ? this.fill_template(s, v) : s

		// One SendOptions per recipient with placeholders already filled.
		const expanded: Array<SendOptions> = addresses.map((a) => {
			const v = vars_for(a)
			return {
				...base,
				to: a.name ? { address: a.address, name: a.name } : a.address,
				subject: fill(base.subject, v),
				body: typeof base.body === "string" ? this.fill_template(base.body, v) : base.body,
				text: fill(base.text, v),
			}
		})

		// No native endpoint → existing fan-out gives full hooks/retries (and mock support).
		if (!this.build_batch_request) return this.send_batch(expanded)

		// Native batch: prepare + run before.send per recipient, then one request for survivors.
		const template = await this.prepare_send(base)
		const slots: Array<{ index: number; live?: BatchRecipient; result?: BatchResult<TResponse> }> =
			[]
		for (let index = 0; index < expanded.length; index++) {
			try {
				let message = await this.prepare_send(expanded[index])
				const replaced = await this.before_send(message)
				if (replaced) message = replaced
				slots.push({ index, live: { to: message.to, data: vars_for(addresses[index]), message } })
			} catch (error) {
				slots.push({ index, result: { ok: false, index, error: this.normalize_error(error) } })
			}
		}

		const live = slots.flatMap((s) => (s.live ? [s.live] : []))
		if (live.length > 0) {
			try {
				const spec = await this.build_batch_request(template, live)
				const response = await this.request(spec)
				const body = await this.read_json(response)
				const error = this.error_for(response, body, "batch request")
				if (error) throw error
				const parsed = this.parse_batch_response(response, body, live)
				let i = 0
				for (const slot of slots) {
					if (!slot.live) continue
					const outcome = parsed[i++]
					slot.result =
						outcome instanceof PostboiError
							? { ok: false, index: slot.index, error: outcome }
							: { ok: true, index: slot.index, response: outcome }
				}
			} catch (error) {
				const e = this.normalize_error(error)
				for (const slot of slots) {
					if (slot.live && !slot.result) slot.result = { ok: false, index: slot.index, error: e }
				}
			}
		}
		return slots.map((s) => s.result!)
	}

	/** Convert a File into a provider-agnostic attachment. */
	protected async parse_attachment(file: File): Promise<MailAttachment> {
		return {
			name: file.name,
			content: await this.file_to_base64(file),
			mime_type: file.type,
		}
	}

	/** Convert one or many Files into provider-agnostic attachments. */
	protected async parse_attachments(files: File | Array<File>): Promise<Array<MailAttachment>> {
		return Array.isArray(files)
			? await Promise.all(files.map((f) => this.parse_attachment(f)))
			: [await this.parse_attachment(files)]
	}

	/** Normalize a flexible Email value into a concrete MailAddress. */
	protected parse_email_address(email: Email): MailAddress {
		if (typeof email === "string") {
			const str = email.trim()
			// Support display-name: Name <email@domain>
			const match = str.match(/^\s*"?(.+?)"?\s*<\s*([^>]+)\s*>\s*$/)
			if (match) {
				const name = match[1].trim()
				const address = match[2].trim()
				return name ? { address, name } : { address }
			}
			return { address: str }
		}
		return { address: email.address, name: email.name }
	}

	/** Normalize a single/array/comma-separated list into an array of MailAddress. */
	protected parse_addresses(addresses: Array<Email> | Email): Array<MailAddress> {
		if (Array.isArray(addresses)) return addresses.map((a) => this.parse_email_address(a))
		if (typeof addresses === "string" && addresses.includes(","))
			return addresses
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
				.map((a) => this.parse_email_address(a))
		return [this.parse_email_address(addresses)]
	}

	/** Format a normalized address as an RFC 5322 string: `Name <address>` or `address`. */
	protected stringify_address(address: MailAddress): string {
		return address.name ? `${address.name} <${address.address}>` : address.address
	}

	/** Format a flexible Email value (single/array/comma-separated) into a comma-separated string. */
	protected stringify_addresses(addresses: Array<Email> | Email): string {
		return this.parse_addresses(addresses)
			.map((a) => this.stringify_address(a))
			.join(", ")
	}

	/** Convert a normalized address into the `{ email, name? }` shape most JSON APIs expect. */
	protected email_name(address: MailAddress): { email: string; name?: string } {
		return address.name
			? { email: address.address, name: address.name }
			: { email: address.address }
	}

	/** Map a flexible Email value into an array of `{ email, name? }` objects. */
	protected email_name_list(
		addresses: Array<Email> | Email
	): Array<{ email: string; name?: string }> {
		return this.parse_addresses(addresses).map((a) => this.email_name(a))
	}

	/** Decode a base64 string if it looks like base64, otherwise return the original. */
	protected decode_value(str: string): string {
		const base64_regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
		if (!base64_regex.test(str)) return str
		const clean = str.replace(/[\r\n]+/g, "")
		return Buffer.from(clean, "base64").toString("utf8")
	}

	/**
	 * Normalise a `body` for {@link parse_form_data}: FormData passes through, a plain object of
	 * fields (e.g. Express/multer's `req.body`) is appended key/value — array values become
	 * repeated fields — and a string body (already-rendered HTML) returns null.
	 */
	private to_form_data(body: BodyInput): FormData | null {
		if (body instanceof FormData) return body
		if (!body || typeof body !== "object") return null
		const form = new FormData()
		for (const [key, value] of Object.entries(body)) {
			if (Array.isArray(value)) for (const item of value) form.append(key, String(item))
			else form.append(key, String(value))
		}
		return form
	}

	/**
	 * Parse FormData, extracting special header fields and rendering the remaining
	 * data into a compact HTML table, grouped by the `fieldset→field` key syntax.
	 * Returns the extracted SendOptions (to/from/etc) along with any File attachments.
	 */
	protected async parse_form_data(
		form_data: FormData,
		formatter?:
			| {
					fieldset?: ((label: string) => string) | null | false
					name?: ((label: string) => string) | null | false
			  }
			| null
			| false
	): Promise<{ options: Partial<SendOptions>; attachments: Array<File> }> {
		const options: Partial<SendOptions> = {}
		const attachments: Array<File> = []
		const grouped = new Map<string, Map<string, string | Array<string>>>()

		// choose formatter behaviour
		const identity = (s: string) => s
		let format_fieldset: (s: string) => string
		let format_name: (s: string) => string
		if (formatter === null || formatter === false) {
			format_fieldset = identity
			format_name = identity
		} else {
			const fset = formatter?.fieldset
			const fname = formatter?.name
			format_fieldset = fset === undefined ? title : fset ? fset : identity
			format_name = fname === undefined ? title : fname ? fname : identity
		}

		for (const [key, value] of form_data.entries()) {
			if (value && typeof value === "object" && "name" in value && "type" in value) {
				const file = value as File
				// ignore empty file inputs (no name or zero length)
				const size = (file as unknown as { size?: number }).size ?? 0
				if (file.name && size > 0) attachments.push(file)
			} else if (typeof value === "string") {
				switch (key) {
					case "_to":
						options.to = this.decode_value(value)
						continue
					case "_subject":
						options.subject = this.decode_value(value)
						continue
					case "_from":
						// FormData carries arbitrary strings; a project-level `Register`
						// augmentation can narrow `from` below `string`, hence the cast.
						options.from = this.decode_value(value) as FromAddress
						continue
					case "_reply_to":
						options.reply_to = this.decode_value(value)
						continue
					case "_cc":
						options.cc = this.decode_value(value)
						continue
					case "_bcc":
						options.bcc = this.decode_value(value)
						continue
				}

				const [fieldset, field] = key.split("→")
				if (field) {
					if (!grouped.has(fieldset)) grouped.set(fieldset, new Map())
					const map = grouped.get(fieldset)!
					const existing = map.get(field)
					if (existing) {
						if (Array.isArray(existing)) existing.push(value)
						else map.set(field, [existing, value])
					} else {
						map.set(field, value)
					}
				} else {
					if (!grouped.has("general")) grouped.set("general", new Map())
					const map = grouped.get("general")!
					const existing = map.get(key)
					if (existing) {
						if (Array.isArray(existing)) existing.push(value)
						else map.set(key, [existing, value])
					} else {
						map.set(key, value)
					}
				}
			}
		}

		if (grouped.size > 0) {
			const rows: Array<string> = []
			for (const [fieldset, fields] of grouped) {
				if (fields.size > 0) {
					if (fieldset !== "general") {
						// Labels derive from submitted field names, so they need escaping too —
						// and formatters are documented as label→label string transforms, not
						// a way to inject markup.
						const header_label = escape_html(format_fieldset(fieldset))
						rows.push(
							`<tr><td colspan="2" style="padding: 15px 0 10px 0; font-weight: bold; font-size: 16px; border-bottom: 1px solid #ccc;">${header_label}</td></tr>`
						)
					}
					const field_rows = Array.from(fields.entries()).map(([field, value]) => {
						const label = escape_html(format_name(field))
						const display = Array.isArray(value)
							? `<ul style="margin: 0; padding-left: 20px;">${value.map((v) => `<li>${escape_lines(v)}</li>`).join("")}</ul>`
							: escape_lines(value)
						return `<tr><td style="padding: 5px 10px 5px 0; vertical-align: top;">${label}</td><td style="padding: 5px 0;">${display}</td></tr>`
					})
					rows.push(...field_rows)
					if (fieldset !== "general")
						rows.push(`<tr><td colspan="2" style="padding: 10px 0;"></td></tr>`)
				}
			}
			options.body = `<table style="border-collapse: collapse; width: auto;">${rows.join("")}</table>`
		}

		return { options, attachments }
	}

	/**
	 * Run the spam checks (honeypot + Turnstile) over a FormData body, stripping their fields
	 * from `form`. Throws {@link SpamError} on a tripped honeypot (an intentional skip) or a
	 * {@link PostboiError} with code `captcha_failed` / `captcha_misconfigured` otherwise.
	 * On a managed-captcha pass (the Postboi provider), returns the token to forward with the send.
	 */
	protected async enforce_captcha(
		form: FormData,
		overrides?: CaptchaOptions
	): Promise<{ token?: string; remoteip?: string } | undefined> {
		const captcha = merge_captcha(this.#captcha, overrides)
		const verdict = await check_captcha(form, captcha, this.captcha_mode)
		// The IP rides along so managed verification can pass it to siteverify — the send
		// leaves our server, so the API would otherwise only ever see the server's address.
		if (verdict.ok)
			return verdict.managed ? { token: verdict.token, remoteip: captcha.remoteip } : undefined
		if (verdict.code === "spam") throw new SpamError(verdict.message)
		throw new PostboiError({
			provider: this.provider,
			message: verdict.message,
			code: verdict.code,
		})
	}

	/**
	 * Apply defaults, render FormData, split out the HTML/text bodies and validate that a
	 * sender and recipient are present. Returns a {@link PreparedMessage} for `build_request`.
	 */
	protected async prepare_send(options: SendOptions): Promise<PreparedMessage> {
		// Makes Worker bindings and `.env` values readable, so a provider constructed with no
		// arguments can still find its credentials. Cached after the first send.
		await ensure_env_loaded()

		// `body` may be a promise (e.g. a framework's `request.formData()`) — resolve it first.
		const body = await options.body
		options = { ...options, body }

		// FormData — or a plain object of fields (Express/multer's `req.body`) — is parsed into
		// extracted header fields plus a rendered HTML table (honouring any formatter).
		const form = this.to_form_data(body)
		let captcha: { token?: string; remoteip?: string } | undefined
		if (form) {
			// Spam checks run first, and strip their plumbing fields so they never reach the email.
			captcha = await this.enforce_captcha(form, options.captcha)
			const { options: extracted, attachments } = await this.parse_form_data(
				form,
				options.formatter
			)
			options = { ...options, ...extracted }
			if (attachments.length > 0) options.attachments = attachments
		}

		const to = options.to ?? this.defaults.to
		const from = options.from ?? this.defaults.from

		if (!to) {
			throw new PostboiError({
				provider: this.provider,
				message: `No recipient address provided (to or default.to)${missing_config_hint()}`,
			})
		}
		if (!from && this.requires_from) {
			throw new PostboiError({
				provider: this.provider,
				message: "No sender address provided (from or default.from)",
			})
		}

		const html = typeof options.body === "string" ? options.body : undefined
		let text = options.text
		if (text === undefined && this.#auto_text && html) text = html_to_text(html)

		// RFC 8058 one-click unsubscribe rides the custom-headers plumbing; explicit headers win.
		let headers = options.headers
		if (options.unsubscribe_url) {
			headers = {
				"List-Unsubscribe": `<${options.unsubscribe_url}>`,
				"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
				...headers,
			}
		}

		let scheduled_at: Date | undefined
		if (options.scheduled_at !== undefined) {
			scheduled_at = this.resolve_scheduled_at(options.scheduled_at)
			if (Number.isNaN(scheduled_at.getTime())) {
				throw new PostboiError({
					provider: this.provider,
					message: `Invalid scheduled_at value: ${String(options.scheduled_at)}`,
				})
			}
		}

		return {
			to,
			// Undefined only reaches providers that set requires_from = false and handle it.
			from: from as Email,
			reply_to: options.reply_to ?? this.defaults.reply_to,
			cc: options.cc ?? this.defaults.cc,
			bcc: options.bcc ?? this.defaults.bcc,
			subject: options.subject || "Mail sent from website",
			html,
			text,
			attachments: options.attachments,
			idempotency_key: options.idempotency_key,
			headers,
			tags: options.tags,
			scheduled_at,
			tracking: options.tracking,
			captcha,
		}
	}
}

/**
 * The email provider base class, under its historical name.
 *
 * Kept as an alias so every existing provider — and any third-party subclass — keeps
 * working unchanged after the {@link Transport} split. New channels extend `Transport`
 * directly rather than this.
 */
export { EmailProvider as ProviderBase }
