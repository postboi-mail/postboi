import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the JetEmail provider constructor. */
type Options = ApiKeyOptions

interface Attachment {
	filename: string
	data: string
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
	headers?: Record<string, string>
	attachments?: Array<Attachment>
}

type SendResponse = {
	id?: string
	response?: string
	scheduled_at?: number
}

/**
 * JetEmail provider — https://docs.jetemail.com
 *
 * A straight JSON send against `/email` with Bearer auth. Addresses go as
 * `Name <email>` strings — JetEmail insists the sender carries a display name, so a bare
 * `from` gets its local part as one — with every reply-to address, both bodies, custom
 * `headers` and base64 attachments. `idempotency_key` is forwarded as `Idempotency-Key`;
 * `tags`, `scheduled_at` and `tracking` have no equivalent and are dropped.
 *
 * @example
 * ```ts
 * import JetEmail from "postboi/jetemail"
 *
 * const mail = new JetEmail({ api_key: JETEMAIL_API_KEY, default: { from: "Acme <no-reply@example.com>" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class JetEmail extends ProviderBase<SendResponse> {
	protected readonly provider = "jetemail"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const from = this.parse_email_address(message.from)
		if (!from.name) from.name = from.address.split("@")[0]

		const params: SendParams = {
			from: this.stringify_address(from),
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
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						filename: a.name,
						data: a.content,
					}))
				: undefined,
		}

		return {
			url: "https://api.jetemail.com/email",
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

	protected parse_error(response: Response, data: unknown): ProviderError | undefined {
		if (response.ok || data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		const message = typeof e.error === "string" ? e.error : e.message
		return typeof message === "string" ? { message } : undefined
	}
}
