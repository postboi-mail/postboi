import type {
	PreparedMessage,
	ApiKeyOptions,
	ProviderError,
	RequestSpec,
	BatchRecipient,
} from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Elastic Email provider constructor. */
type Options = ApiKeyOptions

interface BodyPart {
	ContentType: "HTML" | "PlainText"
	Content: string
	Charset: "utf-8"
}

interface Attachment {
	BinaryContent: string
	Name: string
	ContentType: string
}

interface Content {
	From: string
	ReplyTo?: string
	Subject: string
	Body: Array<BodyPart>
	Headers?: Record<string, string>
	Attachments?: Array<Attachment>
}

/** Body for the single-send transactional endpoint (recipients split into To/CC/BCC). */
interface TransactionalParams {
	Recipients: { To: Array<string>; CC?: Array<string>; BCC?: Array<string> }
	Content: Content
}

/** Body for the bulk endpoint: a flat recipient list, each with its own merge `Fields`. */
interface BulkParams {
	Recipients: Array<{ Email: string; Fields?: Record<string, string> }>
	Content: Content
}

type SendResponse = { message_id: string; transaction_id: string }

/**
 * Elastic Email (REST API v4) provider — https://elasticemail.com/developers/api-documentation/rest-api
 *
 * @example
 * ```ts
 * import ElasticEmail from "postboi/elasticemail"
 *
 * const mail = new ElasticEmail({ api_key: ELASTICEMAIL_API_KEY, default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class ElasticEmail extends ProviderBase<SendResponse> {
	protected readonly provider = "elasticemail"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	#body(html?: string, text?: string): Array<BodyPart> {
		const parts: Array<BodyPart> = []
		if (html !== undefined) parts.push({ ContentType: "HTML", Content: html, Charset: "utf-8" })
		if (text !== undefined) parts.push({ ContentType: "PlainText", Content: text, Charset: "utf-8" })
		return parts
	}

	async #content(message: PreparedMessage): Promise<Content> {
		return {
			From: this.stringify_address(this.parse_email_address(message.from)),
			ReplyTo: message.reply_to ? this.stringify_addresses(message.reply_to) : undefined,
			Subject: message.subject,
			Body: this.#body(message.html, message.text),
			Headers: message.headers,
			Attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						BinaryContent: a.content,
						Name: a.name,
						ContentType: a.mime_type,
					}))
				: undefined,
		}
	}

	#request(path: string, params: TransactionalParams | BulkParams): RequestSpec {
		return {
			url: `https://api.elasticemail.com/v4/${path}`,
			headers: { "X-ElasticEmail-ApiKey": this.#api_key, "Content-Type": "application/json" },
			body: JSON.stringify(params),
		}
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const list = (v: typeof message.cc) =>
			v ? this.parse_addresses(v).map((a) => this.stringify_address(a)) : undefined
		return this.#request("emails/transactional", {
			Recipients: { To: list(message.to)!, CC: list(message.cc), BCC: list(message.bcc) },
			Content: await this.#content(message),
		})
	}

	/**
	 * Elastic Email merges natively with `{field}` placeholders — the same syntax Postboi uses —
	 * so the template's `{key}`s pass through untouched and each recipient supplies its `Fields`.
	 */
	protected async build_batch_request(
		template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): Promise<RequestSpec> {
		return this.#request("emails", {
			Recipients: recipients.map((r) => ({
				Email: this.parse_addresses(r.to)[0].address,
				Fields: r.data,
			})),
			Content: await this.#content(template),
		})
	}

	// The bulk endpoint returns a single MessageID/TransactionID for the whole send.
	protected parse_batch_response(
		_response: Response,
		data: unknown,
		recipients: Array<BatchRecipient>
	): Array<SendResponse> {
		const result = this.parse_response(_response, data)
		return recipients.map(() => result)
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const e = (data ?? {}) as { MessageID?: string; TransactionID?: string }
		return { message_id: e.MessageID ?? "", transaction_id: e.TransactionID ?? "" }
	}

	// v4 errors come back as `{ "Error": "message" }` (or a bare string on some failures).
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (typeof data === "string" && data) return { message: data }
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.Error === "string") return { message: e.Error }
		return undefined
	}
}
