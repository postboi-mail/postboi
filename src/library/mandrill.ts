import type {
	PreparedMessage,
	ApiKeyOptions,
	ProviderError,
	RequestSpec,
	BatchRecipient,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"

/** Options for the Mandrill (Mailchimp Transactional) provider constructor. */
type Options = ApiKeyOptions

interface Recipient {
	email: string
	name?: string
	type: "to" | "cc" | "bcc"
}

interface Attachment {
	type: string
	name: string
	content: string
}

interface MergeVar {
	rcpt: string
	vars: Array<{ name: string; content: string }>
}

export interface SendParams {
	key: string
	message: {
		from_email: string
		from_name?: string
		subject: string
		html?: string
		text?: string
		to: Array<Recipient>
		headers?: Record<string, string>
		tags?: Array<string>
		attachments?: Array<Attachment>
		merge?: boolean
		merge_language?: "mailchimp" | "handlebars"
		merge_vars?: Array<MergeVar>
	}
}

type SendResult = {
	email: string
	status: "sent" | "queued" | "scheduled" | "rejected" | "invalid"
	reject_reason: string | null
	_id: string
}

type SendResponse = Array<SendResult>

/**
 * Mandrill / Mailchimp Transactional provider —
 * https://mailchimp.com/developer/transactional/api/messages/send-new-message/
 *
 * @example
 * ```ts
 * import Mandrill from "postboi/mandrill"
 *
 * const mail = new Mandrill({ api_key: MANDRILL_API_KEY, default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Mandrill extends ProviderBase<SendResponse> {
	protected readonly provider = "mandrill"
	#api_key: string

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const from = this.parse_email_address(message.from)
		const recipients: Array<Recipient> = [
			...this.parse_addresses(message.to).map((a) => ({
				...this.email_name(a),
				type: "to" as const,
			})),
			...(message.cc ? this.parse_addresses(message.cc) : []).map((a) => ({
				...this.email_name(a),
				type: "cc" as const,
			})),
			...(message.bcc ? this.parse_addresses(message.bcc) : []).map((a) => ({
				...this.email_name(a),
				type: "bcc" as const,
			})),
		]

		const headers = {
			...(message.reply_to ? { "Reply-To": this.stringify_addresses(message.reply_to) } : {}),
			...message.headers,
		}

		const params: SendParams = {
			key: this.#api_key,
			message: {
				from_email: from.address,
				from_name: from.name,
				subject: message.subject,
				html: message.html,
				text: message.text,
				to: recipients,
				headers: Object.keys(headers).length ? headers : undefined,
				tags: message.tags,
				attachments: message.attachments
					? (await this.parse_attachments(message.attachments)).map((a) => ({
							type: a.mime_type,
							name: a.name,
							content: a.content,
						}))
					: undefined,
			},
		}

		return this.#request(params)
	}

	#request(params: SendParams): RequestSpec {
		return {
			url: "https://mandrillapp.com/api/1.0/messages/send",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		}
	}

	/**
	 * Mandrill batches natively: one send to all recipients with per-recipient `merge_vars`
	 * and `*|KEY|*` merge tags. We rewrite `{key}` → `*|key|*` and attach each recipient's vars.
	 */
	protected async build_batch_request(
		template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): Promise<RequestSpec> {
		const sub = (s: string | undefined) =>
			s === undefined ? undefined : this.translate_placeholders(s, (k) => `*|${k}|*`)
		const from = this.parse_email_address(template.from)
		const to: Array<Recipient> = [
			...recipients.map((r) => ({
				...this.email_name(this.parse_addresses(r.to)[0]),
				type: "to" as const,
			})),
			...(template.cc ? this.parse_addresses(template.cc) : []).map((a) => ({
				...this.email_name(a),
				type: "cc" as const,
			})),
			...(template.bcc ? this.parse_addresses(template.bcc) : []).map((a) => ({
				...this.email_name(a),
				type: "bcc" as const,
			})),
		]
		const headers = {
			...(template.reply_to ? { "Reply-To": this.stringify_addresses(template.reply_to) } : {}),
			...template.headers,
		}
		const params: SendParams = {
			key: this.#api_key,
			message: {
				from_email: from.address,
				from_name: from.name,
				subject: sub(template.subject)!,
				html: sub(template.html),
				text: sub(template.text),
				to,
				headers: Object.keys(headers).length ? headers : undefined,
				tags: template.tags,
				merge: true,
				merge_language: "mailchimp",
				merge_vars: recipients.map((r) => ({
					rcpt: this.parse_addresses(r.to)[0].address,
					vars: Object.entries(r.data).map(([name, content]) => ({ name, content })),
				})),
			},
		}
		return this.#request(params)
	}

	// Mandrill returns one result object per recipient; a rejected/invalid status is a failure.
	protected parse_batch_response(
		_response: Response,
		data: unknown,
		recipients: Array<BatchRecipient>
	): Array<SendResponse | PostboiError> {
		const results = Array.isArray(data) ? (data as SendResponse) : []
		const by_email = new Map(results.map((r) => [r.email, r]))
		return recipients.map((r, i) => {
			const email = this.parse_addresses(r.to)[0].address
			const result = by_email.get(email) ?? results[i]
			if (!result) {
				return new PostboiError({ provider: this.provider, message: "Missing batch result" })
			}
			if (result.status === "rejected" || result.status === "invalid") {
				return new PostboiError({
					provider: this.provider,
					message: `Recipient ${result.email} ${result.status}${result.reject_reason ? `: ${result.reject_reason}` : ""}`,
					code: result.status,
					raw: result,
				})
			}
			return [result]
		})
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	// Success is an array; a call-level error is a single object with status: "error".
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined
		const e = data as Record<string, unknown>
		if (e.status === "error" && typeof e.message === "string") {
			return { message: e.message, code: typeof e.code === "number" ? e.code : undefined }
		}
		return undefined
	}
}
