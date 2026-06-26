import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Mandrill (Mailchimp Transactional) provider constructor. */
type Options = ApiKeyOptions

interface Recipient {
	email: string
	name?: string
	type: "to" | "cc" | "bcc"
}

interface Attachment {
	type: string
	name: string
	content: string
}

export interface SendParams {
	key: string
	message: {
		from_email: string
		from_name?: string
		subject: string
		html?: string
		text?: string
		to: Array<Recipient>
		headers?: Record<string, string>
		attachments?: Array<Attachment>
	}
}

type SendResult = {
	email: string
	status: "sent" | "queued" | "scheduled" | "rejected" | "invalid"
	reject_reason: string | null
	_id: string
}

type SendResponse = Array<SendResult>

/**
 * Mandrill / Mailchimp Transactional provider —
 * https://mailchimp.com/developer/transactional/api/messages/send-new-message/
 *
 * @example
 * ```ts
 * import Mandrill from "postboi/mandrill"
 *
 * const mail = new Mandrill({ api_key: MANDRILL_API_KEY, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Mandrill extends ProviderBase<SendResponse> {
	protected readonly provider = "mandrill"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const from = this.parse_email_address(message.from)
		const recipients: Array<Recipient> = [
			...this.parse_addresses(message.to).map((a) => ({
				...this.email_name(a),
				type: "to" as const,
			})),
			...(message.cc ? this.parse_addresses(message.cc) : []).map((a) => ({
				...this.email_name(a),
				type: "cc" as const,
			})),
			...(message.bcc ? this.parse_addresses(message.bcc) : []).map((a) => ({
				...this.email_name(a),
				type: "bcc" as const,
			})),
		]

		const params: SendParams = {
			key: this.#api_key,
			message: {
				from_email: from.address,
				from_name: from.name,
				subject: message.subject,
				html: message.html,
				text: message.text,
				to: recipients,
				headers: message.reply_to
					? { "Reply-To": this.stringify_addresses(message.reply_to) }
					: undefined,
				attachments: message.attachments
					? (await this.parse_attachments(message.attachments)).map((a) => ({
							type: a.mime_type,
							name: a.name,
							content: a.content,
						}))
					: undefined,
			},
		}

		return {
			url: "https://mandrillapp.com/api/1.0/messages/send",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	// Success is an array; a call-level error is a single object with status: "error".
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined
		const e = data as Record<string, unknown>
		if (e.status === "error" && typeof e.message === "string") {
			return { message: e.message, code: typeof e.code === "number" ? e.code : undefined }
		}
		return undefined
	}
}
