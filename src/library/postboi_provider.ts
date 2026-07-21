import type {
	PreparedMessage,
	CommonProviderOptions,
	ProviderError,
	RequestSpec,
	CancelResponse,
	BatchRecipient,
	Duration,
	Email,
	FromAddress,
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
	/** Whether double opt-in confirmation is on. */
	confirmation: boolean
	created_at: string
	updated_at: string
}

/** A recipient's lifecycle state. Only subscribed recipients receive broadcasts and
 * digests; unsubscribes and bounces flip the status instead of removing the row. */
export type RecipientStatus = "subscribed" | "pending" | "unsubscribed" | "bounced" | "complained"

/** One recipient on a list. `data` holds the `{key}` broadcast template variables. */
export interface ListRecipient {
	id: string
	email: string
	name?: string
	data?: Record<string, string>
	status?: RecipientStatus
}

/** A list with its recipients, as returned by `GET /v1/lists/:id`. */
export type ListDetails = Omit<ListSummary, "recipients" | "confirmation"> & {
	recipients: Array<ListRecipient>
	confirmation: ConfirmationSettings
}

/** A recipient to add to a list. `data` holds the `{key}` broadcast template variables. */
export interface NewListRecipient {
	email: string
	name?: string
	data?: Record<string, string>
}

/**
 * Anything `add_recipients` accepts as one recipient — the same shapes as `to`:
 * `"a@b.c"`, `"Name <a@b.c>"`, `{ address, name }`, or a {@link NewListRecipient}
 * when the recipient carries broadcast template `data`.
 */
export type ListRecipientInput = Email | NewListRecipient

/** One suppressed address on the account. */
export interface Suppression {
	email: string
	reason: "bounce" | "complaint" | "unsubscribe" | "manual"
	detail?: string
	created_at: string
}

/** The message broadcast to every recipient on a list. */
export interface BroadcastOptions {
	/** Omitted = the account's sending address. Narrowed by `bunx postboi sync`. */
	from?: FromAddress
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
 * When a notification sends. A bare frequency string is shorthand — `"weekly"`
 * defaults to Mondays, `"subscribe"` fires whenever someone new joins the list.
 * Times default to 09:00 UTC; pass `send_time`/`timezone` to pin them.
 */
export type NotificationScheduleInput =
	| "daily"
	| "weekly"
	| "monthly"
	| "subscribe"
	| {
			frequency: "daily" | "weekly" | "monthly" | "subscribe"
			/** Weekly: JS weekday numbers (0 = Sunday). */
			days?: Array<number>
			/** Monthly: 1-31, clamped to shorter months. */
			month_day?: number
			/** "HH:MM", 24h. */
			send_time?: string
			/** IANA zone name, e.g. "Europe/London". */
			timezone?: string
	  }

/** A notification's stored schedule, fully resolved. */
export interface NotificationSchedule {
	frequency: "daily" | "weekly" | "monthly" | "subscribe"
	days: Array<number>
	month_day: number
	send_time: string
	timezone: string
}

/** What `create_notification` accepts; subject/body default to the starter template. */
export interface NotificationOptions {
	/** Who receives the digest — the same shapes as `to`. */
	recipients: Email | Array<Email>
	/** Sender — your send address or a verified domain. Omit for the account default;
	 * narrowed to your permitted addresses by `bunx postboi sync`. */
	from?: FromAddress
	subject?: string
	/** HTML template body — `{key}` variables plus `{#if}`/`{#each}` blocks. */
	body?: string
	schedule: NotificationScheduleInput
}

/** A list's confirmation configuration. `enabled` = send confirmation emails;
 * `default_status` = what new recipients start as ("pending" means they must
 * confirm before receiving anything). `from` null = the account's send address. */
export interface ConfirmationSettings {
	enabled: boolean
	default_status: "pending" | "subscribed"
	subject: string
	body: string
	from: string | null
}

/**
 * The `confirmation` option on create_list/update_list. The boolean shorthand:
 * `true` = classic double opt-in (email + pending), `false` = plain instant
 * subscribe. The object patches the knobs separately — e.g. a courtesy email
 * without gating is `{ enabled: true, default_status: "subscribed" }`. `from` is
 * narrowed by `bunx postboi sync`; null reverts it to the account's send address.
 */
export type ListConfirmationInput =
	| boolean
	| {
			enabled?: boolean
			default_status?: "pending" | "subscribed"
			subject?: string
			body?: string
			from?: FromAddress | null
	  }

/** What update_list accepts — rename and/or confirmation, both optional. */
export interface ListChanges {
	name?: string
	confirmation?: ListConfirmationInput
}

/** A notification as returned by the API. `next_run_at` is null while a
 * subscribe-triggered notification waits for its next signup. */
export interface NotificationDetails {
	id: string
	recipients: Array<{ email: string; name?: string }>
	subject: string
	body: string
	/** Display-form sender, or null for the account's send address. */
	from: string | null
	schedule: NotificationSchedule
	last_run_at: string | null
	next_run_at: string | null
	created_at: string
	updated_at: string
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
 * That holds on Cloudflare Workers too — the token is read from the `POSTBOI_TOKEN`
 * binding. Pass it explicitly (`new Postboi({ token })`) only to override.
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
		// Re-read late as well as at construction: on Workers the bindings only reach the env
		// cache once `ensure_env_loaded()` has run, which the send path awaits.
		this.#token ??= read_env("POSTBOI_TOKEN")
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

