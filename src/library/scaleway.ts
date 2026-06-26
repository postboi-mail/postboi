import type { SendOptions, CommonProviderOptions } from "./index.js"
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

interface SendError {
	message: string
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
 *   default_from: "no-reply@example.com",
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Scaleway extends ProviderBase<SendResponse> {
	#secret_key: string
	#project_id: string
	#url: string
	#defaults: { from?: string; to?: string }

	constructor({ secret_key, project_id, region, default_from, default_to }: Options) {
		super()
		this.#secret_key = secret_key
		this.#project_id = project_id
		this.#url = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${region}/emails`
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const params: SendParams = {
			from: this.email_name(this.parse_email_address(options.from)),
			to: this.email_name_list(options.to),
			cc: options.cc ? this.email_name_list(options.cc) : undefined,
			bcc: options.bcc ? this.email_name_list(options.bcc) : undefined,
			subject: options.subject || "Mail sent from website",
			html: typeof options.body === "string" ? options.body : undefined,
			text: options.text,
			project_id: this.#project_id,
			// Scaleway has no dedicated reply_to field — express it as an additional header.
			additional_headers: options.reply_to
				? [{ key: "Reply-To", value: this.stringify_addresses(options.reply_to) }]
				: undefined,
			attachments: options.attachments
				? (await this.parse_attachments(options.attachments)).map((a) => ({
						name: a.name,
						type: a.mime_type,
						content: a.content,
					}))
				: undefined,
		}

		const response = await fetch(this.#url, {
			method: "POST",
			headers: {
				"X-Auth-Token": this.#secret_key,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		})

		const data = await this.read_json(response)
		if (!response.ok) {
			throw this.is_error(data) ? data : new Error(`Scaleway request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a Scaleway error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return typeof e.message === "string" && !("emails" in e)
	}
}
