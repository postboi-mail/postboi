import type { SendOptions, ApiKeyOptions } from "./index.js"
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

interface SendError {
	error?: string
	errors?: Record<string, Array<string>>
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
			to: this.stringify_addresses(options.to),
			cc: options.cc ? this.stringify_addresses(options.cc) : undefined,
			bcc: options.bcc ? this.stringify_addresses(options.bcc) : undefined,
			replyto: options.reply_to ? this.stringify_addresses(options.reply_to) : undefined,
			subject: options.subject || "Mail sent from website",
			htmlbody: typeof options.body === "string" ? options.body : undefined,
			textbody: options.text,
			attachments: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						name: a.name,
						content: a.content,
						content_type: a.mime_type,
					}))
				: undefined,
		}

		const response = await fetch("https://app.mailpace.com/api/v1/send", {
			method: "POST",
			headers: {
				"MailPace-Server-Token": this.#api_key,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(params),
		})

		const data = await this.read_json(response)
		if (!response.ok) {
			throw this.is_error(data) ? data : new Error(`MailPace request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a MailPace error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return typeof e.error === "string" || typeof e.errors === "object"
	}
}
