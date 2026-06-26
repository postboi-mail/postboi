import type { SendOptions, ApiKeyOptions } from "./index.js"
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
	Attachments?: Array<Attachment>
}

interface SendError {
	ErrorCode: number
	Message: string
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
	#api_key: string
	#message_stream: string
	#defaults: { from?: string; to?: string }

	constructor({ api_key, message_stream, default_from, default_to }: Options) {
		super()
		this.#api_key = api_key
		this.#message_stream = message_stream ?? "outbound"
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const params: SendParams = {
			From: this.stringify_address(this.parse_email_address(options.from)),
			To: this.stringify_addresses(options.to),
			Cc: options.cc ? this.stringify_addresses(options.cc) : undefined,
			Bcc: options.bcc ? this.stringify_addresses(options.bcc) : undefined,
			ReplyTo: options.reply_to ? this.stringify_addresses(options.reply_to) : undefined,
			Subject: options.subject || "Mail sent from website",
			HtmlBody: typeof options.body === "string" ? options.body : undefined,
			TextBody: options.text,
			MessageStream: this.#message_stream,
			Attachments: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						Name: a.name,
						Content: a.content,
						ContentType: a.mime_type,
					}))
				: undefined,
		}

		const response = await fetch("https://api.postmarkapp.com/email", {
			method: "POST",
			headers: {
				"X-Postmark-Server-Token": this.#api_key,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(params),
		})

		const data = await this.read_json(response)
		// Postmark signals application errors with ErrorCode !== 0, often on HTTP 200.
		if (!response.ok || this.is_error(data)) {
			throw this.is_error(data) ? data : new Error(`Postmark request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a Postmark error response (ErrorCode is non-zero). */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return typeof e.ErrorCode === "number" && e.ErrorCode !== 0 && typeof e.Message === "string"
	}
}
