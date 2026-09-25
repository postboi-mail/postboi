import type {
	PreparedMessage,
	CommonProviderOptions,
	Defaults,
	SendOptions,
	ProviderError,
	RequestSpec,
	CancelResponse,
	BatchRecipient,
	Duration,
	Email,
	FromAddress,
	FormName,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"
import { read_env, env_defaults, ensure_env_loaded } from "./env.js"

/** Options for the Postboi provider. */
export type PostboiOptions = CommonProviderOptions & {
	/** The Postboi provider token. Defaults to the `POSTBOI_TOKEN` environment variable. */
	token?: string
	/** Override the API base URL. Defaults to `POSTBOI_API_URL` or `https://postboi.app`. */
	base_url?: string
	/**
	 * Postboi Cloud relay: ask the API to send through the named provider using the
	 * credentials synced to the account (e.g. `"resend"`), instead of Postboi's own
	 * sending infrastructure. Requires the account to hold that provider's credentials.
	 */
	send_via?: string
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
	/**
	 * The submitting visitor's IP, passed to siteverify as `remoteip`. The send comes from the
	 * caller's server, so without this the API only ever sees that server's address.
	 */
	captcha_ip?: string
	/**
	 * Marks a form submission — the only sends captcha gates. A string names the Postboi
	 * form the submission is filed under (by name or `form_…` id); `true` just flags it.
	 */
	form?: boolean | string
	/** The submission's `[name, value]` entries, the data the table in `html` was drawn from. */
	fields?: Array<[string, string]>
	/**
	 * Put the account's letterhead — the header and footer written in the dashboard —
	 * around `html`. The API leaves the document itself alone; a footer's
	 * `{unsubscribe_url}` is filled from the `List-Unsubscribe` header.
	 */
	letterhead?: boolean
	/**
	 * Set `html` in the 600px column the dashboard composer sends in. Styles the html
	 * already carries survive it and win; html that is already a whole page is refused,
	 * because the shell is the page.
	 */
	shell?: boolean
	/** The cut the letterhead and the shell are set in; `styled` when omitted. */
	style?: "styled" | "plain"
	/** The line an inbox shows after the subject, written into `html` as a hidden div. */
	preheader?: string
	/** Small print under the frame (or at the end of `html` without the shell), escaped. */
	footnote?: string
	/** Relay this send through the named provider using the account's synced credentials. */
	send_via?: string
	/**
	 * Replay guard, unique per account. The single-send path sends this as the
	 * `Idempotency-Key` header instead; in a batch there is no header that could mean
	 * anything, because one key names one message — so it rides the body, per item.
	 */
	idempotency_key?: string
}

/** The API's ceiling on an idempotency key, header or body. */
const MAX_IDEMPOTENCY_KEY = 256

type SendResponse = { id: string; sandbox?: boolean; claim_url?: string }

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
	/** The form this submission was filed under, when it was one. */
	form?: { id: string; name: string }
	/** A submission's fields as `[name, value]` pairs, in submission order. */
	fields?: Array<[string, string]>
	created_at: string
	updated_at: string
}

/** A form on the account, as `forms.all()` lists them — what `form:` is typed to. */
export interface FormSummary {
	id: string
	name: string
	/** Named from your code, or a hosted endpoint any page can post to. */
	kind: "library" | "hosted"
	paused: boolean
	created_at: string
}

/** Which sends a scheduled export covers — the Sent log's own filters. Days are UTC days. */
export interface ExportFilter {
	/** One form's submissions, by name or id — typed the way `form:` is. */
	form?: FormName
	subject?: string
	/** Match the whole subject rather than a fragment. */
	subject_exact?: boolean
	from?: string
	to?: string
	status?: string | Array<string>
	opens?: "opened" | "unopened" | "untracked"
	since?: string
	until?: string
}

/** What `exports.download` takes: a filter and the file's shape, no schedule. */
export interface ExportDownloadOptions {
	filter?: ExportFilter
	/** `"csv"` by default. */
	format?: "csv" | "xlsx"
	/** Export column keys; the usual set when omitted. */
	columns?: Array<string>
	/** One column per form field after the chosen columns. On by default. */
	fields?: boolean
}