	/** Create a list. Names are unique per account — a taken name rejects with `name_taken`.
	 * Pass `confirmation` to enable double opt-in from the start. */
	create_list(
		name: string,
		options: { confirmation?: ListConfirmationInput } = {}
	): Promise<{ id: string; name: string; confirmation: ConfirmationSettings; created_at: string }> {
		return this.#api("/lists", {
			body: { name, confirmation: this.#confirmation_body(options.confirmation) },
		})
	}

	/** Normalize a confirmation input's `from` (an Email shape) for the wire. */
	#confirmation_body(input: ListConfirmationInput | undefined): unknown {
		if (input === undefined || typeof input === "boolean") return input
		return {
			...input,
			from:
				input.from !== undefined && input.from !== null
					? this.email_name(this.parse_email_address(input.from))
					: input.from,
		}
	}

	/**
	 * Update a list — rename it and/or change its confirmation (double opt-in)
	 * settings. `list` is a name or id.
	 *
	 * @example
	 * ```ts
	 * await mail.update_list("Newsletter", { confirmation: true })
	 * await mail.update_list("Newsletter", { confirmation: { from: "Bot <hi@acme.example>" } })
	 * ```
	 */
	update_list(
		list: string,
		changes: ListChanges
	): Promise<{ id: string; name: string; confirmation: ConfirmationSettings }> {
		return this.#api(`/lists/${encodeURIComponent(list)}`, {
			method: "PATCH",
			body: { ...changes, confirmation: this.#confirmation_body(changes.confirmation) },
		})
	}

	/** One list, with its recipients. `list` is a name or id. */
	list(list: string): Promise<ListDetails> {
		return this.#api(`/lists/${encodeURIComponent(list)}`, { method: "GET" })
	}

	/** Rename a list — shorthand for `update_list(list, { name })`. */
	rename_list(list: string, name: string): Promise<{ id: string; name: string }> {
		return this.update_list(list, { name })
	}

	/** Delete a list and its recipients. `list` is a name or id. */
	delete_list(list: string): Promise<{ id: string; deleted: boolean }> {
		return this.#api(`/lists/${encodeURIComponent(list)}`, { method: "DELETE" })
	}

	/**
	 * Add one recipient or an array to a list — upserting both sides: `list` is a name
	 * or id (an unknown name creates the list), and re-adding an address updates its
	 * name/`data` instead of duplicating it — `added` counts genuinely new addresses,
	 * `updated` the refreshed existing ones. Recipients take the same shapes as `to`:
	 * `"a@b.c"`, `"Name <a@b.c>"`, or `{ email, name, data }` where `data` holds the
	 * `{key}` broadcast variables.
	 *
	 * @example
	 * ```ts
	 * await mail.add_recipients("my list", "Acme Inc <hello@acme.example>")
	 * ```
	 */
	add_recipients(
		list: string,
		recipients: ListRecipientInput | Array<ListRecipientInput>,
		options: {
			/** Starting status for these recipients — overrides the list's default. */
			status?: "subscribed" | "pending"
		} = {}
	): Promise<{
		added: number
		updated: number
		/** How many of `added` started pending. */
		pending: number
		list: { id: string; name: string }
	}> {
		const rows = (Array.isArray(recipients) ? recipients : [recipients]).flatMap((entry) =>
			typeof entry === "string" || !("email" in entry) ? this.email_name_list(entry) : [entry]
		)
		const query = options.status ? `?status=${options.status}` : ""
		return this.#api(`/lists/${encodeURIComponent(list)}/recipients${query}`, { body: rows })
	}

	/**
	 * Set a recipient's status by hand — e.g. `"unsubscribed"` keeps them on the
	 * list (with history) but out of every future broadcast and digest, and
	 * `"subscribed"` brings them back. `list` is a name or id.
	 */
	set_recipient_status(
		list: string,
		email: string,
		status: RecipientStatus
	): Promise<{ email: string; status: RecipientStatus }> {
		return this.#api(`/lists/${encodeURIComponent(list)}/recipients`, {
			method: "PATCH",
			body: { email, status },
		})
	}

	/** Remove an address from a list. `list` is a name or id. */
	remove_recipient(list: string, email: string): Promise<{ email: string; deleted: boolean }> {
		return this.#api(
			`/lists/${encodeURIComponent(list)}/recipients?email=${encodeURIComponent(email)}`,
			{ method: "DELETE" }
		)
	}

	/**
	 * Broadcast one message to every recipient on a list — `list` is a name or id.
	 * `{key}` placeholders are filled from each recipient's `data`, and one-click
	 * unsubscribe headers are added for you.
	 */
	broadcast(list: string, options: BroadcastOptions): Promise<BroadcastResponse> {
		return this.#api(`/lists/${encodeURIComponent(list)}/send`, {
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

	/** A list's notifications — its recurring digests. `list` is a name or id. */
	async notifications(list: string): Promise<Array<NotificationDetails>> {
		const data = await this.#api<{ notifications: Array<NotificationDetails> }>(
			`/lists/${encodeURIComponent(list)}/notifications`,
			{ method: "GET" }
		)
		return data.notifications
	}

	/**
	 * Create a notification on a list — a digest of new subscribers emailed on a
	 * schedule, or immediately when someone new joins (`schedule: "subscribe"`).
	 * Subject and body default to the starter template.
	 *
	 * @example
	 * ```ts
	 * await mail.create_notification("Newsletter", {
	 * 	recipients: "Darby <darby@uilo.co>",
	 * 	schedule: { frequency: "weekly", days: [1], send_time: "09:00", timezone: "Europe/London" },
	 * })
	 * ```
	 */
	create_notification(list: string, options: NotificationOptions): Promise<NotificationDetails> {
		return this.#api(`/lists/${encodeURIComponent(list)}/notifications`, {
			body: {
				...options,
				recipients: this.email_name_list(options.recipients),
				from:
					options.from !== undefined
						? this.email_name(this.parse_email_address(options.from))
						: undefined,
			},
		})
	}

	/** Update a notification — absent fields keep their stored values. */
	update_notification(
		list: string,
		id: string,
		options: Partial<NotificationOptions> & { from?: FromAddress | null }
	): Promise<NotificationDetails> {
		return this.#api(`/lists/${encodeURIComponent(list)}/notifications/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: {
				...options,
				recipients:
					options.recipients !== undefined ? this.email_name_list(options.recipients) : undefined,
				from:
					options.from !== undefined && options.from !== null
						? this.email_name(this.parse_email_address(options.from))
						: options.from,
			},
		})
	}

	/** Delete a notification. */
	delete_notification(list: string, id: string): Promise<{ id: string; deleted: boolean }> {
		return this.#api(`/lists/${encodeURIComponent(list)}/notifications/${encodeURIComponent(id)}`, {
			method: "DELETE",
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
