import type { SendOptions, ApiKeyOptions } from "./index.js"
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

interface SendError {
	code?: number
	error?: string
	message: string
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
	#api_key: string
	#defaults: { from?: string; to?: string }

	constructor({ api_key, default_from, default_to }: Options) {
		super()
		this.#api_key = api_key
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)
		const from = this.parse_email_address(options.from)

		const params: SendParams = {
			to: this.parse_addresses(options.to).map((a) => a.address),
			subject: options.subject || "Mail sent from website",
			body: typeof options.body === "string" ? options.body : "",
			from: from.address,
			name: from.name,
			reply: options.reply_to ? this.parse_addresses(options.reply_to)[0].address : undefined,
			attachments: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						filename: a.name,
						content: a.content,
						contentType: a.mime_type,
					}))
				: undefined,
		}

		const response = await fetch("https://api.useplunk.com/v1/send", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		})

		const data = await this.read_json(response)
		if (!response.ok || this.is_error(data)) {
			throw this.is_error(data) ? data : new Error(`Plunk request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a Plunk error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return e.success !== true && typeof e.message === "string"
	}
}
