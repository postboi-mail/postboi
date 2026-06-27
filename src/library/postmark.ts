import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Postmark provider constructor. */
type Options = ApiKeyOptions & {
	/** Message stream to send through. Defaults to "outbound". */
	message_stream?: string
}

interface Attachment {
	Name: string
	Content: string
	ContentType: string
}

export interface SendParams {
	From: string
	To: string
	Cc?: string
	Bcc?: string
	ReplyTo?: string
	Subject: string
	HtmlBody?: string
	TextBody?: string
	MessageStream: string
	Headers?: Array<{ Name: string; Value: string }>
	Tag?: string
	Attachments?: Array<Attachment>
}

type SendResponse = {
	To: string
	SubmittedAt: string
	MessageID: string
	ErrorCode: number
	Message: string
}

/**
 * Postmark provider — https://postmarkapp.com/developer/api/email-api
 *
 * @example
 * ```ts
 * import Postmark from "postboi/postmark"
 *
 * const mail = new Postmark({ api_key: POSTMARK_SERVER_TOKEN, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Postmark extends ProviderBase<SendResponse> {
	protected readonly provider = "postmark"
	#api_key: string
	#message_stream: string

	constructor({ api_key, message_stream, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#message_stream = message_stream ?? "outbound"
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const params: SendParams = {
			From: this.stringify_address(this.parse_email_address(message.from)),
			To: this.stringify_addresses(message.to),
			Cc: message.cc ? this.stringify_addresses(message.cc) : undefined,
			Bcc: message.bcc ? this.stringify_addresses(message.bcc) : undefined,
			ReplyTo: message.reply_to ? this.stringify_addresses(message.reply_to) : undefined,
			Subject: message.subject,
			HtmlBody: message.html,
			TextBody: message.text,
			MessageStream: this.#message_stream,
			// Postmark supports a single Tag; use the first if several are provided.
			Tag: message.tags?.[0],
			Headers: message.headers
				? Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value }))
				: undefined,
			Attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						Name: a.name,
						Content: a.content,
						ContentType: a.mime_type,
					}))
				: undefined,
		}

		return {
			url: "https://api.postmarkapp.com/email",
			headers: {
				"X-Postmark-Server-Token": this.#api_key,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	// Postmark signals application errors with ErrorCode !== 0, often on HTTP 200.
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.ErrorCode === "number" && e.ErrorCode !== 0 && typeof e.Message === "string") {
			return { message: e.Message, code: e.ErrorCode }
		}
		return undefined
	}
}
