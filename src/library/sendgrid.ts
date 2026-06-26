import type { SendOptions, ApiKeyOptions } from "./index.js"
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

interface SendError {
	errors: Array<{ message: string; field?: string; help?: string }>
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
	#api_key: string
	#host: string
	#defaults: { from?: string; to?: string }

	constructor({ api_key, region, default_from, default_to }: Options) {
		super()
		this.#api_key = api_key
		this.#host = region === "eu" ? "https://api.eu.sendgrid.com" : "https://api.sendgrid.com"
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const content: SendParams["content"] = []
		if (options.text) content.push({ type: "text/plain", value: options.text })
		if (typeof options.body === "string") content.push({ type: "text/html", value: options.body })

		const params: SendParams = {
			personalizations: [
				{
					to: this.email_name_list(options.to),
					cc: options.cc ? this.email_name_list(options.cc) : undefined,
					bcc: options.bcc ? this.email_name_list(options.bcc) : undefined,
				},
			],
			from: this.email_name(this.parse_email_address(options.from)),
			reply_to: options.reply_to ? this.email_name_list(options.reply_to)[0] : undefined,
			subject: options.subject || "Mail sent from website",
			content,
			attachments: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						content: a.content,
						type: a.mime_type,
						filename: a.name,
						disposition: "attachment" as const,
					}))
				: undefined,
		}

		const response = await fetch(`${this.#host}/v3/mail/send`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		})

		if (!response.ok) {
			const data = await this.read_json(response)
			throw this.is_error(data) ? data : new Error(`SendGrid request failed (${response.status})`)
		}
		// 202 Accepted with an empty body; the id is returned in a response header.
		return { message_id: response.headers.get("x-message-id") ?? undefined }
	}

	/** Type guard for a SendGrid error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return Array.isArray(e.errors)
	}
}
