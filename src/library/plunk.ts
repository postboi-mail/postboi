import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Plunk provider constructor. */
type Options = ApiKeyOptions

interface Attachment {
	filename: string
	content: string
	contentType: string
}

export interface SendParams {
	to: Array<string>
	subject: string
	body: string
	from?: string
	name?: string
	reply?: string
	attachments?: Array<Attachment>
}

type SendResponse = {
	success: boolean
	emails: Array<{ contact: { id: string; email: string }; email: string }>
	timestamp: string
}

/**
 * Plunk provider — https://docs.useplunk.com/api-reference/transactional/send
 *
 * Plunk has no cc/bcc concept; multiple recipients are passed via `to`.
 *
 * @example
 * ```ts
 * import Plunk from "postboi/plunk"
 *
 * const mail = new Plunk({ api_key: PLUNK_API_KEY, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Plunk extends ProviderBase<SendResponse> {
	protected readonly provider = "plunk"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const from = this.parse_email_address(message.from)

		const params: SendParams = {
			to: this.parse_addresses(message.to).map((a) => a.address),
			subject: message.subject,
			body: message.html ?? "",
			from: from.address,
			name: from.name,
			reply: message.reply_to ? this.parse_addresses(message.reply_to)[0].address : undefined,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						filename: a.name,
						content: a.content,
						contentType: a.mime_type,
					}))
				: undefined,
		}

		return {
			url: "https://api.useplunk.com/v1/send",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
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
		if (e.success !== true && typeof e.message === "string") {
			return { message: e.message, code: typeof e.code === "number" ? e.code : undefined }
		}
		return undefined
	}
}
