import type {
	PreparedMessage,
	CommonProviderOptions,
	ProviderError,
	RequestSpec,
	CancelResponse,
	BatchRecipient,
	Duration,
	Email,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"
import { read_env, env_defaults } from "./env.js"

/** Options for the Postboi provider. */
export type PostboiOptions = CommonProviderOptions & {
	/** The Postboi provider token. Defaults to the `POSTBOI_TOKEN` environment variable. */
	token?: string
	/** Override the API base URL. Defaults to `POSTBOI_API_URL` or `https://postboi.email`. */
	base_url?: string
}

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	filename: string
	type: string
}

export interface SendParams {
	/** Omitted = the API uses the account's sending address. */
	from?: EmailName
	to: Array<EmailName>
	cc?: Array<EmailName>
	bcc?: Array<EmailName>
	reply_to?: EmailName
	subject: string
	html?: string
	text?: string
	headers?: Record<string, string>
	tags?: Array<string>
	attachments?: Array<Attachment>
	scheduled_at?: string
	/** Per-send open/click tracking overrides; the account's settings apply when omitted. */
	tracking?: { opens?: boolean; clicks?: boolean }
	/** Managed-captcha Turnstile token from the form, verified server-side by the API. */
	captcha_token?: string
	/** True when the send originated from a form submission — the only sends captcha gates. */
	form?: boolean
}

type SendResponse = { id: string }

/** A message as returned by `GET /v1/messages/:id`. */
export interface MessageDetails {
	id: string
	from: string
	to: Array<string>
	subject: string
	status: string
	error?: string
	html?: string
	text?: string
	scheduled_at?: string
	opened_at?: string
	open_count: number
	created_at: string
	updated_at: string
}

/** A list as returned by `GET /v1/lists`. */
export interface ListSummary {
	id: string
	name: string
	/** Recipient count. */
	recipients: number
	created_at: string
	updated_at: string
}

/** One recipient on a list. `data` holds the `{key}` broadcast template variables. */
export interface ListRecipient {
	id: string
	email: string
	name?: string
	data?: Record<string, string>
}

/** A list with its recipients, as returned by `GET /v1/lists/:id`. */
export type ListDetails = Omit<ListSummary, "recipients"> & { recipients: Array<ListRecipient> }

/** A recipient to add to a list. `data` holds the `{key}` broadcast template variables. */
export interface NewListRecipient {
	email: string
	name?: string
	data?: Record<string, string>
}

/** One suppressed address on the account. */
export interface Suppression {
	email: string
	reason: "bounce" | "complaint" | "unsubscribe" | "manual"
	detail?: string
	created_at: string
}

/** The message broadcast to every recipient on a list. */
export interface BroadcastOptions {
	/** Omitted = the account's sending address. */
	from?: Email
	reply_to?: Email
	subject: string
	/** HTML body. `{key}` placeholders are filled from each recipient's `data` server-side. */
	body?: string
	/** Plain-text alternative, with the same `{key}` templating. */
	text?: string
	/** Deliver later — a `Date`, ISO 8601 string, or relative duration like `{ days: 1 }`. */
	scheduled_at?: Date | string | Duration
}

/** The result of a broadcast: one queued message id per recipient. */
export interface BroadcastResponse {
	ids: Array<string>
	recipients: number
	scheduled_at: string
}

/**
 * The Postboi provider — the zero-config provider, and the package's default export.
 *
 * Run `bunx postboi init` to authenticate and write `POSTBOI_TOKEN` to your environment,
 * then just construct it with no arguments:
 *
 * @example
 * ```ts
 * import Postboi from "postboi"
 *
 * const mail = new Postboi() // reads POSTBOI_TOKEN
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hi</p>" })
 * ```
 *
 * The token can still be passed explicitly (`new Postboi({ token })`), which is required
 * in runtimes that don't expose ambient env vars (e.g. Cloudflare Workers).
 */
export default class Postboi extends ProviderBase<SendResponse> {
	protected readonly provider = "postboi"
	// The API defaults `from` to the account's sending address, so none is required here.
	protected override readonly requires_from = false
	// Turnstile tokens are verified by the API against the account's managed widget —
	// FormData sends need no local secret key.
	protected override readonly managed_captcha = true
	#token: string | undefined
	#host: string

	constructor({ token, base_url, ...options }: PostboiOptions = {}) {
		// Defaults can come from the environment (POSTBOI_FROM, …); anything passed
		// explicitly via `default` wins.
		super({ ...options, default: { ...env_defaults(), ...options.default } })
		this.#token = token ?? read_env("POSTBOI_TOKEN")
		const host = base_url ?? read_env("POSTBOI_API_URL") ?? "https://postboi.email"
		this.#host = host.replace(/\/$/, "")
	}

