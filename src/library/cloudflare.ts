import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
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
	headers?: Record<string, string>
	attachments?: Array<Attachment>
}

interface CloudflareError {
	code: number
	message: string
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
 *   default: { from: "welcome@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Cloudflare extends ProviderBase<SendResponse> {
	protected readonly provider = "cloudflare"
	#api_key: string
	#url: string

	constructor({ api_key, account_id, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#url = `https://api.cloudflare.com/client/v4/accounts/${account_id}/email/sending/send`
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const params: SendParams = {
			from: this.email_name(this.parse_email_address(message.from)),
			to: this.email_name_list(message.to),
			cc: message.cc ? this.email_name_list(message.cc) : undefined,
			bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
			replyTo: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: message.headers,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						filename: a.name,
						type: a.mime_type,
						disposition: "attachment" as const,
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

	// Cloudflare wraps responses in { success, errors, ... } and may return success:false on 200.
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (e.success !== false || !Array.isArray(e.errors)) return undefined
		const first = e.errors[0] as { message?: string; code?: number } | undefined
		return { message: first?.message ?? "Cloudflare request failed", code: first?.code }
	}
}
