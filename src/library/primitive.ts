import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Primitive provider constructor. */
type Options = ApiKeyOptions

interface Attachment {
	filename: string
	content_base64: string
	content_type: string
}

export interface SendParams {
	from: string
	to: string
	subject: string
	body_text?: string
	body_html?: string
	attachments?: Array<Attachment>
}

type SendResponse = {
	success?: boolean
	data?: {
		id?: string
		status?: string
		accepted?: Array<string>
		rejected?: Array<string>
		queue_id?: string | null
		request_id?: string
	}
}

/**
 * Primitive provider — https://primitive.dev/docs
 *
 * A JSON send against `/send-mail` with Bearer auth: `Name <email>` strings for the
 * sender and the one recipient, both bodies and base64 attachments. Primitive addresses
 * exactly one person per send and has no cc or bcc, so several recipients is an error
 * rather than a guess — pass an array of sends to reach several people. `idempotency_key`
 * is forwarded as `Idempotency-Key`; `reply_to`, `headers`, `tags`, `scheduled_at` and
 * `tracking` have no equivalent and are dropped.
 *
 * @example
 * ```ts
 * import Primitive from "postboi/primitive"
 *
 * const mail = new Primitive({ api_key: PRIMITIVE_API_KEY, default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Primitive extends ProviderBase<SendResponse> {
	protected readonly provider = "primitive"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const to = this.single_recipient(
			message,
			"Primitive sends to one recipient per request, with no cc or bcc.",
			[message.cc, message.bcc]
		)

		const params: SendParams = {
			from: this.stringify_address(this.parse_email_address(message.from)),
			to: this.stringify_address(to),
			subject: message.subject,
			body_text: message.text,
			body_html: message.html,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						filename: a.name,
						content_base64: a.content,
						content_type: a.mime_type,
					}))
				: undefined,
		}

		return {
			url: "https://api.primitive.dev/v1/send-mail",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
				...(message.idempotency_key ? { "Idempotency-Key": message.idempotency_key } : {}),
			},
			body: JSON.stringify(params),
			idempotent: Boolean(message.idempotency_key),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return (data ?? {}) as SendResponse
	}

	// Refusals are `{ error: { code, message } }`.
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		const error = e.error as Record<string, unknown> | undefined
		if (error && typeof error.message === "string") {
			return {
				message: error.message,
				code: typeof error.code === "string" ? error.code : undefined,
			}
		}
		if (e.success === false) return { message: "primitive rejected the send" }
		return undefined
	}
}
