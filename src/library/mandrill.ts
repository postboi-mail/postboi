import type { SendOptions, ApiKeyOptions } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Mandrill (Mailchimp Transactional) provider constructor. */
type Options = ApiKeyOptions

interface Recipient {
	email: string
	name?: string
	type: "to" | "cc" | "bcc"
}

interface Attachment {
	type: string
	name: string
	content: string
}

export interface SendParams {
	key: string
	message: {
		from_email: string
		from_name?: string
		subject: string
		html?: string
		text?: string
		to: Array<Recipient>
		headers?: Record<string, string>
		attachments?: Array<Attachment>
	}
}

interface SendError {
	status: "error"
	code: number
	name: string
	message: string
}

type SendResult = {
	email: string
	status: "sent" | "queued" | "scheduled" | "rejected" | "invalid"
	reject_reason: string | null
	_id: string
}

type SendResponse = Array<SendResult>

/**
 * Mandrill / Mailchimp Transactional provider —
 * https://mailchimp.com/developer/transactional/api/messages/send-new-message/
 *
 * @example
 * ```ts
 * import Mandrill from "postboi/mandrill"
 *
 * const mail = new Mandrill({ api_key: MANDRILL_API_KEY, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Mandrill extends ProviderBase<SendResponse> {
	#api_key: string
	#defaults: { from?: string; to?: string }

	constructor({ api_key, default_from, default_to }: Options) {
		super()
		this.#api_key = api_key
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const from = this.parse_email_address(options.from)
		const recipients: Array<Recipient> = [
			...this.parse_addresses(options.to).map((a) => ({
				...this.email_name(a),
				type: "to" as const,
			})),
			...(options.cc ? this.parse_addresses(options.cc) : []).map((a) => ({
				...this.email_name(a),
				type: "cc" as const,
			})),
			...(options.bcc ? this.parse_addresses(options.bcc) : []).map((a) => ({
				...this.email_name(a),
				type: "bcc" as const,
			})),
		]

		const params: SendParams = {
			key: this.#api_key,
			message: {
				from_email: from.address,
				from_name: from.name,
				subject: options.subject || "Mail sent from website",
				html: typeof options.body === "string" ? options.body : undefined,
				text: options.text,
				to: recipients,
				headers: options.reply_to
					? { "Reply-To": this.stringify_addresses(options.reply_to) }
					: undefined,
				attachments: options.attachments
					? (await this.parse_attachments(options.attachments)).map((a) => ({
							type: a.mime_type,
							name: a.name,
							content: a.content,
						}))
					: undefined,
			},
		}

		const response = await fetch("https://mandrillapp.com/api/1.0/messages/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		})

		const data = await this.read_json(response)
		if (!response.ok || this.is_error(data)) {
			throw this.is_error(data) ? data : new Error(`Mandrill request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a Mandrill call-level error (a single object, not the success array). */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object" || Array.isArray(error)) return false
		const e = error as Record<string, unknown>
		return e.status === "error" && typeof e.message === "string"
	}
}
