/**
 * The channel-agnostic half of a provider: HTTP with timeouts and opt-in retries,
 * lifecycle hooks, error normalization and bounded batch fan-out.
 *
 * Email, SMS and push providers all extend {@link Transport}; what differs between them is
 * how a message is *prepared*, not how it is *sent*. `EmailProvider` (exported from the
 * package root as `ProviderBase`) adds the email half — addresses, FormData rendering,
 * captcha — and the other channels add theirs.
 *
 * Internal: the package root re-exports everything here that's public.
 */
import {
	PostboiError,
	SkipSendError,
	type Channel,
	type ProviderError,
	type RejectionReason,
} from "./errors.js"
import { get_config, merge_hooks } from "./config.js"
import { pooled_map } from "./utils.js"

export type { Channel, ProviderError } from "./errors.js"

/** Methods HTTP defines as idempotent, which are safe to send again whatever came back. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"])

/**
 * Methods that change nothing, so a failure on one can't have sent anything: an unknown
 * outcome is only ever a question about a request that could have.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * The seconds a response's `Retry-After` asks for, in either of its forms (a number of
 * seconds, or an HTTP date, which opens with its day name), or undefined when it has none
 * that reads.
 */
function retry_after_seconds(response: Response): number | undefined {
	const value = response.headers?.get("retry-after")?.trim()
	if (!value) return undefined
	if (/^\d+(\.\d+)?$/.test(value)) return Number(value)
	const at = /^[a-z]/i.test(value) ? Date.parse(value) : NaN
	return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/**
 * The wait a `Retry-After` of `seconds` buys, in milliseconds and at most a minute, or
 * undefined when it asks for none.
 */
export function retry_after_ms(seconds: number | undefined): number | undefined {
	return seconds !== undefined && seconds > 0 ? Math.min(seconds, 60) * 1000 : undefined
}

/** Could a request with this method have sent or changed something? */
function changes(method: string | undefined): boolean {
	return !SAFE_METHODS.has((method ?? "POST").toUpperCase())
}

/** A provider-agnostic description of the HTTP request to send. */
export type RequestSpec = {
	url: string
	method?: string
	headers: Record<string, string>
	/** Omit for bodyless requests (GET/DELETE). */
	body?: BodyInit
	/**
	 * The request carries a key the provider documents honouring (an `Idempotency-Key`
	 * header, a `sendId`, an `Operation-Id`), so sending it twice can't send twice. Only
	 * then is a 5xx, a timeout or a network error retried: without it nothing proves the
	 * first attempt didn't land. GET, HEAD, PUT, DELETE and OPTIONS are idempotent by
	 * definition and need no flag.
	 */
	idempotent?: boolean
}

/** The per-message outcome of a bulk send. */
export type BatchResult<TResponse> =
	| { ok: true; index: number; response: TResponse }
	| { ok: false; index: number; error: PostboiError }

/** A single recipient's template variables (`{key}` → value). */
export type RecipientVars = Record<string, string>

/**
 * A relative delay for scheduled delivery, added to the send time. Every field is optional
 * and they combine — `{ days: 1, hours: 5 }` is 26 hours from now. Days/weeks/hours/… are
 * fixed spans; months and years are calendar-aware (a real "+1 month").
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
 * Awaitable lifecycle hooks, run around every send on every channel. `before.send` can
 * observe, replace or cancel a message; the rest are best-effort observers (errors they
 * throw are swallowed so logging/telemetry can't break a send).
 *
 * `TPrepared` is the channel's prepared-message shape. The package root instantiates this
 * as {@link Hooks} over the union of every channel's shape, so a hook that needs
 * channel-specific fields narrows on `ctx.channel` first.
 */
export type TransportHooks<TPrepared> = {
	before?: {
		/**
		 * Runs after normalization, before the request. Return a modified message to replace
		 * it (e.g. redirect recipients in staging), or throw to abort — throw
		 * {@link SkipSendError} for an intentional skip.
		 */
		send?: (ctx: {
			provider: string
			channel: Channel
			message: TPrepared
		}) => void | TPrepared | Promise<void | TPrepared>
	}
	after?: {
		/** Runs after a successful send. */
		send?: (ctx: {
			provider: string
			channel: Channel
			message: TPrepared
			response: unknown
			duration_ms: number
		}) => void | Promise<void>
	}
	on?: {
		/** Runs on any send failure — e.g. report to Sentry. */
		error?: (ctx: {
			provider: string
			channel: Channel
			message?: TPrepared
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

/** Constructor options every provider accepts, whatever its channel. */
export type TransportOptions<TPrepared = unknown> = {
	/** Per-request timeout in milliseconds. Defaults to 30000. */
	timeout?: number
	/**
	 * Number of retries. Defaults to 0. A 429 is always retried, since the provider refused
	 * the request. A 5xx, a timeout or a network error leaves the outcome unknown, so those
	 * are retried only when the request carries an `idempotency_key` the provider honours
	 * (or with `retry_unknown`).
	 */
	retries?: number
	/**
	 * Retry a 5xx, a timeout or a network error even without an idempotency key the
	 * provider honours. The first attempt may already have been sent, so this trades a
	 * possible duplicate for a possible drop. Defaults to false.
	 */
	retry_unknown?: boolean
	/** Base backoff delay in milliseconds between retries (doubles each attempt). Defaults to 500. */
	retry_delay?: number
	/** Lifecycle hooks run around every send. */
	hooks?: TransportHooks<TPrepared>
}

/**
 * Base class for every provider, on every channel.
 *
 * Subclasses implement `build_request` (map a prepared message to an HTTP request),
 * `parse_response` (read the success payload) and optionally `parse_error` (recognise a
 * provider error body). This class owns everything around them: timeouts, opt-in retries,
 * hook sequencing and normalized error throwing.
 */
export abstract class Transport<TResponse = unknown, TPrepared = unknown> {
	/** Stable provider identifier used in thrown errors, e.g. "resend". */
	protected abstract readonly provider: string

	/** The channel this provider delivers on. Rides along on errors and hook contexts. */
	protected abstract readonly channel: Channel

	#timeout: number
	#retries: number
	#retry_delay: number
	#retry_unknown: boolean
	#hooks: TransportHooks<TPrepared>

	constructor(options: TransportOptions<TPrepared> = {}) {
		// Global config (postboi.config.ts / package.json) sits underneath per-instance
		// options, so explicit constructor arguments always win. Hooks included: merging
		// them here — rather than leaving it to subclasses — is what guarantees a
		// third-party channel extending Transport directly still runs postboi.config
		// hooks, the invariant everything else (staging redirects, error reporting)
		// quietly depends on.
		const s = get_config()
		this.#timeout = options.timeout ?? s.timeout ?? 30000
		this.#retries = options.retries ?? s.retries ?? 0
		this.#retry_delay = options.retry_delay ?? s.retry_delay ?? 500
		this.#retry_unknown = options.retry_unknown ?? s.retry_unknown ?? false
		// Global hooks are declared over every channel's message union; this provider only
		// ever hands them its own TPrepared, so the narrowing is safe inbound. A hook that
		// *returns* another channel's shape is undefined behaviour — which is exactly what
		// ctx.channel exists to prevent.
		this.#hooks = merge_hooks(
			s.hooks as unknown as TransportHooks<TPrepared> | undefined,
			options.hooks
		)
	}

	/** Map a prepared message into the provider's HTTP request. */
	protected abstract build_request(message: TPrepared): RequestSpec | Promise<RequestSpec>

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
	 * Why a refusal happened, when the provider's own code didn't say: the HTTP status is
	 * the one thing every provider shares. A 5xx is no refusal at all, so it has no reason.
	 */
	protected reason_for(status: number): RejectionReason | undefined {
		if (status === 401 || status === 403) return "auth"
		if (status === 402) return "account"
		if (status === 429) return "rate_limited"
		if (status >= 400 && status < 500) return "request"
		return undefined
	}

	/** Build the request, send it, and read/validate the success payload for one message. */
	protected async deliver(message: TPrepared): Promise<TResponse> {
		const spec = await this.build_request(message)
		const response = await this.request(spec)
		const data = await this.read_reply(response)
		const error = this.error_for(response, data, "request")
		if (error) throw error
		try {
			return this.parse_response(response, data)
		} catch (cause) {
			// A provider that recognises a refusal in its answer throws one of ours; anything
			// else here is our reading of a 2xx failing, and the provider took the message.
			if (cause instanceof PostboiError) throw cause
			throw new PostboiError({
				provider: this.provider,
				channel: this.channel,
				status: response.status,
				message: `${this.provider} accepted the request but its answer could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
				raw: data,
				outcome_unknown: true,
			})
		}
	}

	/**
	 * Any request that isn't a send — a cancel, a login, an API call — with the same
	 * request → read → validate sequence as {@link deliver}, so the provider's `parse_error`
	 * judges every call it makes and a `kind` names the one that failed. Resolves to the
	 * parsed body; providers that don't need it ignore it.
	 */
	protected async call(spec: RequestSpec, kind: string): Promise<unknown> {
		const response = await this.request(spec)
		const data = await this.read_reply(response, spec.method)
		const error = this.error_for(response, data, kind, spec.method)
		if (error) throw error
		return data
	}

	/**
	 * Map a response into a {@link PostboiError} if the provider flags it as a failure
	 * (via `parse_error`) or the HTTP status is not ok. Returns undefined on success.
	 * `method` is the request's: a 5xx on a GET is a failed read, never an unknown send.
	 */
	protected error_for(
		response: Response,
		data: unknown,
		kind: string,
		method?: string
	): PostboiError | undefined {
		const may_have_sent = changes(method)
		const error = this.parse_error(response, data)
		if (error) {
			return new PostboiError({
				provider: this.provider,
				channel: this.channel,
				status: response.status,
				message: error.message,
				code: error.code,
				raw: data,
				outcome_unknown: may_have_sent && (response.status >= 500 || error.partial === true),
				reason:
					response.status >= 500 || error.partial
						? undefined
						: (error.reason ?? this.reason_for(response.status) ?? "request"),
				retry_after: retry_after_seconds(response),
			})
		}
		if (!response.ok) {
			return new PostboiError({
				provider: this.provider,
				channel: this.channel,
				status: response.status,
				message: `${this.provider} ${kind} failed with status ${response.status}`,
				raw: data,
				outcome_unknown: may_have_sent && response.status >= 500,
				reason: this.reason_for(response.status),
				retry_after: retry_after_seconds(response),
			})
		}
		return undefined
	}

	/**
	 * Run the lifecycle hooks around a single send: prepare, `before.send`, deliver, then
	 * `after.send` or `on.error`. Shared by every channel and by the mock, so hooks behave
	 * identically everywhere.
	 */
	/**
	 * The one-or-many dispatch every channel's `send()` delegates to: an array fans out
	 * through {@link run_batch}, a single message runs {@link with_hooks} around
	 * {@link deliver}. Living here (rather than as four hand-copies in the channel bases)
	 * is what makes "hooks and batching behave identically on every channel" a property of
	 * the base class instead of a convention.
	 */
	protected async dispatch<TOptions>(
		options: TOptions | Array<TOptions>,
		batch: { concurrency?: number },
		prepare: (options: TOptions) => Promise<TPrepared>
	): Promise<TResponse | Array<BatchResult<TResponse>>> {
		if (Array.isArray(options)) {
			return this.run_batch(
				options,
				(one) => this.dispatch(one, {}, prepare) as Promise<TResponse>,
				batch
			)
		}
		return this.with_hooks(
			() => prepare(options),
			(message) => this.deliver(message)
		)
	}

	protected async with_hooks(
		prepare: () => Promise<TPrepared>,
		core: (message: TPrepared) => Promise<TResponse>
	): Promise<TResponse> {
		const start = performance.now()

		let message: TPrepared
		try {
			message = await prepare()
		} catch (error) {
			throw await this.emit_error(error, undefined, start)
		}

		// before.send may observe, replace the message, or throw to cancel (no on.error).
		const replaced = await this.before_send(message)
		if (replaced) message = replaced

		try {
			const response = await core(message)
			await this.observe(() =>
				this.#hooks.after?.send?.({
					provider: this.provider,
					channel: this.channel,
					message: this.observable(message, message),
					response: this.observable(response, message),
					duration_ms: this.#since(start),
				})
			)
			return response
		} catch (error) {
			throw await this.emit_error(error, message, start)
		}
	}

	/** Run the `before.send` hook, returning a replacement message if it provided one. */
	protected async before_send(message: TPrepared): Promise<TPrepared | void> {
		if (this.#hooks.before?.send) {
			return this.#hooks.before.send({
				provider: this.provider,
				channel: this.channel,
				message,
			})
		}
	}

	/** Normalize a thrown value, fire the on.error hook (best-effort) and return the error. */
	protected async emit_error(
		error: unknown,
		message: TPrepared | undefined,
		start: number
	): Promise<PostboiError> {
		const e = this.normalize_error(error, message)
		// Intentional skips (before.send cancellations, spam) are not failures — no on.error.
		if (e instanceof SkipSendError) return e
		await this.observe(() =>
			this.#hooks.on?.error?.({
				provider: this.provider,
				channel: this.channel,
				message: message === undefined ? undefined : this.observable(message, message),
				error: e,
				duration_ms: this.#since(start),
			})
		)
		return e
	}

	/**
	 * What an observer (`after.send`, `on.error`) is shown of a message or a response. The
	 * value itself by default; a channel that can hide personal data in them (SMS, with
	 * `redact`) returns a scrubbed copy, told which message it belongs to so the message's
	 * own words can be found in a response that echoes them. Never applied to
	 * `before.send`, whose return value becomes the message that is sent.
	 */
	protected observable<T>(value: T, _message?: TPrepared): T {
		return value
	}

	/** Run an observability hook, swallowing any error it throws (hooks are best-effort). */
	protected async observe(run: () => unknown): Promise<void> {
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

	/**
	 * Normalize any thrown value into a {@link PostboiError}. `message` is the message being
	 * sent when there is one, for a channel that hides it in what it throws.
	 */
	protected normalize_error(error: unknown, _message?: TPrepared): PostboiError {
		return error instanceof PostboiError
			? error
			: new PostboiError({
					provider: this.provider,
					channel: this.channel,
					message: error instanceof Error ? error.message : String(error),
					raw: error,
				})
	}

	/**
	 * Send many messages as individual requests with bounded concurrency (default 5).
	 * Never rejects — each message yields its own {@link BatchResult}, so one failure does
	 * not lose the rest. `send` is the channel's single-send entry point.
	 */
	protected async run_batch<TOptions>(
		messages: Array<TOptions>,
		send: (options: TOptions) => Promise<TResponse>,
		batch: { concurrency?: number } = {}
	): Promise<Array<BatchResult<TResponse>>> {
		return pooled_map(messages, batch.concurrency ?? 5, async (message, index) => {
			try {
				return { ok: true, index, response: await send(message) }
			} catch (error) {
				return { ok: false, index, error: this.normalize_error(error) }
			}
		})
	}

	/**
	 * The single HTTP call, isolated so a provider can swap the client without
	 * re-implementing the timeout, retry and hook machinery wrapped around it.
	 *
	 * Exactly one provider needs this: APNs refuses HTTP/1.1, and Node's global `fetch`
	 * only speaks HTTP/1.1. Everything else uses the global and should keep doing so.
	 */
	protected async send_request(url: string, init: RequestInit): Promise<Response> {
		return fetch(url, init)
	}

	/**
	 * Perform the HTTP request with a timeout and opt-in retry/backoff.
	 *
	 * What may be retried is decided by what the failure proves. A 429 proves the provider
	 * refused the request. A 5xx, a timeout or a dropped connection proves nothing: the
	 * provider may have queued the message before answering badly or not at all, and a
	 * second attempt is then a second message in somebody's inbox. Those are retried only
	 * when the request is {@link RequestSpec.idempotent}, or the caller said `retry_unknown`.
	 */
	protected async request(spec: RequestSpec): Promise<Response> {
		const method = spec.method ?? "POST"
		const init: RequestInit = {
			method,
			headers: spec.headers,
			body: spec.body,
		}
		const replayable =
			this.#retry_unknown ||
			spec.idempotent === true ||
			IDEMPOTENT_METHODS.has(method.toUpperCase())

		for (let attempt = 0; ; attempt++) {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), this.#timeout)
			try {
				const response = await this.send_request(spec.url, { ...init, signal: controller.signal })
				if (this.#should_retry(response.status, replayable) && attempt < this.#retries) {
					const delay = this.#backoff(attempt + 1, response)
					await this.observe(() =>
						this.#hooks.on?.retry?.({
							provider: this.provider,
							channel: this.channel,
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
				if (replayable && attempt < this.#retries) {
					const delay = this.#backoff(attempt + 1)
					await this.observe(() =>
						this.#hooks.on?.retry?.({
							provider: this.provider,
							channel: this.channel,
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
					channel: this.channel,
					message: `${this.provider} request failed: ${reason}`,
					raw: cause,
					outcome_unknown: changes(method),
				})
			} finally {
				clearTimeout(timer)
			}
		}
	}

	#should_retry(status: number, replayable: boolean): boolean {
		return status === 429 || (replayable && status >= 500)
	}

	#backoff(attempt: number, response?: Response): number {
		// Honour a server-supplied Retry-After, but capped: send() awaits this sleep, and an
		// intermediary answering 429 with Retry-After: 86400 must not hang the caller (or a
		// serverless handler) for a day. Past the cap, the provider is telling us to come
		// back much later — that's a failed attempt, not a pause.
		return (
			retry_after_ms(response && retry_after_seconds(response)) ??
			this.#retry_delay * 2 ** (attempt - 1)
		)
	}

	#sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	/**
	 * {@link read_json} for the answer to a request that was made. The status has already
	 * arrived, so a body that drops halfway is not a refusal: after a 2xx the provider took
	 * the message, and after a 5xx nothing proves it didn't, so the error says
	 * `outcome_unknown` rather than leaving a bare stream error to read as "not sent".
	 */
	protected async read_reply(response: Response, method?: string): Promise<unknown> {
		try {
			return await this.read_json(response)
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause)
			throw new PostboiError({
				provider: this.provider,
				channel: this.channel,
				status: response.status,
				message: `${this.provider} answered ${response.status} but its body could not be read: ${reason}`,
				raw: cause,
				outcome_unknown: changes(method) && (response.ok || response.status >= 500),
				// A 4xx is still a refusal whatever its body said, so it keeps the status's reason.
				reason: response.ok ? undefined : this.reason_for(response.status),
			})
		}
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

	/** Convert a File into a base64 string. */
	protected async file_to_base64(file: File): Promise<string> {
		const array_buffer = await file.arrayBuffer()
		return Buffer.from(array_buffer).toString("base64")
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
	 * Resolve a scheduling input to a `Date`: a `Date` passes through, an ISO 8601 string is
	 * parsed, and a relative {@link Duration} is added to the current time (months/years via
	 * calendar arithmetic, the rest as fixed spans).
	 */
	protected resolve_scheduled_at(value: Date | string | Duration): Date {
		if (value instanceof Date) return value
		if (typeof value === "string") return new Date(value)
		const date = new Date()
		// Month/year arithmetic clamps to the target month's last day instead of letting
		// setMonth overflow: Jan 31 + 1 month is Feb 28/29, not Mar 3.
		if (value.years || value.months) {
			const months = (value.years ?? 0) * 12 + (value.months ?? 0)
			const day = date.getDate()
			date.setDate(1)
			date.setMonth(date.getMonth() + months)
			const last_day = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
			date.setDate(Math.min(day, last_day))
		}
		const seconds =
			((value.weeks ?? 0) * 7 + (value.days ?? 0)) * 86_400 +
			(value.hours ?? 0) * 3_600 +
			(value.minutes ?? 0) * 60 +
			(value.seconds ?? 0)
		return new Date(date.getTime() + seconds * 1_000)
	}
}
