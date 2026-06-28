import type { PreparedMessage, CommonProviderOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Scaleway Transactional Email provider constructor. */
type Options = CommonProviderOptions & {
	/** Scaleway secret key, sent as the X-Auth-Token header. */
	secret_key: string
	/** Scaleway Project ID (UUID). */
	project_id: string
	/** Region, e.g. "fr-par", "nl-ams", "pl-waw". */
	region: string
}

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	name: string
	type: string
	content: string
}

export interface SendParams {
	from: EmailName
	to: Array<EmailName>
	cc?: Array<EmailName>
	bcc?: Array<EmailName>
	subject: string
	text?: string
	html?: string
	project_id: string
	attachments?: Array<Attachment>
	additional_headers?: Array<{ key: string; value: string }>
}

type SendResponse = { emails: Array<{ id: string }> }

/**
 * Scaleway Transactional Email provider —
 * https://www.scaleway.com/en/developers/api/transactional-email/
 *
 * @example
 * ```ts
 * import Scaleway from "postboi/scaleway"
 *
 * const mail = new Scaleway({
 *   secret_key: SCW_SECRET_KEY,
 *   project_id: SCW_PROJECT_ID,
 *   region: "fr-par",
 *   default: { from: "no-reply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Scaleway extends ProviderBase<SendResponse> {
	protected readonly provider = "scaleway"
	#secret_key: string
	#project_id: string
	#url: string

	constructor({ secret_key, project_id, region, ...options }: Options) {
		super(options)
		this.#secret_key = secret_key
		this.#project_id = project_id
		this.#url = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${region}/emails`
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		// Scaleway has no dedicated reply_to field — express reply-to and any custom
		// headers as additional_headers.
		const additional_headers = [
			...(message.reply_to
				? [{ key: "Reply-To", value: this.stringify_addresses(message.reply_to) }]
				: []),
			...Object.entries(message.headers ?? {}).map(([key, value]) => ({ key, value })),
		]

		const params: SendParams = {
			from: this.email_name(this.parse_email_address(message.from)),
			to: this.email_name_list(message.to),
			cc: message.cc ? this.email_name_list(message.cc) : undefined,
			bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			project_id: this.#project_id,
			additional_headers: additional_headers.length ? additional_headers : undefined,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						name: a.name,
						type: a.mime_type,
						content: a.content,
					}))
				: undefined,
		}

		return {
			url: this.#url,
			headers: {
				"X-Auth-Token": this.#secret_key,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.message === "string" && !("emails" in e)) {
			return { message: e.message, code: typeof e.type === "string" ? e.type : undefined }
		}
		return undefined
	}
}
