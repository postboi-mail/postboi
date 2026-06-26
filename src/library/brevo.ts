import type { SendOptions, ApiKeyOptions } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Brevo provider constructor. */
type Options = ApiKeyOptions

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	name: string
}

export interface SendParams {
	sender: EmailName
	to: Array<EmailName>
	cc?: Array<EmailName>
	bcc?: Array<EmailName>
	replyTo?: EmailName
	subject: string
	htmlContent?: string
	textContent?: string
	attachment?: Array<Attachment>
}

interface SendError {
	code: string
	message: string
}

type SendResponse = { messageId: string }

/**
 * Brevo (formerly Sendinblue) transactional email provider —
 * https://developers.brevo.com/reference/sendtransacemail
 *
 * @example
 * ```ts
 * import Brevo from "postboi/brevo"
 *
 * const mail = new Brevo({ api_key: BREVO_API_KEY, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Brevo extends ProviderBase<SendResponse> {
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
			sender: this.email_name(this.parse_email_address(options.from)),
			to: this.email_name_list(options.to),
			cc: options.cc ? this.email_name_list(options.cc) : undefined,
			bcc: options.bcc ? this.email_name_list(options.bcc) : undefined,
			replyTo: options.reply_to ? this.email_name_list(options.reply_to)[0] : undefined,
			subject: options.subject || "Mail sent from website",
			htmlContent: typeof options.body === "string" ? options.body : undefined,
			textContent: options.text,
			attachment: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						content: a.content,
						name: a.name,
					}))
				: undefined,
		}

		const response = await fetch("https://api.brevo.com/v3/smtp/email", {
			method: "POST",
			headers: {
				"api-key": this.#api_key,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(params),
		})

		const data = await this.read_json(response)
		if (!response.ok) {
			throw this.is_error(data) ? data : new Error(`Brevo request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a Brevo error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return typeof e.code === "string" && typeof e.message === "string"
	}
}
