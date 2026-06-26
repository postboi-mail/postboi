import type { SendOptions, CommonProviderOptions } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Mailgun provider constructor. */
type Options = CommonProviderOptions & {
	/** Mailgun API key. */
	api_key: string
	/** Your verified Mailgun sending domain, e.g. "mg.example.com". */
	domain: string
	/** API region. Defaults to "us"; set "eu" for EU-provisioned domains. */
	region?: "us" | "eu"
}

interface SendError {
	message: string
}

type SendResponse = { id: string; message: string }

/**
 * Mailgun messages provider — https://documentation.mailgun.com/docs/mailgun/api-reference/
 *
 * Mailgun expects multipart/form-data (not JSON), so attachments are sent as real
 * file parts rather than base64.
 *
 * @example
 * ```ts
 * import Mailgun from "postboi/mailgun"
 *
 * const mail = new Mailgun({ api_key: MAILGUN_API_KEY, domain: "mg.example.com" })
 * await mail.send({ to: "contact@example.com", from: "no-reply@mg.example.com", body: "<p>Hi</p>" })
 * ```
 */
export default class Mailgun extends ProviderBase<SendResponse> {
	#api_key: string
	#domain: string
	#host: string
	#defaults: { from?: string; to?: string }

	constructor({ api_key, domain, region, default_from, default_to }: Options) {
		super()
		this.#api_key = api_key
		this.#domain = domain
		this.#host = region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net"
		this.#defaults = { from: default_from, to: default_to }
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		const form = new FormData()
		form.append("from", this.stringify_address(this.parse_email_address(options.from)))
		form.append("to", this.stringify_addresses(options.to))
		if (options.cc) form.append("cc", this.stringify_addresses(options.cc))
		if (options.bcc) form.append("bcc", this.stringify_addresses(options.bcc))
		if (options.reply_to) form.append("h:Reply-To", this.stringify_addresses(options.reply_to))
		form.append("subject", options.subject || "Mail sent from website")
		if (typeof options.body === "string") form.append("html", options.body)
		if (options.text) form.append("text", options.text)

		if (options.attachments) {
			const files = Array.isArray(options.attachments) ? options.attachments : [options.attachments]
			for (const file of files) form.append("attachment", file, file.name)
		}

		const auth = Buffer.from(`api:${this.#api_key}`).toString("base64")
		const response = await fetch(`${this.#host}/v3/${this.#domain}/messages`, {
			method: "POST",
			headers: { Authorization: `Basic ${auth}` },
			body: form,
		})

		const data = await this.read_json(response)
		if (!response.ok) {
			throw this.is_error(data) ? data : new Error(`Mailgun request failed (${response.status})`)
		}
		return data as SendResponse
	}

	/** Type guard for a Mailgun error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return typeof e.message === "string" && !("id" in e)
	}
}
