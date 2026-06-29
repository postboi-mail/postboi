import type {
	PreparedMessage,
	ApiKeyOptions,
	ProviderError,
	RequestSpec,
	BatchRecipient,
} from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the SparkPost provider constructor. */
type Options = ApiKeyOptions & {
	/** API region. Defaults to "us"; set "eu" to use the EU host. */
	region?: "us" | "eu"
}

interface Attachment {
	name: string
	type: string
	data: string
}

interface Recipient {
	address: { email: string; name?: string; header_to?: string }
	substitution_data?: Record<string, string>
}

export interface SendParams {
	content: {
		from: { email: string; name?: string }
		subject: string
		html?: string
		text?: string
		reply_to?: string
		headers?: Record<string, string>
		attachments?: Array<Attachment>
	}
	recipients: Array<Recipient>
}

type SendResponse = {
	results: { id: string; total_accepted_recipients: number; total_rejected_recipients: number }
}

/**
 * SparkPost transmissions provider — https://developers.sparkpost.com/api/transmissions/
 *
 * @example
 * ```ts
 * import SparkPost from "postboi/sparkpost"
 *
 * const mail = new SparkPost({ api_key: SPARKPOST_API_KEY, default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class SparkPost extends ProviderBase<SendResponse> {
	protected readonly provider = "sparkpost"
	#api_key: string
	#host: string

	constructor({ api_key, region, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#host = region === "eu" ? "https://api.eu.sparkpost.com" : "https://api.sparkpost.com"
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const to = this.parse_addresses(message.to)
		const cc = message.cc ? this.parse_addresses(message.cc) : []
		const bcc = message.bcc ? this.parse_addresses(message.bcc) : []
		// SparkPost routes cc/bcc through recipients with header_to set to the primary To header.
		const header_to = to.map((a) => this.stringify_address(a)).join(", ")

		const recipients: Array<Recipient> = [
			...to.map((a) => ({ address: this.email_name(a) })),
			...cc.map((a) => ({ address: { email: a.address, header_to } })),
			...bcc.map((a) => ({ address: { email: a.address, header_to } })),
		]

		// Only cc is exposed via the CC header (bcc stays blind); merge any custom headers.
		const headers = {
			...(cc.length ? { CC: cc.map((a) => this.stringify_address(a)).join(", ") } : {}),
			...message.headers,
		}

		const params: SendParams = {
			content: {
				from: this.email_name(this.parse_email_address(message.from)),
				subject: message.subject,
				html: message.html,
				text: message.text,
				reply_to: message.reply_to ? this.stringify_addresses(message.reply_to) : undefined,
				headers: Object.keys(headers).length ? headers : undefined,
				attachments: message.attachments
					? (await this.parse_attachments(message.attachments)).map((a) => ({
							name: a.name,
							type: a.mime_type,
							data: a.content,
						}))
					: undefined,
			},
			recipients,
		}

		return this.#request(params)
	}

	#request(params: SendParams): RequestSpec {
		return {
			url: `${this.#host}/api/v1/transmissions`,
			headers: {
				Authorization: this.#api_key,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	/**
	 * SparkPost batches natively: one transmission with per-recipient `substitution_data` and
	 * `{{key}}` merge tags. We rewrite `{key}` → `{{key}}` and attach each recipient's vars.
	 */
	protected async build_batch_request(
		template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): Promise<RequestSpec> {
		const sub = (s: string | undefined) =>
			s === undefined ? undefined : this.translate_placeholders(s, (k) => `{{${k}}}`)
		const params: SendParams = {
			content: {
				from: this.email_name(this.parse_email_address(template.from)),
				subject: sub(template.subject)!,
				html: sub(template.html),
				text: sub(template.text),
				reply_to: template.reply_to ? this.stringify_addresses(template.reply_to) : undefined,
				headers: template.headers,
				attachments: template.attachments
					? (await this.parse_attachments(template.attachments)).map((a) => ({
							name: a.name,
							type: a.mime_type,
							data: a.content,
						}))
					: undefined,
			},
			recipients: recipients.map((r) => ({
				address: this.email_name(this.parse_addresses(r.to)[0]),
				substitution_data: r.data,
			})),
		}
		return this.#request(params)
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (!Array.isArray(e.errors)) return undefined
		const first = e.errors[0] as { message?: string; code?: string } | undefined
		return { message: first?.message ?? "SparkPost request failed", code: first?.code }
	}
}
