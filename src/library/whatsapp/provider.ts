/**
 * The WhatsApp channel's provider base — {@link Transport} plus WhatsApp's preparation:
 * defaults, E.164 normalisation, and the message-or-template choice.
 *
 * One recipient per send, because that's what both underlying APIs are (Twilio's Message
 * resource and Meta's `/messages` are single-recipient) — many recipients means an array
 * of sends, exactly like Twilio SMS.
 */
import { PostboiError, type Channel } from "../errors.js"
import { Transport, type BatchResult } from "../transport.js"
import { get_config } from "../config.js"
import { ensure_env_loaded } from "../env.js"
import { to_e164 } from "../sms/phone.js"
import type {
	Phone,
	PreparedWhatsapp,
	WhatsappDefaults,
	WhatsappOptions,
	WhatsappProviderOptions,
} from "./types.js"

export type {
	Phone,
	PreparedWhatsapp,
	WhatsappDefaults,
	WhatsappOptions,
	WhatsappProviderOptions,
} from "./types.js"

/**
 * Base class for WhatsApp providers.
 *
 * @example
 * ```ts
 * import Meta from "postboi/whatsapp-meta"
 *
 * const wa = new Meta({ access_token, phone_number_id })
 * await wa.send({ to: "+447788223344", template: "order_shipped", variables: { name: "Ada" } })
 * ```
 */
export abstract class WhatsappProvider<TResponse = unknown> extends Transport<
	TResponse,
	PreparedWhatsapp
> {
	protected readonly channel: Channel = "whatsapp"

	/**
	 * Whether the provider needs a sender. Meta's Cloud API addresses the sender in the
	 * URL (`phone_number_id`), so it sets this false; Twilio needs a `from` unless a
	 * Messaging Service supplies the pool.
	 */
	protected requires_from: boolean = true

	protected defaults: WhatsappDefaults

	constructor(options: WhatsappProviderOptions = {}) {
		super(options)
		const s = get_config()
		this.defaults = { ...s.whatsapp?.default, ...options.default }
	}

	/** Send one message. Throws a {@link PostboiError} on any failure. */
	send(options: WhatsappOptions): Promise<TResponse>
	/** Send many, with bounded concurrency. Never rejects — each yields its own result. */
	send(
		options: Array<WhatsappOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<TResponse>>>
	async send(
		options: WhatsappOptions | Array<WhatsappOptions>,
		batch: { concurrency?: number } = {}
	): Promise<TResponse | Array<BatchResult<TResponse>>> {
		if (Array.isArray(options)) {
			return this.run_batch(options, (one) => this.send(one), batch)
		}
		return this.with_hooks(
			() => this.prepare_whatsapp(options),
			(message) => this.deliver(message)
		)
	}

	/** Apply defaults, normalise the recipient and settle the message-or-template choice. */
	protected async prepare_whatsapp(options: WhatsappOptions): Promise<PreparedWhatsapp> {
		await ensure_env_loaded()

		const to = options.to ?? this.defaults.to
		const from = options.from ?? this.defaults.from
		const country = options.country ?? this.defaults.country

		if (!to) {
			throw new PostboiError({
				provider: this.provider,
				channel: "whatsapp",
				code: "no_recipient",
				message: "No recipient number provided (to or default.to).",
			})
		}
		if (!from && this.requires_from) {
			throw new PostboiError({
				provider: this.provider,
				channel: "whatsapp",
				code: "no_sender",
				message:
					"No sender provided (from or default.from) — your WhatsApp-enabled number in E.164.",
			})
		}
		const has_message = Boolean(options.message?.trim())
		const has_template = Boolean(options.template?.trim())
		if (!has_message && !has_template) {
			throw new PostboiError({
				provider: this.provider,
				channel: "whatsapp",
				code: "no_content",
				message:
					"Nothing to send — pass `message` (free-form, inside the 24h window) or `template` (pre-approved, anytime).",
			})
		}
		if (has_message && has_template) {
			// Picking one silently would hide a real mistake — a caller who passed both
			// almost certainly believes the message becomes the template's content.
			throw new PostboiError({
				provider: this.provider,
				channel: "whatsapp",
				code: "ambiguous_content",
				message:
					"Pass `message` or `template`, not both — a template's content is fixed at approval; use `variables` to fill its placeholders.",
			})
		}

		return {
			to: this.parse_phone(to, country),
			from,
			message: has_message ? options.message : undefined,
			template: has_template ? options.template : undefined,
			variables: options.variables,
			language: options.language ?? this.defaults.language ?? "en",
		}
	}

	/** Normalise a single {@link Phone} into its E.164 string. */
	protected parse_phone(phone: Phone, country?: string): string {
		if (typeof phone === "object") return to_e164(phone.number, country)
		return to_e164(phone, country)
	}

	/**
	 * Did the platform refuse a free-form message because the 24-hour customer service
	 * window is closed? The routine failure of WhatsApp, and the signal to send a
	 * template instead — or to let a `send()` fallback chain advance to the next channel.
	 *
	 * Zero-config callers have this as `whatsapp.closed(error)`, no extra import; the
	 * static exists for code holding a provider instance.
	 */
	static is_outside_window(error: unknown): boolean {
		return error instanceof PostboiError && error.code === "outside_window"
	}
}
