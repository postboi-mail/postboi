import { SmsProvider, type PreparedSms, type SmsProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError } from "../errors.js"
import { MockRecorder, type MockRecorderOptions } from "../mock_recorder.js"
import { segments } from "./phone.js"

export type { MockFailure } from "../mock_recorder.js"

/** A normalized snapshot of a text captured by the mock provider. */
export interface SentSms {
	to: Array<string>
	from?: string
	message: string
	/** Segment count and encoding — the unit providers actually bill. */
	segments: { count: number; encoding: "gsm7" | "ucs2"; units: number }
	/**
	 * When the send asked for future delivery. Captured for the same reason the email mock
	 * captures it: "sent" and "queued for Tuesday" are otherwise indistinguishable.
	 */
	scheduled_at?: Date
	/** MMS media URLs, when the send carried any. */
	media?: Array<string>
	/** Seconds the provider would keep trying, when the send set it. */
	validity?: number
}

/** Options for the SMS mock constructor. */
type Options = SmsProviderOptions & MockRecorderOptions<SentSms>

type SendResponse = { id: string; message: SentSms }

/**
 * In-memory mock SMS provider. Runs the same normalization and validation as a real one —
 * defaults, E.164 conversion, segment counting — but records instead of sending.
 *
 * This is also what stands in front of a real provider in development, which matters more
 * for SMS than for email: a stray dev send costs real money and reaches a real handset
 * with no way to take it back.
 *
 * @example
 * ```ts
 * import MockSms from "postboi/sms-mock"
 *
 * const text = new MockSms({ default: { from: "POSTBOI", country: "GB" } })
 * await text.send({ to: "07788 223344", message: "hi" })
 * expect(text.last?.to).toEqual(["+447788223344"])
 * ```
 */
export default class MockSms extends SmsProvider<SendResponse> {
	protected readonly provider = "mock"
	protected override readonly requires_from = false
	protected override readonly supports_scheduling = true
	// The mock stands in for whichever provider is configured, so it refuses nothing a real
	// one might take: the real provider is where a too-long list or a reserved name is caught.
	protected override readonly max_media = Number.POSITIVE_INFINITY
	protected override readonly validity_range = [1, Number.MAX_SAFE_INTEGER] as const
	protected override readonly reserved_options = []
	#recorder: MockRecorder<SentSms>

	constructor({ fail, log, sink, ...options }: Options = {}) {
		super(options)
		this.#recorder = new MockRecorder("sms", { fail, log, sink }, log_sms)
	}

	/** Every text captured by this instance, in send order. */
	get sent(): Array<SentSms> {
		return this.#recorder.sent
	}

	/** The most recently captured text, or undefined if nothing has been sent. */
	get last(): SentSms | undefined {
		return this.#recorder.last
	}

	/** Forget all captured texts. */
	clear(): void {
		this.#recorder.clear()
	}

	// Capture instead of sending. Overriding `deliver` (not `send`) keeps the base class's
	// overload handling, hooks and batching — the parts that would otherwise drift.
	protected override async deliver(message: PreparedSms): Promise<SendResponse> {
		return this.#recorder.capture({
			to: message.to,
			from: message.from,
			message: message.message,
			segments: segments(message.message),
			scheduled_at: message.scheduled_at,
			media: message.media,
			validity: message.validity,
		})
	}

	// Never reached — `deliver` is overridden and nothing calls through to the HTTP path.
	protected build_request(_message: PreparedSms): RequestSpec {
		throw new PostboiError({
			provider: "mock",
			channel: "sms",
			message: "The mock SMS provider does not make requests",
		})
	}

	protected parse_response(_response: Response, _data: unknown): SendResponse {
		throw new PostboiError({
			provider: "mock",
			channel: "sms",
			message: "The mock SMS provider does not make requests",
		})
	}
}

/**
 * Print a captured text. The body goes out whole: the reason to read a dev text in the
 * terminal is almost always a code inside it, and a truncated line is useless.
 */
function log_sms(message: SentSms): void {
	const lines = [
		`postboi (mock sms): ${message.to.join(", ")}`,
		...(message.from ? [`  from: ${message.from}`] : []),
		`  cost: ${message.segments.count} segment${message.segments.count === 1 ? "" : "s"} (${message.segments.encoding})`,
	]
	if (message.scheduled_at) lines.push(`  send: ${message.scheduled_at.toISOString()}`)
	lines.push("", message.message.trim())
	console.log(lines.join("\n"))
}
