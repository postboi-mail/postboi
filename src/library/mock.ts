import type {
	SendOptions,
	CommonProviderOptions,
	MailAddress,
	MailAttachment,
	RequestSpec,
	BatchResult,
	BatchData,
	BatchOptions,
	Email,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"
import type { CancelResponse } from "./index.js"

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
	/**
	 * When the send asked for future delivery. Captured because it is the most important thing
	 * about a scheduled message and the easiest to lose: without it a mail queued for next
	 * Tuesday is indistinguishable from one sent a second ago.
	 */
	scheduled_at?: Date
}

/** Options for the mock provider constructor. */
type Options = CommonProviderOptions & {
	/** When true, every `send` rejects with a simulated {@link PostboiError}. */
	fail?: boolean
	/**
	 * Print each captured message to the console. Off by default so tests stay quiet.
	 * `mail()` turns it on whenever it resolves the mock itself — the development fallback
	 * for a missing credential, or an explicit `provider: "mock"` — because there the whole
	 * point is seeing the mail you would have sent (a magic link, a confirmation code).
	 */
	log?: boolean
	/**
	 * Hand each captured message somewhere it can be read — the local dev inbox, in
	 * practice. Returning false means it didn't arrive, and the message is printed instead,
	 * so a stopped inbox degrades to the console rather than swallowing the mail.
	 */
	sink?: (message: SentMessage, id: string) => boolean | Promise<boolean>
	/**
	 * Tell the sink a scheduled send was cancelled. Paired with {@link Options.sink}: without
	 * it the dev inbox goes on showing a cancelled message as though it were still going out.
	 */
	on_cancel?: (id: string) => unknown
}

type SendResponse = { id: string; message: SentMessage }

const address_list = (list: Array<MailAddress>) =>
	list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ")

/**
 * Print a captured message. The body goes out as-is rather than truncated: the reason to
 * read a dev mail in the terminal is usually a link or a code inside it, and a cut-off
 * line is the one thing that makes the output useless.
 */
function log_message(message: SentMessage): void {
	const lines = [
		`postboi (mock): ${message.subject}`,
		`  to:   ${address_list(message.to)}`,
		`  from: ${address_list([message.from])}`,
	]
	if (message.cc?.length) lines.push(`  cc:   ${address_list(message.cc)}`)
	if (message.bcc?.length) lines.push(`  bcc:  ${address_list(message.bcc)}`)
	if (message.attachments.length) {
		lines.push(`  files: ${message.attachments.map((a) => a.name).join(", ")}`)
	}
	// Printed rather than left implicit: "sent" and "queued for Tuesday" look identical here
	// otherwise, and the difference is the whole point of the send.
	if (message.scheduled_at) lines.push(`  send: ${message.scheduled_at.toISOString()}`)
	const body = message.text ?? message.html
	if (body) lines.push("", body.trim())
	console.log(lines.join("\n"))
}

/**
 * In-memory mock provider for tests. It runs the same normalization/validation as
 * the real providers (defaults, FormData parsing, address parsing, attachments)
 * but records the result instead of sending it — no network involved.
 *
 * @example
 * ```ts
 * import Mock from "postboi/mock"
 *
 * const mail = new Mock({ default: { from: "no-reply@example.com" } })
 * await mail.send({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
 *
 * expect(mail.sent).toHaveLength(1)
 * expect(mail.last?.to[0].address).toBe("contact@example.com")
 * ```
 */
export default class Mock extends ProviderBase<SendResponse> {
	protected readonly provider = "mock"
	/**
	 * Nothing to verify a Turnstile token against, and no credentials by design — so a token
	 * is dropped rather than raising `captcha_misconfigured`. That keeps <Captcha /> forms
	 * sendable in local dev and tests. The honeypot still runs, and an explicit secret or
	 * `turnstile: true` is still honoured.
	 */
	protected override readonly captcha_mode = "none" as const
	#fail: boolean
	#log: boolean
	#sink?: (message: SentMessage, id: string) => boolean | Promise<boolean>
	#on_cancel?: (id: string) => unknown
	#counter = 0

	/** Every message captured by this instance, in send order. */
	readonly sent: Array<SentMessage> = []

	/** Ids passed to `cancel`, in call order. */
	readonly canceled: Array<string> = []

	constructor({ fail, log, sink, on_cancel, ...options }: Options = {}) {
		super(options)
		this.#fail = fail ?? false
		this.#log = log ?? false
		this.#sink = sink
		this.#on_cancel = on_cancel
	}

	/** The most recently captured message, or undefined if nothing has been sent. */
	get last(): SentMessage | undefined {
		return this.sent.at(-1)
	}

	/** Forget all captured messages and cancellations. */
	clear(): void {
		this.sent.length = 0
		this.canceled.length = 0
	}

	/** Record a cancellation instead of calling a provider API. */
	async cancel(id: string): Promise<CancelResponse> {
		if (this.#fail) {
			throw new PostboiError({ provider: "mock", message: "Simulated failure from mock provider" })
		}
		this.canceled.push(id)
		// Best-effort, like the sink: an inbox that has gone away must not fail the cancel.
		try {
			await this.#on_cancel?.(id)
		} catch {
			// Nothing to do about it, and nothing that depends on it.
		}
		return { id }
	}

	send<const T extends ReadonlyArray<Email>>(
		options: Omit<BatchOptions, "to" | "data"> & { to: T; data: BatchData<T> }
	): Promise<Array<BatchResult<SendResponse>>>
	send(options: SendOptions): Promise<SendResponse>
	send(
		options: Array<SendOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<SendResponse>>>
	async send(
		options: SendOptions | BatchOptions | Array<SendOptions>,
		batch: { concurrency?: number } = {}
	): Promise<SendResponse | Array<BatchResult<SendResponse>>> {
		if (Array.isArray(options)) return this.send_batch(options, batch)
		if ("data" in options && options.data && Array.isArray(options.to)) {
			return this.send_data_batch(options)
		}

		return this.with_hooks(
			async () => this.prepare_send(options),
			async (message) => {
				if (this.#fail) {
					throw new PostboiError({
						provider: "mock",
						message: "Simulated failure from mock provider",
					})
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
					scheduled_at: message.scheduled_at,
				}

				this.sent.push(captured)
				// Assigned before delivery so the inbox is told the same id the caller gets back,
				// which is the id a later cancel() will arrive with.
				const id = `mock-${++this.#counter}`
				// The console is the fallback, not a duplicate: printing as well as delivering
				// would put the whole body in the terminal on every send with the inbox open.
				const delivered = this.#sink ? await this.#sink(captured, id) : false
				if (this.#log || (this.#sink && !delivered)) log_message(captured)
				return { id, message: captured }
			}
		)
	}

	// The mock never performs HTTP, so the request hooks are unused.
	protected build_request(): RequestSpec {
		throw new Error("mock provider does not build HTTP requests")
	}

	protected parse_response(): SendResponse {
		throw new Error("mock provider does not parse responses")
	}
}
