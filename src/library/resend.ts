import type { SendOptions, ApiKeyOptions } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Resend provider constructor. */
type Options = ApiKeyOptions

interface Attachment {
	filename: string
	content: string
	content_type?: string
}

export interface SendParams {
	from: string
	to: Array<string>
	cc?: Array<string>
	bcc?: Array<string>
	reply_to?: Array<string>
	subject: string
	html?: string
	text?: string
	attachments?: Array<Attachment>
}

interface SendError {
	statusCode: number
	name: string
	message: string
}

type SendResponse = { id: string }

/**
 * Resend provider — https://resend.com/docs/api-reference/emails/send-email
 *
 * @example
 * ```ts
 * import Resend from "postboi/resend"
 *
 * const mail = new Resend({ api_key: RESEND_API_KEY, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Resend extends ProviderBase<SendResponse> {
	#api_key: string
	#defaults: { from?: string; to?: string }

	constructor({ api_key, default_from, default_to }: Options) {
		super()
		this.#api_key = api_key
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const params: SendParams = {
			from: this.stringify_address(this.parse_email_address(options.from)),
			to: this.parse_addresses(options.to).map((a) => this.stringify_address(a)),
			cc: options.cc
				? this.parse_addresses(options.cc).map((a) => this.stringify_address(a))
				: undefined,
			bcc: options.bcc
				? this.parse_addresses(options.bcc).map((a) => this.stringify_address(a))
				: undefined,
			reply_to: options.reply_to
				? this.parse_addresses(options.reply_to).map((a) => this.stringify_address(a))
				: undefined,
			subject: options.subject || "Mail sent from website",
			html: typeof options.body === "string" ? options.body : undefined,
			text: options.text,
			attachments: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						filename: a.name,
						content: a.content,
						content_type: a.mime_type,
					}))
				: undefined,
		}

		const response = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		})

		const data = await this.read_json(response)
		if (!response.ok) {
			throw this.is_error(data) ? data : new Error(`Resend request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a Resend error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return typeof e.message === "string" && typeof e.name === "string"
	}
}
