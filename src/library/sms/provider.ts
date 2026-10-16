/**
 * The SMS channel's provider base — {@link Transport} plus the SMS-specific preparation
 * step: defaults, E.164 normalisation and recipient validation.
 *
 * Mirrors `EmailProvider` in shape, so a provider here implements the same three hooks
 * (`build_request`, `parse_response`, optionally `parse_error`) as an email one.
 */
import { PostboiError, SkipSendError, type Channel } from "../errors.js"
import { Transport, type BatchResult } from "../transport.js"
import { get_config } from "../config.js"
import { ensure_env_loaded, read_env } from "../env.js"
import { gsm7_breakers, phone_e164, redact_deep, redact_phones, segments } from "./phone.js"
import type {
	Phone,
	PreparedSms,
	SmsCheck,
	SmsDefaults,
	SmsIssue,
	SmsOptions,
	SmsProviderOptions,
} from "./types.js"

export type {
	SmsCheck,
	SmsIssue,
	Phone,
	PreparedSms,
	SmsDefaults,
	SmsOptions,
	SmsProviderOptions,
	SmsApiKeyOptions,
} from "./types.js"

/**
 * Base class for SMS providers.
 *
 * @example
 * ```ts
 * import Twilio from "postboi/twilio"
 *
 * const text = new Twilio({ account_sid, auth_token, default: { from: "POSTBOI" } })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export abstract class SmsProvider<TResponse = unknown> extends Transport<TResponse, PreparedSms> {
	protected readonly channel: Channel = "sms"

	/** Whether the provider needs a sender. Providers that default it account-side set false. */
	protected requires_from: boolean = true

	/** Whether the provider takes one recipient per request (Twilio, Telnyx, Vonage). */
	protected readonly single_recipient: boolean = false

	/** How many `media` URLs a send may carry. 0 means no MMS, and a send with media is refused. */
	protected readonly max_media: number = 0

	/** The `validity` this provider accepts, in seconds, or undefined where it takes none. */
	protected readonly validity_range?: readonly [number, number]

	/**
	 * The request fields the send's own options set, which `provider_options` may not
	 * overwrite (compared case-insensitively). Undefined where `provider_options` aren't
	 * carried at all.
	 */
	protected readonly reserved_options?: ReadonlyArray<string>

	/**
	 * Whether the provider can schedule a send. Left false, a `scheduled_at` is **rejected**
	 * rather than quietly sent immediately — a text that was meant for Tuesday arriving now
	 * is worse than an error, and the caller can't tell it happened.
	 */
	protected readonly supports_scheduling: boolean = false

	protected defaults: SmsDefaults

	#redact?: boolean

	constructor(options: SmsProviderOptions = {}) {
		super(options)
		// Global config sits underneath per-instance options, so explicit arguments win.
		const s = get_config()
		this.defaults = { ...s.sms?.default, ...options.default }
		this.#redact = options.redact
	}

	/**
	 * Whether phone numbers are masked on the way out. Read per use rather than at
	 * construction, because the environment may not be loaded until the first send.
	 */
	protected get redacting(): boolean {
		if (this.#redact !== undefined) return this.#redact
		const env = read_env("POSTBOI_SMS_REDACT")
		if (env !== undefined) return env === "1" || env.toLowerCase() === "true"
		return get_config().sms?.redact === true
	}

	protected override observable<T>(value: T): T {
		return this.redacting ? redact_deep(value) : value
	}

	/**
	 * The error a send throws, with its numbers masked when redacting. Masked in place, so a
	 * subclass and its `instanceof` survive, and the stack too, since it opens with the
	 * message. An intentional skip is not a failure and is left alone.
	 */
	protected override normalize_error(error: unknown): PostboiError {
		const e = super.normalize_error(error)
		if (!this.redacting || e instanceof SkipSendError) return e
		e.message = redact_phones(e.message)
		if (e.stack) e.stack = redact_phones(e.stack)
		Object.defineProperty(e, "raw", { value: redact_deep(e.raw), enumerable: true })
		return e
	}

	/** Send one text. Throws a {@link PostboiError} on any failure. */
	send(options: SmsOptions): Promise<TResponse>
	/**
	 * Send many texts as individual requests with bounded concurrency (default 5).
	 * Never rejects — each message yields its own {@link BatchResult}.
	 */
	send(
		options: Array<SmsOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<TResponse>>>
	async send(
		options: SmsOptions | Array<SmsOptions>,
		batch: { concurrency?: number } = {}
	): Promise<TResponse | Array<BatchResult<TResponse>>> {
		return this.dispatch(options, batch, (one) => this.prepare_sms(one))
	}

	/** Normalise one-or-many recipients, accepting a comma-separated string like `to` does. */
	protected parse_phones(phones: Array<Phone> | Phone, country?: string): Array<string> {
		if (Array.isArray(phones)) return phones.map((p) => phone_e164(p, country))
		if (typeof phones === "string" && phones.includes(",")) {
			return phones
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
				.map((p) => phone_e164(p, country))
		}
		return [phone_e164(phones, country)]
	}

	/**
	 * Apply defaults, normalise recipients to E.164 and validate that a recipient (and a
	 * sender, where the provider needs one) is present. Returns a {@link PreparedSms}, or
	 * throws the first problem {@link validate} would have listed.
	 */
	protected async prepare_sms(options: SmsOptions): Promise<PreparedSms> {
		const { prepared, errors } = await this.inspect(options)
		if (errors.length > 0) throw errors[0]
		return prepared as PreparedSms
	}

	/**
	 * Check a text without sending it: the numbers it would go to, what it costs in segments
	 * and encoding, and every problem a send would refuse it for, rather than only the first.
	 * Local and free; nothing is asked of the provider, so a sender's registration or a
	 * number's reachability can only be known by sending.
	 *
	 * ```ts
	 * const check = await text.validate({ to: "07788 223344", message: "Your code is “4291”" })
	 * // { ok: true, to: ["+447788223344"], encoding: "ucs2", segments: 1,
	 * //   ucs2_characters: ["“", "”"], issues: [], … }
	 * ```
	 */
	async validate(options: SmsOptions): Promise<SmsCheck> {
		const { prepared, errors, to } = await this.inspect(options)
		const message = options.message ?? ""
		const cost = segments(message)
		const issues: Array<SmsIssue> = []
		const seen = new Set<string>()
		const add = (code: string | number | undefined, text: string) => {
			const key = `${code}:${text}`
			if (seen.has(key)) return
			seen.add(key)
			issues.push({ code: String(code ?? "invalid"), message: text })
		}
		for (const error of errors) add(error.code, error.message)
		if (prepared) for (const issue of this.check(prepared)) add(issue.code, issue.message)
		const sender = options.from ?? this.defaults.from
		if (sender) {
			const problem = sender_problem(sender)
			if (problem) add("invalid_sender", problem)
		}
		return {
			ok: issues.length === 0,
			provider: this.provider,
			to,
			encoding: cost.encoding,
			segments: cost.count,
			units: cost.units,
			ucs2_characters: cost.encoding === "ucs2" ? gsm7_breakers(message) : [],
			issues,
		}
	}

	/**
	 * Problems this provider would refuse a prepared text for that every provider wouldn't:
	 * one recipient per request, say, or a scheduled send that needs a setting. Reported by
	 * {@link validate}; a send meets the same refusal from the provider's own request
	 * builder, so this exists to say so early, not to enforce it.
	 */
	protected check(message: PreparedSms): Array<SmsIssue> {
		if (this.single_recipient && message.to.length > 1) {
			return [
				{
					code: "single_recipient_only",
					message: `${this.provider} sends to one recipient per message. Pass an array of sends instead of an array of recipients.`,
				},
			]
		}
		return []
	}

	/**
	 * Every problem with a text, as the errors a send would throw, in the order it would meet
	 * them, plus the message prepared when there were none.
	 */
	protected async inspect(options: SmsOptions): Promise<{
		prepared?: PreparedSms
		errors: Array<PostboiError>
		to: Array<string>
	}> {
		// Makes Worker bindings and `.env` values readable, so a provider constructed with no
		// arguments can still find its credentials. Cached after the first send.
		await ensure_env_loaded()

		const to = options.to ?? this.defaults.to
		const from = options.from ?? this.defaults.from
		const country = options.country ?? this.defaults.country
		const errors: Array<PostboiError> = []
		const fail = (code: string, message: string) =>
			errors.push(new PostboiError({ provider: this.provider, channel: "sms", code, message }))

		if (!to) fail("no_recipient", "No recipient number provided (to or default.to).")
		if (!from && this.requires_from) {
			fail(
				"no_sender",
				"No sender provided (from or default.from). SMS needs a purchased number or an alphanumeric sender ID."
			)
		}
		if (!options.message?.trim()) {
			fail("empty_message", "Cannot send an empty SMS: `message` is required.")
		}

		let scheduled_at: Date | undefined
		if (options.scheduled_at !== undefined) {
			if (!this.supports_scheduling) {
				fail(
					"scheduling_not_supported",
					`${this.provider} cannot schedule SMS. Remove scheduled_at, or use a provider that supports it.`
				)
			} else {
				scheduled_at = this.resolve_scheduled_at(options.scheduled_at)
				if (Number.isNaN(scheduled_at.getTime())) {
					fail(
						"invalid_scheduled_at",
						`Invalid scheduled_at value: ${String(options.scheduled_at)}`
					)
				}
			}
		}

		const media = options.media?.length ? options.media : undefined
		if (media) {
			if (this.max_media === 0) {
				fail(
					"media_not_supported",
					`${this.provider} can't send MMS. Remove media, or use a provider that can (Twilio, Telnyx, Plivo, Bandwidth).`
				)
			} else if (media.length > this.max_media) {
				fail(
					"too_much_media",
					`${this.provider} takes up to ${this.max_media} media URLs; got ${media.length}.`
				)
			}
			for (const url of media) {
				if (!/^https?:\/\//i.test(url))
					fail("invalid_media", `Media must be a public http(s) URL: ${url}`)
			}
		}

		if (options.validity !== undefined) {
			const range = this.validity_range
			if (!range) {
				fail(
					"validity_not_supported",
					`${this.provider} can't limit how long it tries. Remove validity, or use a provider that can (Twilio, Vonage, Plivo, Sinch).`
				)
			} else if (
				!Number.isInteger(options.validity) ||
				options.validity < range[0] ||
				options.validity > range[1]
			) {
				fail(
					"invalid_validity",
					`${this.provider} takes a validity of ${range[0]} to ${range[1]} seconds; got ${options.validity}.`
				)
			}
		}

		const extra =
			options.provider_options && Object.keys(options.provider_options).length > 0
				? options.provider_options
				: undefined
		if (extra) {
			const reserved = this.reserved_options
			if (!reserved) {
				fail("provider_options_not_supported", `${this.provider} doesn't take provider_options.`)
			} else {
				const lower = new Set(reserved.map((name) => name.toLowerCase()))
				const taken = Object.keys(extra).filter((name) => lower.has(name.toLowerCase()))
				if (taken.length > 0) {
					fail(
						"reserved_provider_option",
						`provider_options can't set ${taken.join(", ")}: the send's own fields set ${taken.length === 1 ? "it" : "them"}.`
					)
				}
			}
		}

		// Each number on its own, so one bad number doesn't hide the rest from validate().
		const recipients: Array<string> = []
		let unreadable = 0
		for (const phone of to ? phone_list(to) : []) {
			try {
				recipients.push(...this.parse_phones(phone, country))
			} catch (error) {
				if (!(error instanceof PostboiError)) throw error
				errors.push(error)
				unreadable++
			}
		}
		// `[]` and `", "` are truthy, and would otherwise reach a provider as a request with
		// nobody on it — a billable call for a batch endpoint, a confusing 4xx for the rest.
		if (to && recipients.length === 0 && unreadable === 0) {
			fail("no_recipient", "No recipient number provided (to or default.to).")
		}

		if (errors.length > 0) return { errors, to: recipients }
		return {
			errors,
			to: recipients,
			prepared: {
				to: recipients,
				from,
				message: options.message,
				scheduled_at,
				tags: options.tags,
				idempotency_key: options.idempotency_key,
				media,
				validity: options.validity,
				provider_options: extra,
			},
		}
	}
}

/** One-or-many recipients as a list, splitting a comma-separated string as `to` does. */
function phone_list(phones: Array<Phone> | Phone): Array<Phone> {
	if (Array.isArray(phones)) return phones
	if (typeof phones === "string" && phones.includes(",")) {
		return phones
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
	}
	return [phones]
}

/**
 * What's wrong with a sender, if anything a carrier would refuse: an alphanumeric ID longer
 * than 11 characters or carrying anything but letters, digits and spaces. A number, short
 * code or `+`-prefixed sender is left to the provider, which knows what it registered.
 */
export function sender_problem(from: string): string | undefined {
	const sender = from.trim()
	if (/^\+?\d+$/.test(sender)) return undefined
	if (!/[A-Za-z]/.test(sender)) return undefined
	if (sender.length > 11) {
		return `Alphanumeric sender "${sender}" is ${sender.length} characters; carriers allow 11.`
	}
	if (!/^[A-Za-z0-9 ]+$/.test(sender)) {
		return `Alphanumeric sender "${sender}" may only use letters, digits and spaces.`
	}
	return undefined
}
