import type { SendOptions, ApiKeyOptions } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the SparkPost provider constructor. */
type Options = ApiKeyOptions & {
	/** API region. Defaults to "us"; set "eu" to use the EU host. */
	region?: "us" | "eu"
}

interface Attachment {
	name: string
	type: string
	data: string
}

interface Recipient {
	address: { email: string; name?: string; header_to?: string }
}

export interface SendParams {
	content: {
		from: { email: string; name?: string }
		subject: string
		html?: string
		text?: string
		reply_to?: string
		headers?: Record<string, string>
		attachments?: Array<Attachment>
	}
	recipients: Array<Recipient>
}

interface SendError {
	errors: Array<{ message: string; code?: string; description?: string }>
}

type SendResponse = {
	results: { id: string; total_accepted_recipients: number; total_rejected_recipients: number }
}

/**
 * SparkPost transmissions provider — https://developers.sparkpost.com/api/transmissions/
 *
 * @example
 * ```ts
 * import SparkPost from "postboi/sparkpost"
 *
 * const mail = new SparkPost({ api_key: SPARKPOST_API_KEY, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class SparkPost extends ProviderBase<SendResponse> {
	#api_key: string
	#host: string
	#defaults: { from?: string; to?: string }

	constructor({ api_key, region, default_from, default_to }: Options) {
		super()
		this.#api_key = api_key
		this.#host = region === "eu" ? "https://api.eu.sparkpost.com" : "https://api.sparkpost.com"
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const to = this.parse_addresses(options.to)
		const cc = options.cc ? this.parse_addresses(options.cc) : []
		const bcc = options.bcc ? this.parse_addresses(options.bcc) : []
		// SparkPost routes cc/bcc through recipients with header_to set to the primary To header.
		const header_to = to.map((a) => this.stringify_address(a)).join(", ")

		const recipients: Array<Recipient> = [
			...to.map((a) => ({ address: this.email_name(a) })),
			...cc.map((a) => ({ address: { email: a.address, header_to } })),
			...bcc.map((a) => ({ address: { email: a.address, header_to } })),
		]

		const params: SendParams = {
			content: {
				from: this.email_name(this.parse_email_address(options.from)),
				subject: options.subject || "Mail sent from website",
				html: typeof options.body === "string" ? options.body : undefined,
				text: options.text,
				reply_to: options.reply_to ? this.stringify_addresses(options.reply_to) : undefined,
				// Only cc is exposed via the CC header; bcc is omitted so it stays blind.
				headers: cc.length
					? { CC: cc.map((a) => this.stringify_address(a)).join(", ") }
					: undefined,
				attachments: options.attachments
					? (await this.parse_attachments(options.attachments)).map((a) => ({
							name: a.name,
							type: a.mime_type,
							data: a.content,
						}))
					: undefined,
			},
			recipients,
		}

		const response = await fetch(`${this.#host}/api/v1/transmissions`, {
			method: "POST",
			headers: {
				Authorization: this.#api_key,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		})

		const data = await this.read_json(response)
		if (!response.ok || this.is_error(data)) {
			throw this.is_error(data) ? data : new Error(`SparkPost request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a SparkPost error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return Array.isArray(e.errors)
	}
}
