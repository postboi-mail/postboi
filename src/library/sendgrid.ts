import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the SendGrid provider constructor. */
type Options = ApiKeyOptions & {
	/** API region. Defaults to "us"; set "eu" to use the EU data residency host. */
	region?: "us" | "eu"
}

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	type: string
	filename: string
	disposition: "attachment"
}

export interface SendParams {
	personalizations: Array<{
		to: Array<EmailName>
		cc?: Array<EmailName>
		bcc?: Array<EmailName>
	}>
	from: EmailName
	reply_to?: EmailName
	subject: string
	content: Array<{ type: string; value: string }>
	attachments?: Array<Attachment>
}

type SendResponse = { message_id?: string }

/**
 * SendGrid v3 Mail Send provider — https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
 *
 * @example
 * ```ts
 * import SendGrid from "postboi/sendgrid"
 *
 * const mail = new SendGrid({ api_key: SENDGRID_API_KEY, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class SendGrid extends ProviderBase<SendResponse> {
	protected readonly provider = "sendgrid"
	#api_key: string
	#host: string

	constructor({ api_key, region, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#host = region === "eu" ? "https://api.eu.sendgrid.com" : "https://api.sendgrid.com"
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const content: SendParams["content"] = []
		if (message.text) content.push({ type: "text/plain", value: message.text })
		if (message.html) content.push({ type: "text/html", value: message.html })

		const params: SendParams = {
			personalizations: [
				{
					to: this.email_name_list(message.to),
					cc: message.cc ? this.email_name_list(message.cc) : undefined,
					bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
				},
			],
			from: this.email_name(this.parse_email_address(message.from)),
			reply_to: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			content,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						type: a.mime_type,
						filename: a.name,
						disposition: "attachment" as const,
					}))
				: undefined,
		}

		return {
			url: `${this.#host}/v3/mail/send`,
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	// 202 Accepted with an empty body; the id is returned in a response header.
	protected parse_response(response: Response, _data: unknown): SendResponse {
		return { message_id: response.headers.get("x-message-id") ?? undefined }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (!Array.isArray(e.errors)) return undefined
		const first = e.errors[0] as { message?: string } | undefined
		return { message: first?.message ?? "SendGrid request failed" }
	}
}
