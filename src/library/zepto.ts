import type { PreparedMessage, CommonProviderOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the ZeptoMail provider constructor. */
type Options = CommonProviderOptions & { token: string }

interface EmailAddress {
	address: string
	name?: string
}

type Attachment =
	| {
			name: string
			content: string
			mime_type: string
	  }
	| { file_cache_key: string }

export interface SendParams {
	from: EmailAddress
	to: Array<{ email_address: EmailAddress }>
	reply_to?: Array<EmailAddress>
	bcc?: Array<{ email_address: EmailAddress }>
	cc?: Array<{ email_address: EmailAddress }>
	attachments?: Array<Attachment>
	subject: string
	htmlbody: string
	textbody?: string
}

type SendResponse = {
	data: Array<{
		code: string
		additional_info: unknown[]
		message: string
	}>
	message: string
	request_id: string
	object: "email"
}

/**
 * ZeptoMail provider.
 *
 * Example:
 * ```ts
 * import Postboi from 'postboi/zepto'
 *
 * const mail = new Postboi({ token: ZEPTO_TOKEN, default: { from: 'no-reply@example.com' } })
 * await mail.send({
 *   to: 'contact@example.com',
 *   subject: 'Hello',
 *   body: 'Hello world'
 * })
 *
 * // With FormData (special fields are extracted; body is rendered as an HTML table)
 * await mail.send({ body: await request.formData() })
 * ```
 */
export default class Postboi extends ProviderBase<SendResponse> {
	protected readonly provider = "zeptomail"
	#token: string

	/**
	 * Create a ZeptoMail client.
	 * @param token ZeptoMail API token
	 * @param default Optional default field values (from/to/cc/bcc/reply_to) applied when omitted
	 */
	constructor({ token, ...options }: Options) {
		super(options)
		this.#token = token
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const address = (a: { address: string; name?: string }): EmailAddress =>
			a.name ? { address: a.address, name: a.name } : { address: a.address }

		const params: SendParams = {
			to: this.parse_addresses(message.to).map((a) => ({ email_address: address(a) })),
			from: address(this.parse_email_address(message.from)),
			reply_to: message.reply_to ? this.parse_addresses(message.reply_to).map(address) : undefined,
			bcc: message.bcc
				? this.parse_addresses(message.bcc).map((a) => ({ email_address: address(a) }))
				: undefined,
			cc: message.cc
				? this.parse_addresses(message.cc).map((a) => ({ email_address: address(a) }))
				: undefined,
			subject: message.subject,
			htmlbody: message.html ?? "",
			textbody: message.text,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						name: a.name,
						content: a.content,
						mime_type: a.mime_type,
					}))
				: undefined,
		}

		return {
			url: "https://api.zeptomail.com/v1.1/email",
			headers: {
				Authorization: this.#token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object" || !("error" in data)) return undefined
		const inner = (data as { error: unknown }).error
		if (inner === null || typeof inner !== "object") return undefined
		const e = inner as Record<string, unknown>
		if (typeof e.message !== "string" || !Array.isArray(e.details)) return undefined
		return { message: e.message, code: typeof e.code === "string" ? e.code : undefined }
	}
}
