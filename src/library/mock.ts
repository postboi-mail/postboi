import type {
	SendOptions,
	CommonProviderOptions,
	MailAddress,
	MailAttachment,
	RequestSpec,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"

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
	/** When true, every `send` rejects with a simulated {@link PostboiError}. */
	fail?: boolean
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
	protected readonly provider = "mock"
	#fail: boolean
	#counter = 0

	/** Every message captured by this instance, in send order. */
	readonly sent: Array<SentMessage> = []

	constructor({ fail, ...options }: Options = {}) {
		super(options)
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

	async send(options: SendOptions): Promise<SendResponse> {
		const message = await this.prepare_send(options)

		if (this.#fail) {
			throw new PostboiError({ provider: "mock", message: "Simulated failure from mock provider" })
		}

		const captured: SentMessage = {
			to: this.parse_addresses(message.to),
			from: this.parse_email_address(message.from),
			cc: message.cc ? this.parse_addresses(message.cc) : undefined,
			bcc: message.bcc ? this.parse_addresses(message.bcc) : undefined,
			reply_to: message.reply_to ? this.parse_addresses(message.reply_to) : undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			attachments: message.attachments ? await this.parse_attachments(message.attachments) : [],
		}

		this.sent.push(captured)
		return { id: `mock-${++this.#counter}`, message: captured }
	}

	// The mock never performs HTTP, so the request hooks are unused.
	protected build_request(): RequestSpec {
		throw new Error("mock provider does not build HTTP requests")
	}

	protected parse_response(): SendResponse {
		throw new Error("mock provider does not parse responses")
	}
}
