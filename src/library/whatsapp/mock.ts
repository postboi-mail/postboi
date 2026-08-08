import {
	WhatsappProvider,
	type PreparedWhatsapp,
	type WhatsappProviderOptions,
} from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError } from "../errors.js"
import { MockRecorder, type MockRecorderOptions } from "../mock_recorder.js"

/** A normalized snapshot of a WhatsApp message captured by the mock. */
export interface SentWhatsapp {
	to: string
	from?: string
	message?: string
	template?: string
	variables?: Record<string, string>
	language: string
}

/** Options for the WhatsApp mock constructor. */
type Options = WhatsappProviderOptions &
	MockRecorderOptions<SentWhatsapp> & {
		/**
		 * When true, every free-form `message` send rejects as though the 24-hour customer
		 * service window were closed — the routine WhatsApp failure, simulatable because
		 * the handling (send a template, or let a fallback chain advance) is easy to get
		 * wrong. Template sends still succeed, exactly as they would in production.
		 */
		outside_window?: boolean
	}

type SendResponse = { id: string; message: SentWhatsapp }

/**
 * In-memory mock WhatsApp provider, and the development fallback.
 *
 * @example
 * ```ts
 * import MockWhatsapp from "postboi/whatsapp-mock"
 *
 * const wa = new MockWhatsapp({ outside_window: true })
 * await wa.send({ to: "+447788223344", message: "hi" }).catch((e) => {
 *   if (MockWhatsapp.is_outside_window(e)) send_template_instead()
 * })
 * ```
 */
export default class MockWhatsapp extends WhatsappProvider<SendResponse> {
	protected readonly provider = "mock"
	protected override readonly requires_from = false
	#outside_window: boolean
	#recorder: MockRecorder<SentWhatsapp>

	constructor({ fail, log, sink, outside_window, ...options }: Options = {}) {
		super(options)
		this.#outside_window = outside_window ?? false
		this.#recorder = new MockRecorder("whatsapp", { fail, log, sink }, log_whatsapp)
	}

	/** Every message captured by this instance, in send order. */
	get sent(): Array<SentWhatsapp> {
		return this.#recorder.sent
	}

	/** The most recently captured message, or undefined if nothing has been sent. */
	get last(): SentWhatsapp | undefined {
		return this.#recorder.last
	}

	/** Forget all captured messages. */
	clear(): void {
		this.#recorder.clear()
	}

	// Capture instead of sending. Overriding `deliver` (not `send`) keeps the base class's
	// overload handling, hooks and batching — the parts that would otherwise drift.
	protected override async deliver(message: PreparedWhatsapp): Promise<SendResponse> {
		if (this.#outside_window && message.message) {
			throw new PostboiError({
				provider: "mock",
				channel: "whatsapp",
				code: "outside_window",
				message:
					"Outside the 24-hour customer service window (simulated) — send a template instead.",
			})
		}
		return this.#recorder.capture({
			to: message.to,
			from: message.from,
			message: message.message,
			template: message.template,
			variables: message.variables,
			language: message.language,
		})
	}

	// Never reached — `deliver` is overridden and nothing calls through to the HTTP path.
	protected build_request(_message: PreparedWhatsapp): RequestSpec {
		throw new PostboiError({
			provider: "mock",
			channel: "whatsapp",
			message: "The mock WhatsApp provider does not make requests",
		})
	}

	protected parse_response(_response: Response, _data: unknown): SendResponse {
		throw new PostboiError({
			provider: "mock",
			channel: "whatsapp",
			message: "The mock WhatsApp provider does not make requests",
		})
	}
}

/** Print a captured WhatsApp message. */
function log_whatsapp(captured: SentWhatsapp): void {
	const body = captured.template
		? `template ${captured.template}${captured.variables ? ` ${JSON.stringify(captured.variables)}` : ""}`
		: (captured.message ?? "")
	console.log(`postboi (mock whatsapp) → ${captured.to}\n\n${body}`)
}
