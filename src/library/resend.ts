import type {
	PreparedMessage,
	ApiKeyOptions,
	ProviderError,
	RequestSpec,
	BatchRecipient,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"

/** Options for the Resend provider constructor. */
type Options = ApiKeyOptions

interface Attachment {
	filename: string
	content: string
	content_type?: string
}

export interface SendParams {
	from: string
	to: Array<string>
	cc?: Array<string>
	bcc?: Array<string>
	reply_to?: Array<string>
	subject: string
	html?: string
	text?: string
	attachments?: Array<Attachment>
	headers?: Record<string, string>
	tags?: Array<{ name: string; value: string }>
	scheduled_at?: string
}

type SendResponse = { id: string }

/**
 * Resend provider — https://resend.com/docs/api-reference/emails/send-email
 *
 * @example
 * ```ts
 * import Resend from "postboi/resend"
 *
 * const mail = new Resend({ api_key: RESEND_API_KEY, default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Resend extends ProviderBase<SendResponse> {
	protected readonly provider = "resend"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	async #params(message: PreparedMessage): Promise<SendParams> {
		return {
			from: this.stringify_address(this.parse_email_address(message.from)),
			to: this.parse_addresses(message.to).map((a) => this.stringify_address(a)),
			cc: message.cc
				? this.parse_addresses(message.cc).map((a) => this.stringify_address(a))
				: undefined,
			bcc: message.bcc
				? this.parse_addresses(message.bcc).map((a) => this.stringify_address(a))
				: undefined,
			reply_to: message.reply_to
				? this.parse_addresses(message.reply_to).map((a) => this.stringify_address(a))
				: undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: message.headers,
			tags: message.tags?.map((t) => ({ name: t, value: t })),
			scheduled_at: message.scheduled_at?.toISOString(),
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						filename: a.name,
						content: a.content,
						content_type: a.mime_type,
					}))
				: undefined,
		}
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		return {
			url: "https://api.resend.com/emails",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
				...(message.idempotency_key ? { "Idempotency-Key": message.idempotency_key } : {}),
			},
			body: JSON.stringify(await this.#params(message)),
		}
	}

	// Resend's native batch endpoint: one POST carrying a fully-rendered message per recipient.
	protected async build_batch_request(
		_template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): Promise<RequestSpec> {
		const payload = await Promise.all(recipients.map((r) => this.#params(r.message)))
		return {
			url: "https://api.resend.com/emails/batch",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		}
	}

	// Batch returns `{ data: [{ id }, …] }`, aligned to the request order.
	protected parse_batch_response(
		_response: Response,
		data: unknown,
		recipients: Array<BatchRecipient>
	): Array<SendResponse | PostboiError> {
		const ids = (data as { data?: Array<SendResponse> } | null)?.data ?? []
		return recipients.map(
			(_, i) =>
				ids[i] ??
				new PostboiError({ provider: this.provider, message: "Missing batch result for recipient" })
		)
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.message === "string" && typeof e.name === "string") {
			return { message: e.message, code: e.name }
		}
		return undefined
	}
}
