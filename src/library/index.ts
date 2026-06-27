import { title, html_to_text, pooled_map } from "./utils.js"

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
	from?: Email
	reply_to?: Array<Email> | Email
	cc?: Array<Email> | Email
	bcc?: Array<Email> | Email
	/** The subject of the email. */
	subject?: string
	/**
	 * The body of the email. If FormData is provided, it will be parsed:
	 * - Special email fields are extracted (see notes above)
	 * - Remaining fields are rendered into a compact HTML table with group headers
	 */
	body: string | FormData
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
	 * Tags / categories for analytics and filtering, forwarded to providers that support
	 * tagging. Each provider maps them to its native concept (categories, tags, or a single
	 * category — see the README). Ignored by providers without a tagging concept.
	 */
	tags?: Array<string>
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
}

/** A provider-agnostic description of the HTTP request to send. */
export type RequestSpec = {
	url: string
	method?: string
	headers: Record<string, string>
	body: BodyInit
}

/** The per-message outcome of a {@link ProviderBase.send_many} bulk send. */
export type BatchResult<TResponse> =
	| { ok: true; index: number; response: TResponse }
	| { ok: false; index: number; error: PostboiError }

/** Common options shared by all provider constructors. */
export type CommonProviderOptions = {
	/** Optional default sender address used when `from` is omitted */
	default_from?: string
	/** Optional default recipient address used when `to` is omitted */
	default_to?: string
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

	protected defaults: { from?: string; to?: string }
	#timeout: number
	#retries: number
	#retry_delay: number
	#auto_text: boolean

	constructor(options: CommonProviderOptions = {}) {
		this.defaults = { from: options.default_from, to: options.default_to }
		this.#timeout = options.timeout ?? 30000
		this.#retries = options.retries ?? 0
		this.#retry_delay = options.retry_delay ?? 500
		this.#auto_text = options.auto_text ?? false
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

	/** Send an email. Throws a {@link PostboiError} on any failure. */
	async send(options: SendOptions): Promise<TResponse> {
		const message = await this.prepare_send(options)
		const spec = await this.build_request(message)
		const response = await this.request(spec)
		const data = await this.read_json(response)

		const error = this.parse_error(response, data)
		if (error) {
			throw new PostboiError({
				provider: this.provider,
				status: response.status,
				message: error.message,
				code: error.code,
				raw: data,
			})
		}
		if (!response.ok) {
			throw new PostboiError({
				provider: this.provider,
				status: response.status,
				message: `${this.provider} request failed with status ${response.status}`,
				raw: data,
			})
		}

		return this.parse_response(response, data)
	}

	/** Type guard: is this a normalized Postboi error? */
	is_error(error: unknown): error is PostboiError {
		return error instanceof PostboiError
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
					await this.#sleep(this.#backoff(attempt + 1, response))
					continue
				}
				return response
			} catch (cause) {
				if (attempt < this.#retries) {
					await this.#sleep(this.#backoff(attempt + 1))
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
						options.from = this.decode_value(value)
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
	 * Apply defaults, render FormData, split out the HTML/text bodies and validate that a
	 * sender and recipient are present. Returns a {@link PreparedMessage} for `build_request`.
	 */
	protected async prepare_send(options: SendOptions): Promise<PreparedMessage> {
		// FormData → extract headers/body/attachments (honouring any formatter)
		if (options.body instanceof FormData) {
			const { options: extracted, attachments } = await this.parse_form_data(
				options.body,
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
				message: "No recipient address provided (to or default_to)",
			})
		}
		if (!from) {
			throw new PostboiError({
				provider: this.provider,
				message: "No sender address provided (from or default_from)",
			})
		}

		const html = typeof options.body === "string" ? options.body : undefined
		let text = options.text
		if (text === undefined && this.#auto_text && html) text = html_to_text(html)

		return {
			to,
			from,
			reply_to: options.reply_to,
			cc: options.cc,
			bcc: options.bcc,
			subject: options.subject || "Mail sent from website",
			html,
			text,
			attachments: options.attachments,
			idempotency_key: options.idempotency_key,
			headers: options.headers,
			tags: options.tags,
		}
	}

	/**
	 * Send many emails as individual requests with bounded concurrency. Never rejects —
	 * each message yields its own {@link BatchResult}, so one failure does not lose the rest.
	 *
	 * @example
	 * const results = await mail.send_many([msg1, msg2], { concurrency: 10 })
	 * const failed = results.filter((r) => !r.ok)
	 */
	async send_many(
		messages: Array<SendOptions>,
		options: { concurrency?: number } = {}
	): Promise<Array<BatchResult<TResponse>>> {
		return pooled_map(messages, options.concurrency ?? 5, async (message, index) => {
			try {
				return { ok: true, index, response: await this.send(message) }
			} catch (error) {
				const normalized =
					error instanceof PostboiError
						? error
						: new PostboiError({
								provider: this.provider,
								message: error instanceof Error ? error.message : String(error),
								raw: error,
							})
				return { ok: false, index, error: normalized }
			}
		})
	}
}
