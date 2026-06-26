import type { SendOptions, CommonProviderOptions } from "./index.js"
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

interface SendError {
	error: {
		code: string
		details: Array<{
			code: string
			message: string
			inner_error?: { code: string; message: string }
			target?: string
		}>
		message: string
		request_id?: string
	}
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
 * const mail = new Postboi({ token: ZEPTO_TOKEN, default_from: 'no-reply@example.com' })
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
	#token: string
	#defaults: { from?: string; to?: string }

	/**
	 * Create a ZeptoMail client.
	 * @param token ZeptoMail API token
	 * @param default_from Optional default sender address used when `from` is omitted
	 * @param default_to Optional default recipient address used when `to` is omitted
	 */
	constructor({ token, default_from, default_to }: Options) {
		super()
		this.#token = token
		this.#defaults = { from: default_from, to: default_to }
	}

	/**
	 * Send an email via ZeptoMail.
	 * - Supports string or FormData body.
	 * - Handles grouped fields using `fieldset→field` in FormData keys.
	 */
	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const zepto_params: SendParams = {
			to: this.parse_addresses(options.to).map((a) => ({ email_address: a })),
			from: this.parse_email_address(options.from),
			reply_to: options.reply_to ? this.parse_addresses(options.reply_to) : undefined,
			bcc: options.bcc
				? this.parse_addresses(options.bcc).map((a) => ({ email_address: a }))
				: undefined,
			cc: options.cc
				? this.parse_addresses(options.cc).map((a) => ({ email_address: a }))
				: undefined,
			subject: options.subject || "Mail sent from website",
			htmlbody: typeof options.body === "string" ? options.body : "",
			textbody: options.text,
			attachments: options.attachments
				? await this.parse_attachments(options.attachments)
				: undefined,
		}

		const response = await fetch("https://api.zeptomail.com/v1.1/email", {
			method: "POST",
			headers: {
				Authorization: this.#token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(zepto_params),
		})

		const data = await response.json()

		// throw if response contains an error (matching Zeptomail SDK behavior)
		if (this.is_error(data)) throw data
		else return data
	}

	/**
	 * Type guard to check if an error is a ZeptoMail error.
	 * @example
	 * try { await mail.send({ to: 'a@b.com', body: 'hi' }) } catch (e) {
	 *   if (mail.is_error(e)) console.error(e.error.message)
	 * }
	 */
	is_error(error: unknown): error is SendError {
		type Inner = { code: string; message: string; request_id?: string; details: unknown[] }

		const has_shape = (e: unknown): e is { error: Inner } => {
			if (e === null || typeof e !== "object") return false
			const outer = e as Record<string, unknown>
			if (!("error" in outer)) return false
			const inner = outer.error
			if (inner === null || typeof inner !== "object") return false
			const i = inner as Record<string, unknown>

			return (
				typeof i.code === "string" &&
				typeof i.message === "string" &&
				(i.request_id === undefined || typeof i.request_id === "string") &&
				Array.isArray(i.details)
			)
		}

		return has_shape(error)
	}
}
