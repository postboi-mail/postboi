import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Loops provider constructor. */
type Options = ApiKeyOptions & {
	/**
	 * The transactional email to send — its id from the Transactional page in Loops. Loops
	 * only sends emails designed there; the send's subject, HTML and text arrive as the
	 * `subject`, `html` and `text` data variables for that template to place.
	 */
	transactional_id: string
	/** File the recipient as a contact in the audience as well. Off by default. */
	add_to_audience?: boolean
}

interface Attachment {
	filename: string
	contentType: string
	data: string
}

export interface SendParams {
	transactionalId: string
	email: string
	addToAudience?: boolean
	dataVariables: Record<string, string | number>
	attachments?: Array<Attachment>
}

type SendResponse = {
	success: boolean
	transactionalId?: string
}

/**
 * Loops provider — https://loops.so/docs/api-reference/send-transactional-email
 *
 * Loops has no raw-content send: every email is a transactional template designed in
 * Loops, addressed to one recipient, with data variables filled in. So the provider takes
 * a `transactional_id` and hands the send over as variables — `subject`, `html`, `text`,
 * `from` and the recipient's `name` when there is one — for the template to place, and
 * a [batch](https://docs.postboi.app/bulk) with `data` fills `{placeholders}` before they
 * go. The template's own sender wins over `from`; `cc`, `bcc`, `headers`, `tags`,
 * `scheduled_at` and `tracking` have no equivalent and are dropped. Several recipients
 * is an error rather than a guess: pass an array of sends to reach several people.
 *
 * @example
 * ```ts
 * import Loops from "postboi/loops"
 *
 * const mail = new Loops({ api_key: LOOPS_API_KEY, transactional_id: "clx…" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Loops extends ProviderBase<SendResponse> {
	protected readonly provider = "loops"
	// The template names the sender; a send without `from` is fine.
	protected readonly requires_from = false
	#api_key: string
	#transactional_id: string
	#add_to_audience?: boolean

	constructor({ api_key, transactional_id, add_to_audience, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#transactional_id = transactional_id
		this.#add_to_audience = add_to_audience
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const to = this.single_recipient(message, "Loops sends one transactional email per recipient.")
		const variables = this.template_fields(message, to)

		const params: SendParams = {
			transactionalId: this.#transactional_id,
			email: to.address,
			addToAudience: this.#add_to_audience,
			dataVariables: variables,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						filename: a.name,
						contentType: a.mime_type,
						data: a.content,
					}))
				: undefined,
		}

		return {
			url: "https://app.loops.so/api/v1/transactional",
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

	// Rejections are `{ success: false, message, error: { path, message } }`.
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (e.success === true) return undefined
		const detail = e.error as Record<string, unknown> | undefined
		const message =
			typeof e.message === "string"
				? e.message
				: typeof detail?.message === "string"
					? detail.message
					: undefined
		if (!message && e.success !== false) return undefined
		return {
			message: message ?? "loops rejected the send",
			code: typeof detail?.path === "string" ? detail.path : undefined,
		}
	}
}
