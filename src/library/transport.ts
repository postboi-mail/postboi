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
import { PostboiError, SkipSendError, type Channel } from "./errors.js"
import { get_config, merge_hooks } from "./config.js"
import { pooled_map } from "./utils.js"

export type { Channel, ProviderError } from "./errors.js"

/** A provider-agnostic description of the HTTP request to send. */
export type RequestSpec = {
	url: string
	method?: string
	headers: Record<string, string>
	/** Omit for bodyless requests (GET/DELETE). */
	body?: BodyInit
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
	 * Number of retries on network errors and 429/5xx responses. Defaults to 0.
	 * Retries are opt-in because retrying a send that already reached the provider can
	 * deliver a duplicate message — pair this with `idempotency_key` where supported.
	 */
	retries?: number
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
	protected parse_error(
		_response: Response,
		_data: unknown
	): { message: string; code?: string | number } | undefined {
		return undefined
	}

	/** Build the request, send it, and read/validate the success payload for one message. */
	protected async deliver(message: TPrepared): Promise<TResponse> {
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
				channel: this.channel,
				status: response.status,
				message: error.message,
				code: error.code,
				raw: data,
			})
		}
		if (!response.ok) {
			return new PostboiError({
				provider: this.provider,
				channel: this.channel,
				status: response.status,
				message: `${this.provider} ${kind} failed with status ${response.status}`,
				raw: data,
			})
		}
		return undefined
	}

	/**
	 * Run the lifecycle hooks around a single send: prepare, `before.send`, deliver, then
	 * `after.send` or `on.error`. Shared by every channel and by the mock, so hooks behave
	 * identically everywhere.
	 */
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
					message,
					response,
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
		const e = this.normalize_error(error)
		// Intentional skips (before.send cancellations, spam) are not failures — no on.error.
		if (e instanceof SkipSendError) return e
		await this.observe(() =>
			this.#hooks.on?.error?.({
				provider: this.provider,
				channel: this.channel,
				message,
				error: e,
				duration_ms: this.#since(start),
			})
		)
		return e
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

	/** Normalize any thrown value into a {@link PostboiError}. */
	protected normalize_error(error: unknown): PostboiError {
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
				if (attempt < this.#retries) {
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
		if (value.years) date.setFullYear(date.getFullYear() + value.years)
		if (value.months) date.setMonth(date.getMonth() + value.months)
		if (value.weeks) date.setDate(date.getDate() + value.weeks * 7)
		if (value.days) date.setDate(date.getDate() + value.days)
		if (value.hours) date.setHours(date.getHours() + value.hours)
		if (value.minutes) date.setMinutes(date.getMinutes() + value.minutes)
		if (value.seconds) date.setSeconds(date.getSeconds() + value.seconds)
		return date
	}
}
