import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
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
	protected readonly provider = "mailtrap"
	#api_key: string
	#url: string

	constructor({ api_key, sandbox, inbox_id, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		if (sandbox) {
			if (!inbox_id) throw new Error("Mailtrap sandbox mode requires an inbox_id")
			this.#url = `https://sandbox.api.mailtrap.io/api/send/${inbox_id}`
		} else {
			this.#url = "https://send.api.mailtrap.io/api/send"
		}
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const params: SendParams = {
			from: this.email_name(this.parse_email_address(message.from)),
			to: this.email_name_list(message.to),
			cc: message.cc ? this.email_name_list(message.cc) : undefined,
			bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
			reply_to: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						filename: a.name,
						type: a.mime_type,
					}))
				: undefined,
		}

		return {
			url: this.#url,
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
		if (e.success === false && Array.isArray(e.errors)) {
			return { message: e.errors.join(", ") || "Mailtrap request failed" }
		}
		return undefined
	}
}
