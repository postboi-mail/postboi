import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Resend provider constructor. */
type Options = ApiKeyOptions

interface Attachment {
	filename: string
	content: string
	content_type?: string
}

export interface SendParams {
	from: string
	to: Array<string>
	cc?: Array<string>
	bcc?: Array<string>
	reply_to?: Array<string>
	subject: string
	html?: string
	text?: string
	attachments?: Array<Attachment>
	headers?: Record<string, string>
	tags?: Array<{ name: string; value: string }>
}

type SendResponse = { id: string }

/**
 * Resend provider — https://resend.com/docs/api-reference/emails/send-email
 *
 * @example
 * ```ts
 * import Resend from "postboi/resend"
 *
 * const mail = new Resend({ api_key: RESEND_API_KEY, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Resend extends ProviderBase<SendResponse> {
	protected readonly provider = "resend"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const params: SendParams = {
			from: this.stringify_address(this.parse_email_address(message.from)),
			to: this.parse_addresses(message.to).map((a) => this.stringify_address(a)),
			cc: message.cc
				? this.parse_addresses(message.cc).map((a) => this.stringify_address(a))
				: undefined,
			bcc: message.bcc
				? this.parse_addresses(message.bcc).map((a) => this.stringify_address(a))
				: undefined,
			reply_to: message.reply_to
				? this.parse_addresses(message.reply_to).map((a) => this.stringify_address(a))
				: undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: message.headers,
			tags: message.tags?.map((t) => ({ name: t, value: t })),
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						filename: a.name,
						content: a.content,
						content_type: a.mime_type,
					}))
				: undefined,
		}

		return {
			url: "https://api.resend.com/emails",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
				...(message.idempotency_key ? { "Idempotency-Key": message.idempotency_key } : {}),
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
		if (typeof e.message === "string" && typeof e.name === "string") {
			return { message: e.message, code: e.name }
		}
		return undefined
	}
}
