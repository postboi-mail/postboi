import { title, html_to_text, pooled_map } from "./utils.js"
import { get_config, merge_hooks } from "./config.js"
import { check_captcha, type CaptchaOptions } from "./captcha.js"

// Global configuration (`postboi.config.ts`) is part of the public surface from the package root.
export { configure, config, type PostboiConfig } from "./config.js"
// Spam protection (honeypot + Turnstile) is part of the public surface too.
export { HONEYPOT_FIELD, TURNSTILE_FIELD, type CaptchaOptions } from "./captcha.js"
// The publishable key `bunx postboi sync` bakes in for the <Captcha /> components.
export { captcha_key } from "./register.js"

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
 * A relative delay for {@link SendOptions.scheduled_at}, added to the send time. Every field is
 * optional and they combine — `{ days: 1, hours: 5 }` is 26 hours from now. Days/weeks/hours/…
 * are fixed spans; months and years are calendar-aware (a real "+1 month").
 */
export interface Duration {
	/** Seconds from now. */
	seconds?: number
	/** Minutes from now. */
	minutes?: number
	/** Hours from now. */
	hours?: number
	/** Days from now. */
	days?: number
	/** Weeks from now. */
	weeks?: number
	/** Calendar months from now (e.g. Jan 31 + 1 month lands in Feb). */
	months?: number
	/** Calendar years from now. */
	years?: number
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
	 * If omitted and the provider is constructed with `auto_text`, one is derived from the HTML.
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
	 * Idempotency key forwarded to providers that support it (e.g. Resend), so a retried
	 * request does not send a duplicate email.
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
	 * FormData (or form-fields object) bodies. By default the `🍯` honeypot check is on, and
	 * Turnstile verification runs whenever `TURNSTILE_SECRET_KEY` is set.
	 */
	captcha?: CaptchaOptions
}

/** A single recipient's template variables (`{key}` → value). */
export type RecipientVars = Record<string, string>

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
	captcha?: { token?: string }
}

/** A provider-agnostic description of the HTTP request to send. */
export type RequestSpec = {
	url: string
	method?: string
	headers: Record<string, string>
	body: BodyInit
}

/** The per-message outcome of a bulk `send(messages)` call. */
export type BatchResult<TResponse> =
	| { ok: true; index: number; response: TResponse }
	| { ok: false; index: number; error: PostboiError }

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

/** Common options shared by all provider constructors. */
export type CommonProviderOptions = {
	/** Default field values applied when a send omits them. */
	default?: Defaults
	/** Per-request timeout in milliseconds. Defaults to 30000. */
	timeout?: number
	/**
	 * Number of retries on network errors and 429/5xx responses. Defaults to 0.
	 * Retries are opt-in because retrying a send that already reached the provider can
	 * deliver a duplicate email — pair this with `idempotency_key` where supported.
	 */
	retries?: number
	/** Base backoff delay in milliseconds between retries (doubles each attempt). Defaults to 500. */
	retry_delay?: number
	/** Derive a plain-text body from the HTML body when `text` is omitted. Defaults to false. */
	auto_text?: boolean
	/** Lifecycle hooks run around every send (see {@link Hooks}). */
	hooks?: Hooks
	/** Spam-protection settings applied to every FormData send (see {@link CaptchaOptions}). */
	captcha?: CaptchaOptions
}

/** Options shared by providers that authenticate with a single API key/token. */
export type ApiKeyOptions = CommonProviderOptions & {
	/** The provider API key / token used to authenticate requests. */
	api_key: string
}

/** Normalized error fields a provider extracts from a failed response body. */
export type ProviderError = { message: string; code?: string | number }

/**
 * A normalized error thrown by every provider, so error handling is the same no matter
 * which provider you use. The original provider payload is preserved on `raw`.
 */
export class PostboiError extends Error {
	/** The provider that produced the error, e.g. "resend". */
	readonly provider: string
	/** HTTP status code, when the failure came from a response. */
	readonly status?: number
	/** Provider-specific error code, when available. */
	readonly code?: string | number
	/** The original provider error payload (parsed body or thrown cause). */
	readonly raw: unknown

	constructor(args: {
		provider: string
		message: string
		status?: number
		code?: string | number
		raw?: unknown
	}) {
		super(args.message)
		this.name = "PostboiError"
		this.provider = args.provider
		this.status = args.status
		this.code = args.code
		this.raw = args.raw
	}
}

/**
 * Thrown from a `before.send` hook to cancel a send (e.g. a suppressed/unsubscribed
 * recipient). It is a {@link PostboiError} with `code: "skipped"`, so it flows through
 * `is_error` and bulk `BatchResult`s; catch it with `instanceof SkipSendError`. Skips do
 * **not** trigger the `on.error` hook.
 */