/** A downloaded export: the bytes, the name the server gave the file, and its media type. */
export interface ExportFile {
	filename: string
	type: string
	bytes: Uint8Array
	/**
	 * The file as UTF-8 text, without the byte-order mark a CSV opens with — for a
	 * spreadsheet, which is a ZIP, read `bytes` instead.
	 */
	text(): string
}

/**
 * `exports.download`'s options as the query string `GET /v1/exports/download` reads —
 * the same words a scheduled export's filter uses, flattened: `status` and `columns`
 * become comma lists, `fields` is `1` or `0`.
 */
export function export_download_params(options: ExportDownloadOptions = {}): URLSearchParams {
	const params = new URLSearchParams()
	const filter = options.filter ?? {}
	for (const key of ["form", "subject", "from", "to", "opens", "since", "until"] as const) {
		const value = filter[key]
		if (value !== undefined && value !== null && value !== "") params.set(key, String(value))
	}
	if (filter.subject_exact) params.set("subject_exact", "1")
	if (filter.status !== undefined) {
		const list = Array.isArray(filter.status) ? filter.status : [filter.status]
		if (list.length) params.set("status", list.join(","))
	}
	if (options.format) params.set("format", options.format)
	if (options.columns?.length) params.set("columns", options.columns.join(","))
	if (options.fields !== undefined) params.set("fields", options.fields ? "1" : "0")
	return params
}

/** When an export runs: a bare frequency is shorthand (`"weekly"` means Mondays at 09:00 UTC). */
export type ExportScheduleInput =
	| "daily"
	| "weekly"
	| "monthly"
	| {
			frequency: "daily" | "weekly" | "monthly"
			/** Weekly: JS weekday numbers (0 = Sunday). */
			days?: Array<number>
			/** Monthly: 1-31, clamped to shorter months. */
			month_day?: number
			/** "HH:MM", 24h. */
			send_time?: string
			/** IANA zone name, e.g. "Europe/London". */
			timezone?: string
	  }

/** What `exports.create` accepts. */
export interface ScheduledExportOptions {
	name: string
	/** Who gets the file — the same shapes as `to`. */
	recipients: Email | Array<Email>
	/** Sender — your send address or one at a verified domain. Omit for the account default. */
	from?: FromAddress
	filter?: ExportFilter
	/** `"csv"` by default. */
	format?: "csv" | "xlsx"
	/** Export column keys; the usual set when omitted. */
	columns?: Array<string>
	/** One column per form field after the chosen columns. On by default. */
	fields?: boolean
	/**
	 * Which rows each run covers: new since the last run (the default), the previous
	 * whole day, week or month in the schedule's zone, or everything the filter matches.
	 */
	window?: "since_last_run" | "previous_period" | "all_matching"
	schedule: ExportScheduleInput
}

