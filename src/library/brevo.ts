import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
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
	headers?: Record<string, string>
	tags?: Array<string>
	attachment?: Array<Attachment>
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
 * const mail = new Brevo({ api_key: BREVO_API_KEY, default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Brevo extends ProviderBase<SendResponse> {
	protected readonly provider = "brevo"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const params: SendParams = {
			sender: this.email_name(this.parse_email_address(message.from)),
			to: this.email_name_list(message.to),
			cc: message.cc ? this.email_name_list(message.cc) : undefined,
			bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
			replyTo: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			htmlContent: message.html,
			textContent: message.text,
			headers: message.headers,
			tags: message.tags,
			attachment: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						name: a.name,
					}))
				: undefined,
		}

		return {
			url: "https://api.brevo.com/v3/smtp/email",
			headers: {
				"api-key": this.#api_key,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.code === "string" && typeof e.message === "string") {
			return { message: e.message, code: e.code }
		}
		return undefined
	}
}
