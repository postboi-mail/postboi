import type { PreparedMessage, CommonProviderOptions, ProviderError, RequestSpec } from "./index.js"
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
	protected readonly provider = "mailgun"
	#api_key: string
	#domain: string
	#host: string

	constructor({ api_key, domain, region, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#domain = domain
		this.#host = region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net"
	}

	protected build_request(message: PreparedMessage): RequestSpec {
		const form = new FormData()
		form.append("from", this.stringify_address(this.parse_email_address(message.from)))
		form.append("to", this.stringify_addresses(message.to))
		if (message.cc) form.append("cc", this.stringify_addresses(message.cc))
		if (message.bcc) form.append("bcc", this.stringify_addresses(message.bcc))
		if (message.reply_to) form.append("h:Reply-To", this.stringify_addresses(message.reply_to))
		form.append("subject", message.subject)
		if (message.html) form.append("html", message.html)
		if (message.text) form.append("text", message.text)

		if (message.attachments) {
			const files = Array.isArray(message.attachments) ? message.attachments : [message.attachments]
			for (const file of files) form.append("attachment", file, file.name)
		}

		const auth = Buffer.from(`api:${this.#api_key}`).toString("base64")
		return {
			url: `${this.#host}/v3/${this.#domain}/messages`,
			headers: { Authorization: `Basic ${auth}` },
			body: form,
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.message === "string" && !("id" in e)) return { message: e.message }
		return undefined
	}
}