	#require_token(): string {
		if (!this.#token) {
			throw new PostboiError({
				provider: this.provider,
				message:
					"No Postboi token found. Run `bunx postboi init`, set POSTBOI_TOKEN, or pass { token }.",
				code: "no_token",
			})
		}
		return this.#token
	}

	/** Call a `/v1` path with bearer auth, an optional JSON body, and normalized errors. */
	async #api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
		const token = this.#require_token()
		const response = await this.request({
			url: `${this.#host}/v1${path}`,
			method: init.method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		})
		const data = await this.read_json(response)
		const error = this.error_for(response, data, path)
		if (error) throw error
		return data as T
	}

	/** Cancel a scheduled message via the Postboi API. */
	async cancel(id: string): Promise<CancelResponse> {
		await this.#api(`/messages/${encodeURIComponent(id)}/cancel`, { method: "POST" })
		return { id }
	}

	/** Retrieve a message's delivery status and content. */
	message(id: string): Promise<MessageDetails> {
		return this.#api(`/messages/${encodeURIComponent(id)}`, { method: "GET" })
	}

	/** Move a scheduled message to a new time. Only works until it sends. */
	reschedule(
		id: string,
		scheduled_at: Date | string | Duration
	): Promise<{ id: string; scheduled_at: string }> {
		return this.#api(`/messages/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: { scheduled_at: this.resolve_scheduled_at(scheduled_at).toISOString() },
		})
	}

	/** All lists on the account. */
	async lists(): Promise<Array<ListSummary>> {
		const data = await this.#api<{ lists: Array<ListSummary> }>("/lists", { method: "GET" })
		return data.lists
	}

	/** Create a list. */
	create_list(name: string): Promise<{ id: string; name: string; created_at: string }> {
		return this.#api("/lists", { body: { name } })
	}

	/** One list, with its recipients. */
	list(id: string): Promise<ListDetails> {
		return this.#api(`/lists/${encodeURIComponent(id)}`, { method: "GET" })
	}

	/** Rename a list. */
	rename_list(id: string, name: string): Promise<{ id: string; name: string }> {
		return this.#api(`/lists/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } })
	}

	/** Delete a list and its recipients. */
	delete_list(id: string): Promise<{ id: string; deleted: boolean }> {
		return this.#api(`/lists/${encodeURIComponent(id)}`, { method: "DELETE" })
	}

	/** Add one recipient or an array to a list. `data` are the `{key}` broadcast variables. */
	add_recipients(
		id: string,
		recipients: NewListRecipient | Array<NewListRecipient>
	): Promise<{ added: number }> {
		return this.#api(`/lists/${encodeURIComponent(id)}/recipients`, { body: recipients })
	}

	/** Remove an address from a list. */
	remove_recipient(id: string, email: string): Promise<{ email: string; deleted: boolean }> {
		return this.#api(
			`/lists/${encodeURIComponent(id)}/recipients?email=${encodeURIComponent(email)}`,
			{ method: "DELETE" }
		)
	}

	/**
	 * Broadcast one message to every recipient on a list. `{key}` placeholders are filled
	 * from each recipient's `data`, and one-click unsubscribe headers are added for you.
	 */
	broadcast(id: string, options: BroadcastOptions): Promise<BroadcastResponse> {
		return this.#api(`/lists/${encodeURIComponent(id)}/send`, {
			body: {
				from: options.from ? this.email_name(this.parse_email_address(options.from)) : undefined,
				reply_to: options.reply_to
					? this.email_name(this.parse_email_address(options.reply_to))
					: undefined,
				subject: options.subject,
				html: options.body,
				text: options.text,
				scheduled_at: options.scheduled_at
					? this.resolve_scheduled_at(options.scheduled_at).toISOString()
					: undefined,
			},
		})
	}

	/** The account's suppression list — addresses sends are dropped for. */
	async suppressions(): Promise<Array<Suppression>> {
		const data = await this.#api<{ suppressions: Array<Suppression> }>("/suppressions", {
			method: "GET",
		})
		return data.suppressions
	}

	/** Suppress an address by hand, so future sends to it are dropped. */
	suppress(email: string): Promise<{ email: string; suppressed: boolean }> {
		return this.#api("/suppressions", { body: { email } })
	}

	/** Remove an address from the suppression list, so sending to it resumes. */
	unsuppress(email: string): Promise<{ email: string; deleted: boolean }> {
		return this.#api(`/suppressions?email=${encodeURIComponent(email)}`, { method: "DELETE" })
	}

	async #params(message: PreparedMessage): Promise<SendParams> {
		return {
			from: message.from ? this.email_name(this.parse_email_address(message.from)) : undefined,
			to: this.email_name_list(message.to),
			cc: message.cc ? this.email_name_list(message.cc) : undefined,
			bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
			reply_to: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: message.headers,
			tags: message.tags,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						filename: a.name,
						type: a.mime_type,
					}))
				: undefined,
			scheduled_at: message.scheduled_at?.toISOString(),
			tracking: message.tracking,
			captcha_token: message.captcha?.token,
			form: message.captcha ? true : undefined,
		}
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const token = this.#require_token()
		return {
			url: `${this.#host}/v1/send`,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				// A retried request with the same key returns the original message id.
				...(message.idempotency_key ? { "Idempotency-Key": message.idempotency_key } : {}),
			},
			body: JSON.stringify(await this.#params(message)),
		}
	}

	// Native batch — one POST to /v1/send/batch with a send body per recipient (max 100,
	// enforced by the API all-or-nothing).
	protected async build_batch_request(
		_template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): Promise<RequestSpec> {
		const token = this.#require_token()
		return {
			url: `${this.#host}/v1/send/batch`,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(await Promise.all(recipients.map((r) => this.#params(r.message)))),
		}
	}

	// Batch returns `{ ids }`, aligned to the request order.
	protected parse_batch_response(
		_response: Response,
		data: unknown,
		recipients: Array<BatchRecipient>
	): Array<SendResponse | PostboiError> {
		const ids = (data as { ids?: Array<string> } | null)?.ids ?? []
		return recipients.map((_, i) =>
			ids[i]
				? { id: ids[i] }
				: new PostboiError({
						provider: this.provider,
						message: "Missing batch result for recipient",
					})
		)
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.message === "string" && !("id" in e)) {
			return { message: e.message, code: typeof e.code === "string" ? e.code : undefined }
		}
		return undefined
	}
}
