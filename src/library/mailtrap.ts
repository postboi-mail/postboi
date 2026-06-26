import type { SendOptions, ApiKeyOptions } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Mailtrap provider constructor. */
type Options = ApiKeyOptions & {
	/** Use the sandbox (testing) host instead of live sending. Requires `inbox_id`. */
	sandbox?: boolean
	/** Sandbox inbox id — required when `sandbox` is true. */
	inbox_id?: string
}

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	filename: string
	type?: string
	disposition?: "attachment" | "inline"
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
	attachments?: Array<Attachment>
}

interface SendError {
	success: false
	errors: Array<string>
}

type SendResponse = { success: boolean; message_ids: Array<string> }

/**
 * Mailtrap sending provider — https://api-docs.mailtrap.io/
 *
 * @example
 * ```ts
 * import Mailtrap from "postboi/mailtrap"
 *
 * const mail = new Mailtrap({ api_key: MAILTRAP_TOKEN, default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 *
 * // sandbox / testing
 * const sandbox = new Mailtrap({ api_key: MAILTRAP_TOKEN, sandbox: true, inbox_id: "123456" })
 * ```
 */
export default class Mailtrap extends ProviderBase<SendResponse> {
	#api_key: string
	#url: string
	#defaults: { from?: string; to?: string }

	constructor({ api_key, sandbox, inbox_id, default_from, default_to }: Options) {
		super()
		this.#api_key = api_key
		if (sandbox) {
			if (!inbox_id) throw new Error("Mailtrap sandbox mode requires an inbox_id")
			this.#url = `https://sandbox.api.mailtrap.io/api/send/${inbox_id}`
		} else {
			this.#url = "https://send.api.mailtrap.io/api/send"
		}
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const params: SendParams = {
			from: this.email_name(this.parse_email_address(options.from)),
			to: this.email_name_list(options.to),
			cc: options.cc ? this.email_name_list(options.cc) : undefined,
			bcc: options.bcc ? this.email_name_list(options.bcc) : undefined,
			reply_to: options.reply_to ? this.email_name_list(options.reply_to)[0] : undefined,
			subject: options.subject || "Mail sent from website",
			html: typeof options.body === "string" ? options.body : undefined,
			text: options.text,
			attachments: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						content: a.content,
						filename: a.name,
						type: a.mime_type,
					}))
				: undefined,
		}

		const response = await fetch(this.#url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		})

		const data = await this.read_json(response)
		if (!response.ok || this.is_error(data)) {
			throw this.is_error(data) ? data : new Error(`Mailtrap request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a Mailtrap error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return e.success === false && Array.isArray(e.errors)
	}
}