/** A scheduled export as the API returns it. */
export interface ScheduledExportDetails {
	id: string
	name: string
	recipients: Array<{ email: string; name?: string }>
	from: string | null
	filter: Omit<ExportFilter, "form" | "status"> & { form?: string; status?: Array<string> }
	format: "csv" | "xlsx"
	columns: Array<string>
	fields: boolean
	window: "since_last_run" | "previous_period" | "all_matching"
	schedule: {
		frequency: "daily" | "weekly" | "monthly"
		days: Array<number>
		month_day: number
		send_time: string
		timezone: string
	}
	paused: boolean
	last_run_at: string | null
	/** Null while paused. */
	next_run_at: string | null
	last_error: string | null
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

/**
 * A recipient's per-list membership state. Only `subscribed` recipients receive
 * broadcasts and digests; `pending` awaits double-opt-in confirmation, `unsubscribed`
 * stays on the list (with history) but out of every send. Since 0.19 this is the
 * three-state membership enum — a bounce/complaint suppresses the address account-wide
 * (see `suppressions`) rather than living on the membership. Alias of
 * {@link MembershipStatus}. */
export type RecipientStatus = MembershipStatus

/** One recipient on a list — the contact joined to its membership. `data` is the
 * contact's global `{key}` broadcast variables; `status` is the per-list state. */
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
 * Anything `recipients.add` accepts as one recipient — the same shapes as `to`:
 * `"a@b.c"`, `"Name <a@b.c>"`, `{ address, name }`, or a {@link NewListRecipient}
 * when the recipient carries broadcast template `data`.
 */
export type ListRecipientInput = Email | NewListRecipient

/** A per-list membership status. Since 0.19 broadcasts/digests send to `subscribed`
 * only; a bounce/complaint suppresses the address account-wide rather than changing
 * this. */
export type MembershipStatus = "subscribed" | "pending" | "unsubscribed"

/**
 * A contact — one per address per account. `email` is the handle; `data` holds the
 * contact's global `{key}` broadcast variables, shared across every list it's on.
 * `phone` is the contact's mobile number in E.164, the one SMS and WhatsApp reach —
 * the first of the delivery profile that multi-channel sending is built on.
 */
export interface Contact {
	email: string
	name?: string
	/** E.164 (`+447788223344`), or absent when the contact has no number on file. */
	phone?: string
	data?: Record<string, string>
	created_at: string
	updated_at: string
}

/** A contact's presence on one list, with its per-list status. */
export interface Membership {
	list: { id: string; name: string }
	status: MembershipStatus
	subscribed_at?: string
	created_at: string
}

/** A contact with its list memberships, as returned by `GET /v1/contacts/:email`. */
export type ContactDetails = Contact & { memberships: Array<Membership> }

/** Fields `contacts.add`/`contacts.update` accept. Absent fields keep stored values. */
export interface ContactInput {
	name?: string
	/** The contact's mobile number, in E.164 (`+447788223344`). */
	phone?: string
	data?: Record<string, string>
}

/**
 * The channels a suppression can be on. Email has its own entry; a phone number is
 * suppressed per channel, because "stop texting me" and "stop WhatsApping me" are
 * two different things a person can say, and the law treats them separately.
 */
export type SuppressionChannel = "email" | "sms" | "whatsapp"

/**
 * One suppressed address on the account. Narrow on `channel` before reading the
 * address: an email suppression carries `email`, a text one carries `phone` — never
 * both, and never a number in a field called `email`.
 */
export type Suppression = {
	reason: "bounce" | "complaint" | "unsubscribe" | "manual"
	detail?: string
	created_at: string
} & ({ channel: "email"; email: string } | { channel: "sms" | "whatsapp"; phone: string })

/**
 * What `suppressions.add`/`remove` take: an email address as a bare string, or a phone
 * number — `channel` defaults to `sms` for a number, and `whatsapp` is the other option.
 */
export type SuppressionTarget = string | { phone: string; channel?: "sms" | "whatsapp" }

/** The message broadcast to every recipient on a list. */
export interface BroadcastOptions {
	/** Omitted = the account's sending address. Narrowed by `bunx postboi sync`. */
	from?: FromAddress
	reply_to?: Email
	subject: string
	/** HTML body. `{key}` placeholders are filled from each recipient's `data` server-side,
	 * plus the reserved `{name}`, `{email}`, and `{unsubscribe_url}` (that recipient's signed
	 * one-click opt-out link) variables. */
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

/** What `notifications.create` accepts; subject/body default to the starter template. */
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
 * The `confirmation` option on lists.create/lists.update. The boolean shorthand:
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

/** What lists.update accepts — rename and/or confirmation, both optional. */
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
 * You rarely need to construct it. Run `bunx postboi init` to write `POSTBOI_TOKEN` to
 * your environment, then use the zero-config `mail` — it sends *and* carries the same
 * namespaces this class exposes:
 *
 * @example
 * ```ts
 * import { mail } from "postboi"
 *
 * await mail({ to: "contact@example.com", subject: "Hello", body: "<p>Hi</p>" })
 * await mail.recipients.add("Newsletter", "ada@example.com")
 * await mail.lists.create("Newsletter", { confirmation: true })
 * ```
 *
 * Construct it only to hold explicit credentials or talk to two accounts at once:
 *
 * @example
 * ```ts
 * import Postboi from "postboi"
 *
 * const mailer = new Postboi({ token })
 * await mailer.recipients.add("Newsletter", "ada@example.com")
 * ```
 */
export default class Postboi extends ProviderBase<SendResponse> {
	protected readonly provider = "postboi"
	// The API defaults `from` to the account's sending address, so none is required here.
	protected override readonly requires_from = false
	// Turnstile tokens are verified by the API against the account's managed widget —
	// FormData sends need no local secret key.
	protected override readonly captcha_mode = "managed" as const
	#token: string | undefined
	#host: string
	#send_via: string | undefined
	#own_default: Defaults | undefined

