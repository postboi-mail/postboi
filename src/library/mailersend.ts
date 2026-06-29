import type {
	PreparedMessage,
	ApiKeyOptions,
	ProviderError,
	RequestSpec,
	BatchRecipient,
} from "./index.js"
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
	tags?: Array<string>
	attachments?: Array<Attachment>
}

type SendResponse = { message_id?: string }

/**
 * MailerSend provider — https://developers.mailersend.com/api/v1/email.html
 *
 * @example
 * ```ts
 * import MailerSend from "postboi/mailersend"
 *
 * const mail = new MailerSend({ api_key: MAILERSEND_API_KEY, default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class MailerSend extends ProviderBase<SendResponse> {
	protected readonly provider = "mailersend"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	async #params(message: PreparedMessage): Promise<SendParams> {
		return {
			from: this.email_name(this.parse_email_address(message.from)),
			to: this.email_name_list(message.to),
			cc: message.cc ? this.email_name_list(message.cc) : undefined,
			bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
			reply_to: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			tags: message.tags,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						filename: a.name,
						disposition: "attachment" as const,
					}))
				: undefined,
		}
	}

	#headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.#api_key}`,
			"Content-Type": "application/json",
			"X-Requested-With": "XMLHttpRequest",
		}
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		return {
			url: "https://api.mailersend.com/v1/email",
			headers: this.#headers(),
			body: JSON.stringify(await this.#params(message)),
		}
	}

	// MailerSend's bulk endpoint takes an array of messages and processes them async,
	// returning a single bulk_email_id (no per-recipient ids).
	protected async build_batch_request(
		_template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): Promise<RequestSpec> {
		const payload = await Promise.all(recipients.map((r) => this.#params(r.message)))
		return {
			url: "https://api.mailersend.com/v1/bulk-email",
			headers: this.#headers(),
			body: JSON.stringify(payload),
		}
	}

	// The bulk id stands in for every recipient's message id.
	protected parse_batch_response(
		_response: Response,
		data: unknown,
		recipients: Array<BatchRecipient>
	): Array<SendResponse> {
		const bulk = (data as { bulk_email_id?: string } | null)?.bulk_email_id
		return recipients.map(() => ({ message_id: bulk }))
	}

	// 202 Accepted with an empty body; the id is returned in a response header.
	protected parse_response(response: Response, _data: unknown): SendResponse {
		return { message_id: response.headers.get("x-message-id") ?? undefined }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.message === "string") return { message: e.message }
		return undefined
	}
}
