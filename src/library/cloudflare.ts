import type { SendOptions, ApiKeyOptions } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Cloudflare Email Service provider constructor. */
type Options = ApiKeyOptions & {
	/** Your Cloudflare account id. */
	account_id: string
}

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	filename: string
	type: string
	disposition: "attachment"
}

export interface SendParams {
	from: EmailName
	to: Array<EmailName>
	cc?: Array<EmailName>
	bcc?: Array<EmailName>
	replyTo?: EmailName
	subject: string
	html?: string
	text?: string
	attachments?: Array<Attachment>
}

interface CloudflareError {
	code: number
	message: string
}

interface SendError {
	success: false
	errors: Array<CloudflareError>
	messages: Array<unknown>
	result: null
}

type SendResponse = {
	success: boolean
	errors: Array<CloudflareError>
	messages: Array<unknown>
	result: { delivered: Array<string>; permanent_bounces: Array<string>; queued: Array<string> }
}

/**
 * Cloudflare Email Service provider —
 * https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 *
 * Uses the REST send endpoint — just an account id and an API token, over fetch.
 * The sender domain must be onboarded for Email Sending on that account.
 *
 * @example
 * ```ts
 * import Cloudflare from "postboi/cloudflare"
 *
 * const mail = new Cloudflare({
 *   account_id: CF_ACCOUNT_ID,
 *   api_key: CF_API_TOKEN,
 *   default_from: "welcome@example.com",
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Cloudflare extends ProviderBase<SendResponse> {
	#api_key: string
	#url: string
	#defaults: { from?: string; to?: string }

	constructor({ api_key, account_id, default_from, default_to }: Options) {
		super()
		this.#api_key = api_key
		this.#url = `https://api.cloudflare.com/client/v4/accounts/${account_id}/email/sending/send`
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const params: SendParams = {
			from: this.email_name(this.parse_email_address(options.from)),
			to: this.email_name_list(options.to),
			cc: options.cc ? this.email_name_list(options.cc) : undefined,
			bcc: options.bcc ? this.email_name_list(options.bcc) : undefined,
			replyTo: options.reply_to ? this.email_name_list(options.reply_to)[0] : undefined,
			subject: options.subject || "Mail sent from website",
			html: typeof options.body === "string" ? options.body : undefined,
			text: options.text,
			attachments: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						content: a.content,
						filename: a.name,
						type: a.mime_type,
						disposition: "attachment" as const,
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
			throw this.is_error(data) ? data : new Error(`Cloudflare request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a Cloudflare error response (`success: false`). */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return e.success === false && Array.isArray(e.errors)
	}
}