	constructor({ token, base_url, send_via, ...options }: PostboiOptions = {}) {
		// Defaults can come from the environment (POSTBOI_FROM, …); anything passed
		// explicitly via `default` wins.
		super({ ...options, default: { ...env_defaults(), ...options.default } })
		// Kept so the environment can be re-read late without losing to it — see prepare_send.
		this.#own_default = options.default
		this.#token = token ?? read_env("POSTBOI_TOKEN")
		this.#send_via = send_via
		const host = base_url ?? read_env("POSTBOI_API_URL") ?? "https://postboi.app"
		this.#host = host.replace(/\/$/, "")
	}

	/**
	 * Re-read the environment's defaults on the send path as well as at construction, for
	 * the same reason `#require_token` re-reads the token: on Workers the
	 * bindings only reach the env cache once `ensure_env_loaded()` has run, and a
	 * constructor cannot await it. Without this the first send of an isolate quietly
	 * ignores POSTBOI_FROM, POSTBOI_LETTERHEAD and their kin, and the next one honours
	 * them — which is worse than either answer. The layering is the constructor's:
	 * config file, then environment, then what the caller passed.
	 */
	protected override async prepare_send(options: SendOptions): Promise<PreparedMessage> {
		await ensure_env_loaded()
		this.defaults = { ...this.defaults, ...env_defaults(), ...this.#own_default }
		return super.prepare_send(options)
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
		const data = await this.call(
			{
				url: `${this.#host}/v1${path}`,
				method: init.method,
				headers: {
					Authorization: `Bearer ${token}`,
					...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
			},
			path
		)
		return data as T
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

	/** Cancel a scheduled message via the Postboi API. */
	async cancel(id: string): Promise<CancelResponse> {
		await this.#api(`/messages/${encodeURIComponent(id)}/cancel`, { method: "POST" })
		return { id }
	}

	/** Inspect and reschedule messages. `cancel` mirrors the top-level {@link cancel}. */
	readonly messages = {
		/** Retrieve a message's delivery status and content. */
		get: (id: string): Promise<MessageDetails> =>
			this.#api(`/messages/${encodeURIComponent(id)}`, { method: "GET" }),

		/** Move a scheduled message to a new time. Only works until it sends. */
		reschedule: (
			id: string,
			scheduled_at: Date | string | Duration
		): Promise<{ id: string; scheduled_at: string }> =>
			this.#api(`/messages/${encodeURIComponent(id)}`, {
				method: "PATCH",
				body: { scheduled_at: this.resolve_scheduled_at(scheduled_at).toISOString() },
			}),

		/** Cancel a scheduled message — the same as the top-level `cancel`. */
		cancel: (id: string): Promise<CancelResponse> => this.cancel(id),
	}

	/** Lists (audiences) on the account. Their recipients live under `recipients`. */
	readonly lists = {
		/** Every list on the account. */
		all: async (): Promise<Array<ListSummary>> => {
			const data = await this.#api<{ lists: Array<ListSummary> }>("/lists", { method: "GET" })
			return data.lists
		},

		/** One list, with its recipients. `list` is a name or id. */
		get: (list: string): Promise<ListDetails> =>
			this.#api(`/lists/${encodeURIComponent(list)}`, { method: "GET" }),

		/** Create a list. Names are unique per account — a taken name rejects with `name_taken`.
		 * Pass `confirmation` to enable double opt-in from the start. */
		create: (
			name: string,
			options: { confirmation?: ListConfirmationInput } = {}
		): Promise<{
			id: string
			name: string
			confirmation: ConfirmationSettings
			created_at: string
		}> =>
			this.#api("/lists", {
				body: { name, confirmation: this.#confirmation_body(options.confirmation) },
			}),

		/**
		 * Update a list — rename it and/or change its confirmation (double opt-in) settings.
		 * `list` is a name or id.
		 *
		 * @example
		 * ```ts
		 * await mail.lists.update("Newsletter", { confirmation: true })
		 * await mail.lists.update("Newsletter", { confirmation: { from: "Bot <hi@acme.example>" } })
		 * ```
		 */
		update: (
			list: string,
			changes: ListChanges
		): Promise<{ id: string; name: string; confirmation: ConfirmationSettings }> =>
			this.#api(`/lists/${encodeURIComponent(list)}`, {
				method: "PATCH",
				body: { ...changes, confirmation: this.#confirmation_body(changes.confirmation) },
			}),

