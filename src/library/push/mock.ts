import { PushProvider, type PreparedPush, type PushProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError } from "../errors.js"
import { MockRecorder, type MockRecorderOptions } from "../mock_recorder.js"

/** A normalized snapshot of a notification captured by the mock. */
export interface SentPush {
	to: string
	title?: string
	message: string
	url?: string
	data?: Record<string, unknown>
}

/** Options for the push mock constructor. */
type Options = PushProviderOptions &
	MockRecorderOptions<SentPush> & {
		/** When true, every `send` rejects as though the subscription had expired (410). */
		expired?: boolean
	}

type SendResponse = { id: string; message: SentPush }

/**
 * In-memory mock push provider, and the development fallback.
 *
 * The `expired` option is worth knowing about: expiring subscriptions are the normal
 * steady state of push, not an edge case, and the handling is easy to get wrong — so it's
 * simulatable rather than something you discover in production.
 *
 * @example
 * ```ts
 * import MockPush from "postboi/push-mock"
 *
 * const notify = new MockPush({ expired: true })
 * await notify.send({ to: "tok", message: "hi" }).catch((e) => {
 *   if (MockPush.is_expired(e)) forget_subscription()
 * })
 * ```
 */
export default class MockPush extends PushProvider<SendResponse> {
	protected readonly provider = "mock"
	#expired: boolean
	#recorder: MockRecorder<SentPush>

	constructor({ fail, expired, log, sink, ...options }: Options = {}) {
		super({ ...options, default: { to: "mock-token", ...options.default } })
		this.#expired = expired ?? false
		this.#recorder = new MockRecorder("push", { fail, log, sink }, log_push)
	}

	/** Every notification captured by this instance, in send order. */
	get sent(): Array<SentPush> {
		return this.#recorder.sent
	}

	/** The most recently captured notification, or undefined if nothing has been sent. */
	get last(): SentPush | undefined {
		return this.#recorder.last
	}

	/** Forget all captured notifications. */
	clear(): void {
		this.#recorder.clear()
	}

	// Capture instead of sending. Overriding `deliver` (not `send`) keeps the base class's
	// overload handling, hooks and batching — the parts that would otherwise drift.
	protected override async deliver(message: PreparedPush): Promise<SendResponse> {
		if (this.#expired) {
			throw new PostboiError({
				provider: "mock",
				channel: "push",
				status: 410,
				code: "expired_subscription",
				message: "Push subscription has expired or been unsubscribed (simulated).",
			})
		}
		return this.#recorder.capture({
			to: typeof message.to === "string" ? message.to : message.to.endpoint,
			title: message.title,
			message: message.message,
			url: message.url,
			data: message.data,
		})
	}

	// Never reached — `deliver` is overridden and nothing calls through to the HTTP path.
	protected build_request(_message: PreparedPush): RequestSpec {
		throw new PostboiError({
			provider: "mock",
			channel: "push",
			message: "The mock push provider does not make requests",
		})
	}

	protected parse_response(_response: Response, _data: unknown): SendResponse {
		throw new PostboiError({
			provider: "mock",
			channel: "push",
			message: "The mock push provider does not make requests",
		})
	}
}

/** Print a captured notification. */
function log_push(captured: SentPush): void {
	const heading = captured.title ? `${captured.title}\n` : ""
	console.log(`postboi (mock push) → ${captured.to}\n\n${heading}${captured.message}`)
}
