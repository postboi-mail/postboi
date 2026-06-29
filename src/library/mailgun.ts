import type {
	PreparedMessage,
	CommonProviderOptions,
	ProviderError,
	RequestSpec,
	BatchRecipient,
	RecipientVars,
} from "./index.js"
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
		if (message.headers) {
			for (const [name, value] of Object.entries(message.headers)) form.append(`h:${name}`, value)
		}
		if (message.tags) {
			for (const tag of message.tags) form.append("o:tag", tag)
		}
		if (message.scheduled_at) form.append("o:deliverytime", message.scheduled_at.toUTCString())

		if (message.attachments) {
			const files = Array.isArray(message.attachments) ? message.attachments : [message.attachments]
			for (const file of files) form.append("attachment", file, file.name)
		}

		return this.#request(form)
	}

	#request(form: FormData): RequestSpec {
		const auth = Buffer.from(`api:${this.#api_key}`).toString("base64")
		return {
			url: `${this.#host}/v3/${this.#domain}/messages`,
			headers: { Authorization: `Basic ${auth}` },
			body: form,
		}
	}

	/**
	 * Mailgun batches natively via `recipient-variables`: one request to all recipients with
	 * `%recipient.key%` merge tags. We rewrite `{key}` → `%recipient.key%` and pass each
	 * recipient's variables keyed by address.
	 */
	protected build_batch_request(
		template: PreparedMessage,
		recipients: Array<BatchRecipient>
	): RequestSpec {
		const sub = (s: string) => this.translate_placeholders(s, (k) => `%recipient.${k}%`)
		const form = new FormData()
		form.append("from", this.stringify_address(this.parse_email_address(template.from)))
		for (const r of recipients) form.append("to", this.stringify_addresses(r.to))
		if (template.cc) form.append("cc", this.stringify_addresses(template.cc))
		if (template.bcc) form.append("bcc", this.stringify_addresses(template.bcc))
		if (template.reply_to) form.append("h:Reply-To", this.stringify_addresses(template.reply_to))
		form.append("subject", sub(template.subject))
		if (template.html) form.append("html", sub(template.html))
		if (template.text) form.append("text", sub(template.text))
		if (template.headers) {
			for (const [name, value] of Object.entries(template.headers)) form.append(`h:${name}`, value)
		}
		if (template.tags) for (const tag of template.tags) form.append("o:tag", tag)
		if (template.scheduled_at) form.append("o:deliverytime", template.scheduled_at.toUTCString())

		const vars: Record<string, RecipientVars> = {}
		for (const r of recipients) vars[this.parse_addresses(r.to)[0].address] = r.data
		form.append("recipient-variables", JSON.stringify(vars))
		return this.#request(form)
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
