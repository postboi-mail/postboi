import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the MailPace provider constructor. */
type Options = ApiKeyOptions

interface Attachment {
	name: string
	content: string
	content_type: string
}

export interface SendParams {
	from: string
	to: string
	cc?: string
	bcc?: string
	replyto?: string
	subject: string
	htmlbody?: string
	textbody?: string
	attachments?: Array<Attachment>
}

type SendResponse = { id: number; status: string }

/**
 * MailPace provider — https://docs.mailpace.com/reference/send
 *
 * @example
 * ```ts
 * import MailPace from "postboi/mailpace"
 *
 * const mail = new MailPace({ api_key: MAILPACE_SERVER_TOKEN, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class MailPace extends ProviderBase<SendResponse> {
	protected readonly provider = "mailpace"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const params: SendParams = {
			from: this.stringify_address(this.parse_email_address(message.from)),
			to: this.stringify_addresses(message.to),
			cc: message.cc ? this.stringify_addresses(message.cc) : undefined,
			bcc: message.bcc ? this.stringify_addresses(message.bcc) : undefined,
			replyto: message.reply_to ? this.stringify_addresses(message.reply_to) : undefined,
			subject: message.subject,
			htmlbody: message.html,
			textbody: message.text,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						name: a.name,
						content: a.content,
						content_type: a.mime_type,
					}))
				: undefined,
		}

		return {
			url: "https://app.mailpace.com/api/v1/send",
			headers: {
				"MailPace-Server-Token": this.#api_key,
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
		if (typeof e.error === "string") return { message: e.error }
		if (e.errors && typeof e.errors === "object") {
			const messages = Object.values(e.errors as Record<string, Array<string>>).flat()
			return { message: messages.join(", ") || "MailPace request failed" }
		}
		return undefined
	}
}
