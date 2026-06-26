import type { SendOptions, ApiKeyOptions } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the MailerSend provider constructor. */
type Options = ApiKeyOptions

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	filename: string
	disposition: "attachment"
}

export interface SendParams {
	from: EmailName
	to: Array<EmailName>
	cc?: Array<EmailName>
	bcc?: Array<EmailName>
	reply_to?: EmailName
	subject: string
	html?: string
	text?: string
	attachments?: Array<Attachment>
}

interface SendError {
	message: string
	errors?: Record<string, Array<string>>
}

type SendResponse = { message_id?: string }

/**
 * MailerSend provider — https://developers.mailersend.com/api/v1/email.html
 *
 * @example
 * ```ts
 * import MailerSend from "postboi/mailersend"
 *
 * const mail = new MailerSend({ api_key: MAILERSEND_API_KEY, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class MailerSend extends ProviderBase<SendResponse> {
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
			from: this.email_name(this.parse_email_address(options.from)),
			to: this.email_name_list(options.to),
			cc: options.cc ? this.email_name_list(options.cc) : undefined,
			bcc: options.bcc ? this.email_name_list(options.bcc) : undefined,
			reply_to: options.reply_to ? this.email_name_list(options.reply_to)[0] : undefined,
			subject: options.subject || "Mail sent from website",
			html: typeof options.body === "string" ? options.body : undefined,
			text: options.text,
			attachments: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						content: a.content,
						filename: a.name,
						disposition: "attachment" as const,
					}))
				: undefined,
		}

		const response = await fetch("https://api.mailersend.com/v1/email", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
				"X-Requested-With": "XMLHttpRequest",
			},
			body: JSON.stringify(params),
		})

		if (!response.ok) {
			const data = await this.read_json(response)
			throw this.is_error(data) ? data : new Error(`MailerSend request failed (${response.status})`)
		}
		// 202 Accepted with an empty body; the id is returned in a response header.
		return { message_id: response.headers.get("x-message-id") ?? undefined }
	}

	/** Type guard for a MailerSend error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return typeof e.message === "string"
	}
}
