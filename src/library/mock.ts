import type { SendOptions, CommonProviderOptions, MailAddress, MailAttachment } from "./index.js"
import { ProviderBase } from "./index.js"

/** A normalized snapshot of an email captured by the mock provider. */
export interface SentMessage {
	to: Array<MailAddress>
	from: MailAddress
	cc?: Array<MailAddress>
	bcc?: Array<MailAddress>
	reply_to?: Array<MailAddress>
	subject: string
	html?: string
	text?: string
	attachments: Array<MailAttachment>
}

/** Options for the mock provider constructor. */
type Options = CommonProviderOptions & {
	/** When true, every `send` rejects with a simulated provider error. */
	fail?: boolean
}

interface SendError {
	error: string
}

type SendResponse = { id: string; message: SentMessage }

/**
 * In-memory mock provider for tests. It runs the same normalization/validation as
 * the real providers (defaults, FormData parsing, address parsing, attachments)
 * but records the result instead of sending it — no network involved.
 *
 * @example
 * ```ts
 * import Mock from "postboi/mock"
 *
 * const mail = new Mock({ default_from: "no-reply@example.com" })
 * await mail.send({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
 *
 * expect(mail.sent).toHaveLength(1)
 * expect(mail.last?.to[0].address).toBe("contact@example.com")
 * ```
 */
export default class Mock extends ProviderBase<SendResponse> {
	#defaults: { from?: string; to?: string }
	#fail: boolean
	#counter = 0

	/** Every message captured by this instance, in send order. */
	readonly sent: Array<SentMessage> = []

	constructor({ default_from, default_to, fail }: Options = {}) {
		super()
		this.#defaults = { from: default_from, to: default_to }
		this.#fail = fail ?? false
	}

	/** The most recently captured message, or undefined if nothing has been sent. */
	get last(): SentMessage | undefined {
		return this.sent.at(-1)
	}

	/** Forget all captured messages. */
	clear(): void {
		this.sent.length = 0
	}

	async send(_options: SendOptions): Promise<SendResponse> {
		const options = await this.prepare_send(_options, this.#defaults)

		if (this.#fail) {
			const error: SendError = { error: "Simulated failure from mock provider" }
			throw error
		}

		const message: SentMessage = {
			to: this.parse_addresses(options.to),
			from: this.parse_email_address(options.from),
			cc: options.cc ? this.parse_addresses(options.cc) : undefined,
			bcc: options.bcc ? this.parse_addresses(options.bcc) : undefined,
			reply_to: options.reply_to ? this.parse_addresses(options.reply_to) : undefined,
			subject: options.subject || "Mail sent from website",
			html: typeof options.body === "string" ? options.body : undefined,
			text: options.text,
			attachments: options.attachments ? await this.parse_attachments(options.attachments) : [],
		}

		this.sent.push(message)
		return { id: `mock-${++this.#counter}`, message }
	}

	/** Type guard for a mock error response. */
	is_error(error: unknown): error is SendError {
		if (error === null || typeof error !== "object") return false
		const e = error as Record<string, unknown>
		return typeof e.error === "string"
	}
}
