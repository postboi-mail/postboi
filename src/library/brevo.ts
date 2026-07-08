import type {
	PreparedMessage,
	ApiKeyOptions,
	ProviderError,
	RequestSpec,
	BatchRecipient,
	CancelResponse,
} from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Brevo provider constructor. */
type Options = ApiKeyOptions

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	name: string
}

export interface SendParams {
	sender: EmailName
	to: Array<EmailName>
	cc?: Array<EmailName>
	bcc?: Array<EmailName>
	replyTo?: EmailName
	subject: string
	htmlContent?: string
	textContent?: string
	headers?: Record<string, string>
	tags?: Array<string>
	attachment?: Array<Attachment>
	scheduledAt?: string
	messageVersions?: Array<{ to: Array<EmailName>; params?: Record<string, string> }>
}

type SendResponse = { messageId: string }

/**
 * Brevo (formerly Sendinblue) transactional email provider —
 * https://developers.brevo.com/reference/sendtransacemail
 *
 * @example
 * ```ts
 * import Brevo from "postboi/brevo"
 *
 * const mail = new Brevo({ api_key: BREVO_API_KEY, default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Brevo extends ProviderBase<SendResponse> {
	protected readonly provider = "brevo"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const params: SendParams = {
			sender: this.email_name(this.parse_email_address(message.from)),
			to: this.email_name_list(message.to),
			cc: message.cc ? this.email_name_list(message.cc) : undefined,
			bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
			replyTo: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			htmlContent: message.html,
			textContent: message.text,
			headers: message.headers,
			tags: message.tags,
			attachment: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						name: a.name,
					}))
				: undefined,
			scheduledAt: message.scheduled_at?.toISOString(),
		}

		return this.#request(params)
	}

	#request(params: SendParams): RequestSpec {
		return {
			url: "https://api.brevo.com/v3/smtp/email",
			headers: {
				"api-key": this.#api_key,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	/**
	 * Brevo batches natively via `messageVersions`: one request, a version per recipient with
	 * its own `to` and `params`. Body uses `{{params.key}}`, so we rewrite `{key}` accordingly.
	 */
	protected async build_batch_request(
		template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): Promise<RequestSpec> {
		const sub = (s: string | undefined) =>
			s === undefined ? undefined : this.translate_placeholders(s, (k) => `{{params.${k}}}`)
		const params: SendParams = {
			sender: this.email_name(this.parse_email_address(template.from)),
			// Brevo requires a top-level `to`; the per-version `to` overrides it.
			to: this.email_name_list(recipients[0].to),
			replyTo: template.reply_to ? this.email_name_list(template.reply_to)[0] : undefined,
			subject: sub(template.subject)!,
			htmlContent: sub(template.html),
			textContent: sub(template.text),
			headers: template.headers,
			tags: template.tags,
			scheduledAt: template.scheduled_at?.toISOString(),
			messageVersions: recipients.map((r) => ({
				to: this.email_name_list(r.to),
				params: r.data,
			})),
		}
		return this.#request(params)
	}

	/**
	 * Cancel a scheduled email by its messageId (or a scheduling batchId) —
	 * https://developers.brevo.com/reference/deletescheduledemailbyid
	 */
	async cancel(id: string): Promise<CancelResponse> {
		const response = await this.request({
			url: `https://api.brevo.com/v3/smtp/email/${encodeURIComponent(id)}`,
			method: "DELETE",
			headers: { "api-key": this.#api_key, Accept: "application/json" },
			body: "",
		})
		const data = await this.read_json(response)
		const error = this.error_for(response, data, "cancel")
		if (error) throw error
		return { id }
	}

	// messageVersions returns `{ messageIds: [...] }`, aligned to the versions order.
	protected parse_batch_response(
		_response: Response,
		data: unknown,
		recipients: Array<BatchRecipient>
	): Array<SendResponse> {
		const ids = (data as { messageIds?: Array<string> } | null)?.messageIds ?? []
		return recipients.map((_, i) => ({ messageId: ids[i] ?? "" }))
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.code === "string" && typeof e.message === "string") {
			return { message: e.message, code: e.code }
		}
		return undefined
	}
}
