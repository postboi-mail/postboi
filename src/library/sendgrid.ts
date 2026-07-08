import type {
	PreparedMessage,
	ApiKeyOptions,
	ProviderError,
	RequestSpec,
	BatchRecipient,
	Tracking,
} from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the SendGrid provider constructor. */
type Options = ApiKeyOptions & {
	/** API region. Defaults to "us"; set "eu" to use the EU data residency host. */
	region?: "us" | "eu"
}

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	type: string
	filename: string
	disposition: "attachment"
}

export interface SendParams {
	personalizations: Array<{
		to: Array<EmailName>
		cc?: Array<EmailName>
		bcc?: Array<EmailName>
		substitutions?: Record<string, string>
	}>
	from: EmailName
	reply_to?: EmailName
	subject: string
	content: Array<{ type: string; value: string }>
	headers?: Record<string, string>
	categories?: Array<string>
	attachments?: Array<Attachment>
	send_at?: number
	tracking_settings?: {
		open_tracking?: { enable: boolean }
		click_tracking?: { enable: boolean; enable_text: boolean }
	}
}

type SendResponse = { message_id?: string }

/**
 * SendGrid v3 Mail Send provider — https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
 *
 * @example
 * ```ts
 * import SendGrid from "postboi/sendgrid"
 *
 * const mail = new SendGrid({ api_key: SENDGRID_API_KEY, default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class SendGrid extends ProviderBase<SendResponse> {
	protected readonly provider = "sendgrid"
	#api_key: string
	#host: string

	constructor({ api_key, region, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#host = region === "eu" ? "https://api.eu.sendgrid.com" : "https://api.sendgrid.com"
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const content: SendParams["content"] = []
		if (message.text) content.push({ type: "text/plain", value: message.text })
		if (message.html) content.push({ type: "text/html", value: message.html })

		const params: SendParams = {
			personalizations: [
				{
					to: this.email_name_list(message.to),
					cc: message.cc ? this.email_name_list(message.cc) : undefined,
					bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
				},
			],
			from: this.email_name(this.parse_email_address(message.from)),
			reply_to: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			content,
			headers: message.headers,
			categories: message.tags,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						type: a.mime_type,
						filename: a.name,
						disposition: "attachment" as const,
					}))
				: undefined,
			send_at: message.scheduled_at ? Math.floor(message.scheduled_at.getTime() / 1000) : undefined,
			tracking_settings: this.#tracking(message.tracking),
		}

		return this.#request(params)
	}

	// Only the flags the user set are emitted, so SendGrid's own defaults cover the rest.
	#tracking(tracking?: Tracking): SendParams["tracking_settings"] {
		if (tracking?.opens === undefined && tracking?.clicks === undefined) return undefined
		return {
			open_tracking: tracking.opens === undefined ? undefined : { enable: tracking.opens },
			click_tracking:
				tracking.clicks === undefined
					? undefined
					: { enable: tracking.clicks, enable_text: tracking.clicks },
		}
	}

	#request(params: SendParams): RequestSpec {
		return {
			url: `${this.#host}/v3/mail/send`,
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	/**
	 * SendGrid batches natively via one `personalizations` entry per recipient. Its
	 * `substitutions` do a literal string replace, so we keep the `{key}` tags as-is and map
	 * each recipient's variables to `{ "{key}": value }`.
	 */
	protected async build_batch_request(
		template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): Promise<RequestSpec> {
		const content: SendParams["content"] = []
		if (template.text) content.push({ type: "text/plain", value: template.text })
		if (template.html) content.push({ type: "text/html", value: template.html })

		const params: SendParams = {
			personalizations: recipients.map((r) => ({
				to: this.email_name_list(r.to),
				substitutions: Object.fromEntries(Object.entries(r.data).map(([k, v]) => [`{${k}}`, v])),
			})),
			from: this.email_name(this.parse_email_address(template.from)),
			reply_to: template.reply_to ? this.email_name_list(template.reply_to)[0] : undefined,
			subject: template.subject,
			content,
			headers: template.headers,
			categories: template.tags,
			send_at: template.scheduled_at
				? Math.floor(template.scheduled_at.getTime() / 1000)
				: undefined,
			tracking_settings: this.#tracking(template.tracking),
		}
		return this.#request(params)
	}

	// 202 Accepted with an empty body; the id is returned in a response header.
	protected parse_response(response: Response, _data: unknown): SendResponse {
		return { message_id: response.headers.get("x-message-id") ?? undefined }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (!Array.isArray(e.errors)) return undefined
		const first = e.errors[0] as { message?: string } | undefined
		return { message: first?.message ?? "SendGrid request failed" }
	}
}