export class SkipSendError extends PostboiError {
	constructor(message = "Email send was skipped by a before.send hook", code: string = "skipped") {
		super({ provider: "skip", message, code })
		this.name = "SkipSendError"
	}
}

/**
 * Thrown when a FormData body trips the spam checks — the honeypot field (`🍯` by default)
 * was filled. A {@link SkipSendError} with `code: "spam"`, so like any intentional skip it
 * never reaches the `on.error` hook. `postboi/kit` turns it into a silent
 * `{ success: true }` so bots can't tell they were caught.
 */
export class SpamError extends SkipSendError {
	constructor(message = "Submission flagged as spam") {
		super(message, "spam")
		this.name = "SpamError"
	}
}

/** Type guard: is a caught value a normalized {@link PostboiError}? */
export function is_error(error: unknown): error is PostboiError {
	return error instanceof PostboiError
}

/** Type guard: is a caught value the spam-check {@link SpamError}? */
export function is_spam(error: unknown): error is SpamError {
	return error instanceof SpamError
}

/**
 * Awaitable lifecycle hooks, run around every send. `before.send` can observe, replace
 * or cancel a message; the rest are best-effort observers (errors they throw are
 * swallowed so logging/telemetry can't break a send).
 */
export type Hooks = {
	before?: {
		/**
		 * Runs after normalization, before the request. Return a modified {@link PreparedMessage}
		 * to replace it (e.g. redirect recipients in staging), or throw to abort — throw
		 * {@link SkipSendError} for an intentional skip.
		 */
		send?: (ctx: {
			provider: string
			message: PreparedMessage
		}) => void | PreparedMessage | Promise<void | PreparedMessage>
	}
	after?: {
		/** Runs after a successful send. */
		send?: (ctx: {
			provider: string
			message: PreparedMessage
			response: unknown
			duration_ms: number
		}) => void | Promise<void>
	}
	on?: {
		/** Runs on any send failure — e.g. report to Sentry. */
		error?: (ctx: {
			provider: string
			message?: PreparedMessage
			error: PostboiError
			duration_ms: number
		}) => void | Promise<void>
		/** Runs before each retry attempt. */
		retry?: (ctx: {
			provider: string
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
export abstract class ProviderBase<TResponse = unknown> {
	/** Stable provider identifier used in thrown errors. */
	protected abstract readonly provider: string

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
	protected readonly managed_captcha: boolean = false

	protected defaults: Defaults
	#timeout: number
	#retries: number
	#retry_delay: number
	#auto_text: boolean
	#hooks: Hooks
	#captcha: CaptchaOptions

	constructor(options: CommonProviderOptions = {}) {
		// Global config (postboi.config.ts / package.json) sit underneath per-instance
		// options, so explicit constructor arguments always win.
		const s = get_config()
		this.defaults = { ...s.default, ...options.default }
		this.#timeout = options.timeout ?? s.timeout ?? 30000
		this.#retries = options.retries ?? s.retries ?? 0
		this.#retry_delay = options.retry_delay ?? s.retry_delay ?? 500
		this.#auto_text = options.auto_text ?? s.auto_text ?? false
		this.#hooks = merge_hooks(s.hooks, options.hooks)
		this.#captcha = { ...s.captcha, ...options.captcha }
	}

	/** Map a prepared message into the provider's HTTP request. */
	protected abstract build_request(message: PreparedMessage): RequestSpec | Promise<RequestSpec>

	/** Read the provider's success payload from the response. */
	protected abstract parse_response(response: Response, data: unknown): TResponse

	/**
	 * Recognise a provider error in the response body and return normalized fields.
	 * Return undefined to fall back to HTTP status handling. Override per provider.
	 */
	protected parse_error(_response: Response, _data: unknown): ProviderError | undefined {
		return undefined
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
		return this.with_hooks(options, (message) => this.deliver(message))
	}

	/** Build the request, send it, and read/validate the success payload for one message. */
	protected async deliver(message: PreparedMessage): Promise<TResponse> {
		const spec = await this.build_request(message)
		const response = await this.request(spec)
		const data = await this.read_json(response)
		const error = this.error_for(response, data, "request")
		if (error) throw error
		return this.parse_response(response, data)
	}

	/**
	 * Map a response into a {@link PostboiError} if the provider flags it as a failure
	 * (via `parse_error`) or the HTTP status is not ok. Returns undefined on success.
	 */
	protected error_for(response: Response, data: unknown, kind: string): PostboiError | undefined {
		const error = this.parse_error(response, data)
		if (error) {
			return new PostboiError({
				provider: this.provider,
				status: response.status,
				message: error.message,
				code: error.code,
				raw: data,
			})
		}
		if (!response.ok) {
			return new PostboiError({
				provider: this.provider,
				status: response.status,
				message: `${this.provider} ${kind} failed with status ${response.status}`,
				raw: data,
			})
		}
		return undefined
	}

	/**
	 * Run the lifecycle hooks around a single send, delegating the actual delivery to `core`.
	 * Shared by the real providers and the mock so hooks behave identically everywhere.
	 */
	protected async with_hooks(
		options: SendOptions,
		core: (message: PreparedMessage) => Promise<TResponse>
	): Promise<TResponse> {
		const start = performance.now()

		let message: PreparedMessage
		try {
			message = await this.prepare_send(options)
		} catch (error) {
			throw await this.#emit_error(error, undefined, start)
		}

		// before.send may observe, replace the message, or throw to cancel (no on.error).
		const replaced = await this.before_send(message)
		if (replaced) message = replaced

		try {
			const response = await core(message)
			await this.#observe(() =>
				this.#hooks.after?.send?.({
					provider: this.provider,
					message,
					response,
					duration_ms: this.#since(start),
				})
			)
			return response
		} catch (error) {
			throw await this.#emit_error(error, message, start)
		}
	}

	/** Run the `before.send` hook, returning a replacement message if it provided one. */
	protected async before_send(message: PreparedMessage): Promise<PreparedMessage | void> {
		if (this.#hooks.before?.send) {
			return this.#hooks.before.send({ provider: this.provider, message })
		}
	}

	/** Normalize a thrown value, fire the on.error hook (best-effort) and return the error. */
	async #emit_error(
		error: unknown,
		message: PreparedMessage | undefined,
		start: number
	): Promise<PostboiError> {
		const e =
			error instanceof PostboiError
				? error
				: new PostboiError({
						provider: this.provider,
						message: error instanceof Error ? error.message : String(error),
						raw: error,
					})
		// Intentional skips (before.send cancellations, spam) are not failures — no on.error.
		if (e instanceof SkipSendError) return e
		await this.#observe(() =>
			this.#hooks.on?.error?.({
				provider: this.provider,
				message,
				error: e,
				duration_ms: this.#since(start),
			})
		)
		return e
	}

	/** Run an observability hook, swallowing any error it throws (hooks are best-effort). */
	async #observe(run: () => unknown): Promise<void> {
		try {
			await run()
		} catch {
			// observability hooks must never break a send
		}
	}

	#since(start: number): number {
		return Math.round(performance.now() - start)
	}

	/** Type guard: is this a normalized Postboi error? */
	is_error(error: unknown): error is PostboiError {
		return error instanceof PostboiError
	}

	/** Normalize any thrown value into a {@link PostboiError}. */
	protected normalize_error(error: unknown): PostboiError {
		return error instanceof PostboiError
			? error
			: new PostboiError({
					provider: this.provider,
					message: error instanceof Error ? error.message : String(error),
					raw: error,
				})
	}

	/** Shared bulk-send dispatch used by the array overload of `send`. */
	protected async send_batch(
		messages: Array<SendOptions>,
		batch: { concurrency?: number } = {}
	): Promise<Array<BatchResult<TResponse>>> {
		return pooled_map(messages, batch.concurrency ?? 5, async (message, index) => {
			try {
				return { ok: true, index, response: await this.send(message) }
			} catch (error) {
				return { ok: false, index, error: this.normalize_error(error) }
			}
		})
	}

	/**
	 * Replace `{key}` placeholders in `text` with the matching variable. Unknown keys
	 * become empty strings. Only bare `{identifier}` tokens are touched — `{` followed by a
	 * space (e.g. CSS `{ color: red }`) is left alone.
	 */
	protected fill_template(text: string, vars: RecipientVars): string {
		return text.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "")
	}

	/**
	 * Rewrite every `{key}` placeholder into a provider's native merge syntax (e.g. Mailgun's
	 * `%recipient.key%`). Used by providers whose batch endpoint does the substitution itself.
	 */
	protected translate_placeholders(text: string, to: (key: string) => string): string {
		return text.replace(/\{(\w+)\}/g, (_, key) => to(key))
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

	/** Perform the HTTP request with a timeout and opt-in retry/backoff. */
	protected async request(spec: RequestSpec): Promise<Response> {
		const init: RequestInit = {
			method: spec.method ?? "POST",
			headers: spec.headers,
			body: spec.body,
		}

		for (let attempt = 0; ; attempt++) {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), this.#timeout)
			try {
				const response = await fetch(spec.url, { ...init, signal: controller.signal })
				if (this.#should_retry(response.status) && attempt < this.#retries) {
					const delay = this.#backoff(attempt + 1, response)
					await this.#observe(() =>
						this.#hooks.on?.retry?.({
							provider: this.provider,
							attempt: attempt + 1,
							status: response.status,
							delay_ms: delay,
						})
					)
					await this.#sleep(delay)
					continue
				}
				return response
			} catch (cause) {
				if (attempt < this.#retries) {
					const delay = this.#backoff(attempt + 1)
					await this.#observe(() =>
						this.#hooks.on?.retry?.({
							provider: this.provider,
							attempt: attempt + 1,
							reason: cause,
							delay_ms: delay,
						})
					)
					await this.#sleep(delay)
					continue
				}
				const reason = cause instanceof Error ? cause.message : String(cause)
				throw new PostboiError({
					provider: this.provider,
					message: `${this.provider} request failed: ${reason}`,
					raw: cause,
				})
			} finally {
				clearTimeout(timer)
			}
		}
	}

	#should_retry(status: number): boolean {
		return status === 429 || status >= 500
	}

	#backoff(attempt: number, response?: Response): number {
		const retry_after = response ? Number(response.headers.get("retry-after")) : NaN
		if (!Number.isNaN(retry_after) && retry_after > 0) return retry_after * 1000
		return this.#retry_delay * 2 ** (attempt - 1)
	}

	#sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	/** Convert a File into a base64 string. */
	protected async file_to_base64(file: File): Promise<string> {
		const array_buffer = await file.arrayBuffer()
		return Buffer.from(array_buffer).toString("base64")
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

	/** Read a Response body as JSON, tolerating empty bodies (e.g. 202 responses). */
	protected async read_json(response: Response): Promise<unknown> {
		const text = await response.text()
		if (!text) return undefined
		try {
			return JSON.parse(text)
		} catch {
			return text
		}
	}

	/** Decode a base64 string if it looks like base64, otherwise return the original. */
	protected decode_value(str: string): string {
		const base64_regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
		if (!base64_regex.test(str)) return str
		const clean = str.replace(/[\r\n]+/g, "")
		return Buffer.from(clean, "base64").toString("utf8")
	}

	/**
	 * Resolve a {@link SendOptions.scheduled_at} input to a `Date`: a `Date` passes through, an
	 * ISO 8601 string is parsed, and a relative {@link Duration} is added to the current time
	 * (months/years via calendar arithmetic, the rest as fixed spans).
	 */
	private resolve_scheduled_at(value: Date | string | Duration): Date {
		if (value instanceof Date) return value
		if (typeof value === "string") return new Date(value)
		const date = new Date()
		if (value.years) date.setFullYear(date.getFullYear() + value.years)
		if (value.months) date.setMonth(date.getMonth() + value.months)
		if (value.weeks) date.setDate(date.getDate() + value.weeks * 7)
		if (value.days) date.setDate(date.getDate() + value.days)
		if (value.hours) date.setHours(date.getHours() + value.hours)
		if (value.minutes) date.setMinutes(date.getMinutes() + value.minutes)
		if (value.seconds) date.setSeconds(date.getSeconds() + value.seconds)
		return date
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
						const header_label = format_fieldset(fieldset)
						rows.push(
							`<tr><td colspan="2" style="padding: 15px 0 10px 0; font-weight: bold; font-size: 16px; border-bottom: 1px solid #ccc;">${header_label}</td></tr>`
						)
					}
					const field_rows = Array.from(fields.entries()).map(([field, value]) => {
						const label = format_name(field)
						const display = Array.isArray(value)
							? `<ul style="margin: 0; padding-left: 20px;">${value.map((v) => `<li>${v}</li>`).join("")}</ul>`
							: value
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
	): Promise<{ token?: string } | undefined> {
		const verdict = await check_captcha(
			form,
			{ ...this.#captcha, ...overrides },
			this.managed_captcha
		)
		if (verdict.ok) return verdict.managed ? { token: verdict.token } : undefined
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
		// `body` may be a promise (e.g. a framework's `request.formData()`) — resolve it first.
		const body = await options.body
		options = { ...options, body }

		// FormData — or a plain object of fields (Express/multer's `req.body`) — is parsed into
		// extracted header fields plus a rendered HTML table (honouring any formatter).
		const form = this.to_form_data(body)
		let captcha: { token?: string } | undefined
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
				message: "No recipient address provided (to or default.to)",
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
