import type {
	PreparedMessage,
	CommonProviderOptions,
	ProviderError,
	RequestSpec,
	BatchRecipient,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"

/** Options for the Mailjet provider constructor. Mailjet authenticates with a key + secret pair. */
type Options = CommonProviderOptions & {
	/** API key (public). */
	api_key: string
	/** API secret key (private). */
	api_secret: string
}

interface EmailName {
	Email: string
	Name?: string
}

interface Attachment {
	ContentType: string
	Filename: string
	Base64Content: string
}

interface Message {
	From: EmailName
	To: Array<EmailName>
	Cc?: Array<EmailName>
	Bcc?: Array<EmailName>
	ReplyTo?: EmailName
	Subject: string
	HTMLPart?: string
	TextPart?: string
	Headers?: Record<string, string>
	Attachments?: Array<Attachment>
}

export interface SendParams {
	Messages: Array<Message>
}

type MessageResult = {
	Status: string
	To?: Array<{ Email: string; MessageID: number; MessageUUID: string }>
	Errors?: Array<{ ErrorMessage: string; ErrorCode: string }>
}

type SendResponse = { message_id: string; message_uuid: string }

/**
 * Mailjet Send API v3.1 provider — https://dev.mailjet.com/email/guides/send-api-v31/
 *
 * @example
 * ```ts
 * import Mailjet from "postboi/mailjet"
 *
 * const mail = new Mailjet({
 * 	api_key: MJ_APIKEY_PUBLIC,
 * 	api_secret: MJ_APIKEY_PRIVATE,
 * 	default: { from: "no-reply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Mailjet extends ProviderBase<SendResponse> {
	protected readonly provider = "mailjet"
	#auth: string

	constructor({ api_key, api_secret, ...options }: Options) {
		super(options)
		this.#auth = `Basic ${Buffer.from(`${api_key}:${api_secret}`).toString("base64")}`
	}

	#addr(address: { address: string; name?: string }): EmailName {
		return address.name ? { Email: address.address, Name: address.name } : { Email: address.address }
	}

	async #message(message: PreparedMessage): Promise<Message> {
		return {
			From: this.#addr(this.parse_email_address(message.from)),
			To: this.parse_addresses(message.to).map((a) => this.#addr(a)),
			Cc: message.cc ? this.parse_addresses(message.cc).map((a) => this.#addr(a)) : undefined,
			Bcc: message.bcc ? this.parse_addresses(message.bcc).map((a) => this.#addr(a)) : undefined,
			ReplyTo: message.reply_to ? this.#addr(this.parse_addresses(message.reply_to)[0]) : undefined,
			Subject: message.subject,
			HTMLPart: message.html,
			TextPart: message.text,
			Headers: message.headers,
			Attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						ContentType: a.mime_type,
						Filename: a.name,
						Base64Content: a.content,
					}))
				: undefined,
		}
	}

	#request(params: SendParams): RequestSpec {
		return {
			url: "https://api.mailjet.com/v3.1/send",
			headers: { Authorization: this.#auth, "Content-Type": "application/json" },
			body: JSON.stringify(params),
		}
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		return this.#request({ Messages: [await this.#message(message)] })
	}

	// Mailjet batches natively: one POST carrying a fully-rendered Message per recipient.
	protected async build_batch_request(
		_template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): Promise<RequestSpec> {
		const Messages = await Promise.all(recipients.map((r) => this.#message(r.message)))
		return this.#request({ Messages })
	}

	#result(item: MessageResult | undefined): SendResponse | PostboiError {
		if (!item) {
			return new PostboiError({ provider: this.provider, message: "Missing batch result for recipient" })
		}
		if (item.Status !== "success") {
			const err = item.Errors?.[0]
			return new PostboiError({
				provider: this.provider,
				message: err?.ErrorMessage ?? "Mailjet send failed",
				code: err?.ErrorCode,
				raw: item,
			})
		}
		const to = item.To?.[0]
		return { message_id: String(to?.MessageID ?? ""), message_uuid: to?.MessageUUID ?? "" }
	}

	// Messages array is aligned to the request order, one entry per recipient.
	protected parse_batch_response(
		_response: Response,
		data: unknown,
		recipients: Array<BatchRecipient>
	): Array<SendResponse | PostboiError> {
		const items = (data as { Messages?: Array<MessageResult> } | null)?.Messages ?? []
		return recipients.map((_, i) => this.#result(items[i]))
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const result = this.#result((data as { Messages?: Array<MessageResult> } | null)?.Messages?.[0])
		if (result instanceof PostboiError) throw result
		return result
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		// Per-message failure (often on HTTP 200): Messages[0].Status === "error".
		const first = (e.Messages as Array<MessageResult> | undefined)?.[0]
		if (first && first.Status !== "success") {
			const err = first.Errors?.[0]
			return { message: err?.ErrorMessage ?? "Mailjet send failed", code: err?.ErrorCode }
		}
		// Global failure (auth, malformed request): top-level ErrorMessage.
		if (typeof e.ErrorMessage === "string") {
			return { message: e.ErrorMessage, code: e.ErrorCode as string | undefined }
		}
		return undefined
	}
}