		/** Rename a list — shorthand for `lists.update(list, { name })`. `list` is a name or id. */
		rename: (list: string, name: string): Promise<{ id: string; name: string }> =>
			this.lists.update(list, { name }),

		/** Delete a list and its recipients. `list` is a name or id. */
		delete: (list: string): Promise<{ id: string; deleted: boolean }> =>
			this.#api(`/lists/${encodeURIComponent(list)}`, { method: "DELETE" }),

		/**
		 * Broadcast one message to every recipient on a list — `list` is a name or id.
		 * `{key}` placeholders are filled from each recipient's `data`, and one-click
		 * unsubscribe headers are added for you.
		 */
		broadcast: (list: string, options: BroadcastOptions): Promise<BroadcastResponse> =>
			this.#api(`/lists/${encodeURIComponent(list)}/send`, {
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
			}),
	}

	/** A list's recipients. `list` is a name or id throughout. */
	readonly recipients = {
		/**
		 * Add one recipient or an array to a list — upserting both sides: an unknown list
		 * name creates the list, and re-adding an address updates its name/`data` instead of
		 * duplicating it. `added` counts genuinely new addresses, `updated` the refreshed
		 * existing ones. Recipients take the same shapes as `to`: `"a@b.c"`, `"Name <a@b.c>"`,
		 * or `{ email, name, data }` where `data` holds the `{key}` broadcast variables.
		 *
		 * @example
		 * ```ts
		 * await mail.recipients.add("Newsletter", "Acme Inc <hello@acme.example>")
		 * ```
		 */
		add: (
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
		}> => {
			const rows = (Array.isArray(recipients) ? recipients : [recipients]).flatMap((entry) =>
				typeof entry === "string" || !("email" in entry) ? this.email_name_list(entry) : [entry]
			)
			const query = options.status ? `?status=${options.status}` : ""
			return this.#api(`/lists/${encodeURIComponent(list)}/recipients${query}`, { body: rows })
		},

		/**
		 * Set a recipient's status by hand — e.g. `"unsubscribed"` keeps them on the list
		 * (with history) but out of every future broadcast and digest, and `"subscribed"`
		 * brings them back.
		 */
		set_status: (
			list: string,
			email: string,
			status: RecipientStatus
		): Promise<{ email: string; status: RecipientStatus }> =>
			this.#api(`/lists/${encodeURIComponent(list)}/recipients`, {
				method: "PATCH",
				body: { email, status },
			}),

		/** Remove an address from a list — the membership goes; the contact stays. */
		remove: (list: string, email: string): Promise<{ email: string; deleted: boolean }> =>
			this.#api(
				`/lists/${encodeURIComponent(list)}/recipients?email=${encodeURIComponent(email)}`,
				{ method: "DELETE" }
			),

		/** Every recipient on a list, with their per-list status. `list` is a name or id. */
		all: async (list: string): Promise<Array<ListRecipient>> => {
			const data = await this.lists.get(list)
			return data.recipients
		},
	}

	/**
	 * Contacts — the account's audience. One contact per address; `email` is the handle
	 * throughout. `data` is the contact's global custom fields, shared across every list
	 * it belongs to. Membership of a list (and its per-list status) is managed under
	 * `recipients`; a contact's lists are read with `contacts.lists`.
	 */
	readonly contacts = {
		/**
		 * Upsert a contact by email — create it, or update an existing one's global
		 * name/`data` (last write wins; absent fields keep their stored values).
		 *
		 * @example
		 * ```ts
		 * await mail.contacts.add("ada@example.com", { name: "Ada", data: { plan: "pro" } })
		 * ```
		 */
		add: (email: string, contact: ContactInput = {}): Promise<Contact> =>
			this.#api("/contacts", {
				body: { email, name: contact.name, phone: contact.phone, data: contact.data },
			}),

		/** One contact with its list memberships. */
		get: (email: string): Promise<ContactDetails> =>
			this.#api(`/contacts/${encodeURIComponent(email)}`, { method: "GET" }),

		/** Update a contact's global name, phone and/or `data`. Pass `null` to clear a field. */
		update: (
			email: string,
			changes: {
				name?: string | null
				phone?: string | null
				data?: Record<string, string> | null
			}
		): Promise<Contact> =>
			this.#api(`/contacts/${encodeURIComponent(email)}`, { method: "PATCH", body: changes }),

		/** Delete a contact and all its list memberships. Does not add a suppression. */
		remove: (email: string): Promise<{ email: string; deleted: boolean }> =>
			this.#api(`/contacts/${encodeURIComponent(email)}`, { method: "DELETE" }),

		/**
		 * The whole audience, newest first — following pagination for you. Narrow with
		 * `list` (a name or id), a membership `status`, and/or a case-insensitive
		 * `search` over email and name.
		 */
		all: async (
			options: { list?: string; status?: MembershipStatus; search?: string } = {}
		): Promise<Array<Contact>> => {
			const out: Array<Contact> = []
			let cursor: string | undefined
			do {
				const params = new URLSearchParams()
				if (options.list) params.set("list", options.list)
				if (options.status) params.set("status", options.status)
				if (options.search) params.set("search", options.search)
				if (cursor) params.set("cursor", cursor)
				const query = params.toString()
				const page = await this.#api<{ contacts: Array<Contact>; cursor: string | null }>(
					`/contacts${query ? `?${query}` : ""}`,
					{ method: "GET" }
				)
				out.push(...page.contacts)
				cursor = page.cursor ?? undefined
			} while (cursor)
			return out
		},

		/** Which lists a contact is on, with its per-list status. */
		lists: async (email: string): Promise<Array<Membership>> => {
			const data = await this.#api<{ lists: Array<Membership> }>(
				`/contacts/${encodeURIComponent(email)}/lists`,
				{ method: "GET" }
			)
			return data.lists
		},
	}

	/** A list's notifications — its recurring digests. `list` is a name or id throughout. */
	readonly notifications = {
		/** Every notification on a list. */
		all: async (list: string): Promise<Array<NotificationDetails>> => {
			const data = await this.#api<{ notifications: Array<NotificationDetails> }>(
				`/lists/${encodeURIComponent(list)}/notifications`,
				{ method: "GET" }
			)
			return data.notifications
		},

		/**
		 * Create a notification on a list — a digest of new subscribers emailed on a schedule,
		 * or immediately when someone new joins (`schedule: "subscribe"`). Subject and body
		 * default to the starter template.
		 *
		 * @example
		 * ```ts
		 * await mail.notifications.create("Newsletter", {
		 * 	recipients: "Darby <darby@uilo.co>",
		 * 	schedule: { frequency: "weekly", days: [1], send_time: "09:00", timezone: "Europe/London" },
		 * })
		 * ```
		 */
		create: (list: string, options: NotificationOptions): Promise<NotificationDetails> =>
			this.#api(`/lists/${encodeURIComponent(list)}/notifications`, {
				body: {
					...options,
					recipients: this.email_name_list(options.recipients),
					from:
						options.from !== undefined
							? this.email_name(this.parse_email_address(options.from))
							: undefined,
				},
			}),

		/** Update a notification — absent fields keep their stored values. */
		update: (
			list: string,
			id: string,
			options: Partial<NotificationOptions> & { from?: FromAddress | null }
		): Promise<NotificationDetails> =>
			this.#api(`/lists/${encodeURIComponent(list)}/notifications/${encodeURIComponent(id)}`, {
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
			}),

		/** Delete a notification. */
		delete: (list: string, id: string): Promise<{ id: string; deleted: boolean }> =>
			this.#api(`/lists/${encodeURIComponent(list)}/notifications/${encodeURIComponent(id)}`, {
				method: "DELETE",
			}),
	}

	/**
	 * The account's suppression list — addresses every send is dropped for. Email
	 * addresses land here from hard bounces, complaints and the unsubscribe link; phone
	 * numbers from a texted STOP (surfaced by `poll()` on Twilio) or by hand. Each
	 * number is suppressed per channel: `{ phone }` means SMS, `{ phone, channel:
	 * "whatsapp" }` the other.
	 */
	/** The account's forms — what submissions are filed under, and what `form:` is typed to. */
	readonly forms = {
		/** Every form on the account, by id and current name. */
		all: async (): Promise<Array<FormSummary>> => {
			const data = await this.#api<{ forms: Array<FormSummary> }>("/forms", { method: "GET" })
			return data.forms
		},
	}

	/**
	 * Scheduled exports: a filter of the Sent log — a form's submissions, say — emailed
	 * as a CSV or spreadsheet every day, week or month. Each run's file lands in the log
	 * too, on the message that carried it.
	 *
	 * @example
	 * ```ts
	 * await mail.exports.create({
	 * 	name: "Home ownership queries, weekly",
	 * 	recipients: "Ops <ops@acme.example>",
	 * 	filter: { form: "Home Ownership Query" },
	 * 	schedule: { frequency: "weekly", days: [1], send_time: "09:00", timezone: "Europe/London" },
	 * })
	 * ```
	 */
	readonly exports = {
		/** Every scheduled export on the account. */
		all: async (): Promise<Array<ScheduledExportDetails>> => {
			const data = await this.#api<{ exports: Array<ScheduledExportDetails> }>("/exports", {
				method: "GET",
			})
			return data.exports
		},

		/** One scheduled export. */
		get: (id: string): Promise<ScheduledExportDetails> =>
			this.#api(`/exports/${encodeURIComponent(id)}`, { method: "GET" }),

		/** Create a scheduled export. */
		create: (options: ScheduledExportOptions): Promise<ScheduledExportDetails> =>
			this.#api("/exports", {
				body: {
					...options,
					recipients: this.email_name_list(options.recipients),
					from:
						options.from !== undefined
							? this.email_name(this.parse_email_address(options.from))
							: undefined,
				},
			}),

		/**
		 * Update a scheduled export — absent fields keep their stored values. `paused`
		 * pauses or resumes it; `from: null` reverts to the account's send address.
		 */
		update: (
			id: string,
			options: Partial<ScheduledExportOptions> & { from?: FromAddress | null; paused?: boolean }
		): Promise<ScheduledExportDetails> =>
			this.#api(`/exports/${encodeURIComponent(id)}`, {
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
			}),

		/** Run a scheduled export now — the file goes within a minute; the schedule carries on. */
		run: (id: string): Promise<{ id: string; queued: boolean }> =>
			this.#api(`/exports/${encodeURIComponent(id)}/run`, { method: "POST" }),

		/**
		 * The file now, without a schedule: the same filter, columns and fields a scheduled
		 * export takes, handed straight back. A CSV holds up to 50,000 rows, a spreadsheet
		 * 10,000; days are UTC days.
		 *
		 * @example
		 * ```ts
		 * const file = await mail.exports.download({ filter: { form: "Contact" } })
		 * await writeFile(file.filename, file.bytes)
		 * ```
		 */
		download: async (options: ExportDownloadOptions = {}): Promise<ExportFile> => {
			const token = this.#require_token()
			const query = export_download_params(options).toString()
			const response = await this.request({
				url: `${this.#host}/v1/exports/download${query ? `?${query}` : ""}`,
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
			})
			if (!response.ok) {
				const data = await this.read_json(response)
				const error = this.error_for(response, data, "/exports/download")
				if (error) throw error
			}
			const bytes = new Uint8Array(await response.arrayBuffer())
			const disposition = response.headers.get("content-disposition") ?? ""
			const named = disposition.match(/filename="([^"]+)"/)
			return {
				filename: named?.[1] ?? `export.${options.format ?? "csv"}`,
				type: response.headers.get("content-type") ?? "",
				bytes,
				text: () => new TextDecoder().decode(bytes),
			}
		},

		/** Delete a scheduled export. */
		delete: (id: string): Promise<{ id: string; deleted: boolean }> =>
			this.#api(`/exports/${encodeURIComponent(id)}`, { method: "DELETE" }),
	}

	readonly suppressions = {
		/** Every suppressed address on the account, optionally on one channel. */
		all: async (options: { channel?: SuppressionChannel } = {}): Promise<Array<Suppression>> => {
			const query = options.channel ? `?channel=${encodeURIComponent(options.channel)}` : ""
			const data = await this.#api<{ suppressions: Array<Suppression> }>(`/suppressions${query}`, {
				method: "GET",
			})
			return data.suppressions
		},

		/**
		 * Suppress an address by hand, so future sends to it are dropped.
		 *
		 * @example
		 * ```ts
		 * await mail.suppressions.add("noisy@example.com")
		 * await mail.suppressions.add({ phone: "+447788223344" }) // SMS
		 * await mail.suppressions.add({ phone: "+447788223344", channel: "whatsapp" })
		 * ```
		 */
		add: (
			target: SuppressionTarget
		): Promise<
			{ suppressed: boolean } & ({ email: string } | { phone: string; channel: string })
		> =>
			this.#api("/suppressions", {
				body:
					typeof target === "string"
						? { email: target }
						: { phone: target.phone, channel: target.channel ?? "sms" },
			}),

		/** Remove an address from the suppression list, so sending to it resumes. */
		remove: (
			target: SuppressionTarget
		): Promise<{ deleted: boolean } & ({ email: string } | { phone: string; channel: string })> =>
			this.#api(
				typeof target === "string"
					? `/suppressions?email=${encodeURIComponent(target)}`
					: `/suppressions?phone=${encodeURIComponent(target.phone)}&channel=${encodeURIComponent(target.channel ?? "sms")}`,
				{ method: "DELETE" }
			),
	}

	/**
	 * One recipient's key inside a batch. The caller gives the batch a single
	 * `idempotency_key`; each message needs its own, because a key names exactly one
	 * message — the API rejects a batch whose items share one. The suffix is the
	 * recipient's position in the *original* `to` array, so retrying the same batch
	 * derives the same keys even if a `before.send` hook dropped a different recipient
	 * the second time round.
	 */
	#batch_key(base: string | undefined, index: number): string | undefined {
		if (!base) return undefined
		const key = `${base}:${index}`
		if (key.length > MAX_IDEMPOTENCY_KEY) {
			throw new PostboiError({
				provider: this.provider,
				code: "invalid_request",
				message: `idempotency_key is too long for a batch: each recipient's key is "<key>:<index>", and ${MAX_IDEMPOTENCY_KEY} characters is the limit. Shorten it by ${key.length - MAX_IDEMPOTENCY_KEY} characters.`,
			})
		}
		return key
	}

	async #params(message: PreparedMessage, idempotency_key?: string): Promise<SendParams> {
		return {
			idempotency_key,
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
			captcha_ip: message.captcha?.remoteip,
			form: message.form ?? (message.captcha ? true : undefined),
			letterhead: message.letterhead,
			shell: message.shell,
			style: message.style,
			preheader: message.preheader,
			footnote: message.footnote,
			fields: message.fields,
			send_via: this.#send_via,
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
			body: JSON.stringify(
				await Promise.all(
					recipients.map((r) =>
						this.#params(r.message, this.#batch_key(r.message.idempotency_key, r.index))
					)
				)
			),
		}
	}

	// Batch returns `{ ids }`, aligned to the request order.
	// Sandboxed sends succeed but deliver nothing — worth exactly one line per instance,
	// so a batch job doesn't scroll the reason a mailbox stays empty out of view.
	// Per instance, not per module: two accounts in one process (or a fresh provider
	// after claiming) each get their own say.
	#announced_sandbox = false

	#announce_sandbox(data: { sandbox?: boolean; claim_url?: string } | null): void {
		if (!data?.sandbox || this.#announced_sandbox) return
		this.#announced_sandbox = true
		const claim = data.claim_url ? ` Claim your project to deliver for real: ${data.claim_url}` : ""
		console.log(
			`postboi: this account is sandboxed. Sends land in your Postboi message log and nothing is delivered.${claim}`
		)
	}

	protected parse_batch_response(
		_response: Response,
		data: unknown,
		recipients: Array<BatchRecipient>
	): Array<SendResponse | PostboiError> {
		this.#announce_sandbox(data as { sandbox?: boolean; claim_url?: string } | null)
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
		const result = data as SendResponse
		this.#announce_sandbox(result)
		return result
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
