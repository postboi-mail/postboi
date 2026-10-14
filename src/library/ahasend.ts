import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the AhaSend provider constructor. */
type Options = ApiKeyOptions & {
	/** The account the API key belongs to — the id in the dashboard URL. */
	account_id: string
}

interface Attachment {
	file_name: string
	content_type: string
	data: string
	base64: true
}

export interface SendParams {
	from: { email: string; name?: string }
	recipients: Array<{ email: string; name?: string }>
	subject: string
	html_content?: string
	text_content?: string
	reply_to?: { email: string; name?: string }
	headers?: Record<string, string>
	attachments?: Array<Attachment>
	tags?: Array<string>
	tracking?: { open?: boolean; click?: boolean }
	schedule?: { first_attempt: string }
}

type SendResponse = {
	object: string
	data: Array<{
		object: string
		/** The message id — null when the recipient was refused outright. */
		id: string | null
		recipient: { email: string; name?: string }
		status: string
		error?: string | null
	}>
}

/**
 * AhaSend provider — https://ahasend.com/docs/api-reference/messages/create-message
 *
 * The v2 API: Bearer auth against the account's `/messages`, addresses as
 * `{ email, name }`, both bodies, a single `reply_to`, custom `headers`, base64
 * attachments, `tags`, per-send open/click `tracking` and `scheduled_at` as the
 * schedule's first attempt. AhaSend has no cc/bcc — every address in `recipients` gets
 * its own copy — so `cc` and `bcc` are folded into the recipient list rather than
 * dropped. `idempotency_key` is forwarded as `Idempotency-Key`. The answer is one
 * result per recipient; a refusal of them all is an error, a partial one is left to
 * the caller to read.
 *
 * @example
 * ```ts
 * import AhaSend from "postboi/ahasend"
 *
 * const mail = new AhaSend({
 *   api_key: AHASEND_API_KEY,
 *   account_id: AHASEND_ACCOUNT_ID,
 *   default: { from: "no-reply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class AhaSend extends ProviderBase<SendResponse> {
	protected readonly provider = "ahasend"
	#api_key: string
	#account_id: string

	constructor({ api_key, account_id, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#account_id = account_id
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const recipients = [
			...this.parse_addresses(message.to),
			...(message.cc ? this.parse_addresses(message.cc) : []),
			...(message.bcc ? this.parse_addresses(message.bcc) : []),
		].map((a) => this.email_name(a))

		const params: SendParams = {
			from: this.email_name(this.parse_email_address(message.from)),
			recipients,
			subject: message.subject,
			html_content: message.html,
			text_content: message.text,
			reply_to: message.reply_to
				? this.email_name(this.parse_addresses(message.reply_to)[0])
				: undefined,
			headers: message.headers,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						file_name: a.name,
						content_type: a.mime_type,
						data: a.content,
						base64: true as const,
					}))
				: undefined,
			tags: message.tags,
			tracking: message.tracking
				? {
						...(message.tracking.opens !== undefined ? { open: message.tracking.opens } : {}),
						...(message.tracking.clicks !== undefined ? { click: message.tracking.clicks } : {}),
					}
				: undefined,
			schedule: message.scheduled_at
				? { first_attempt: message.scheduled_at.toISOString() }
				: undefined,
		}

		return {
			url: `https://api.ahasend.com/v2/accounts/${encodeURIComponent(this.#account_id)}/messages`,
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
		return data as SendResponse
	}

	// A request-level refusal is `{ message }`; a 202 whose every recipient errored is
	// as much of a failure.
	protected parse_error(response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (!response.ok && typeof e.message === "string") return { message: e.message }
		if (Array.isArray(e.data) && e.data.length) {
			const results = e.data as Array<Record<string, unknown>>
			if (results.every((r) => r.status === "error")) {
				const first = results.find((r) => typeof r.error === "string")
				return { message: (first?.error as string) ?? "ahasend refused every recipient" }
			}
		}
		return undefined
	}
}
