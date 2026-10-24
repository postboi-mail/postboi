/**
 * The machinery every channel mock shares: capture, `last`, `clear`, id minting and the
 * simulated failure. Factored out so the mocks differ only in what they capture and how
 * they print it — three (now four) hand-rolled copies of this had already started to
 * drift in the details.
 *
 * Composition rather than a base class on purpose: each mock must extend its *channel's*
 * provider base (`SmsProvider`, `ChatProvider`, …) to inherit that channel's preparation,
 * so there is no free slot in the hierarchy for a shared `MockTransport`.
 *
 * Internal: not part of the public surface.
 */
import { PostboiError, type Channel, type RejectionReason } from "./errors.js"

/**
 * A failure a mock should answer with, shaped like a real provider's: a refusal with a
 * `reason` (so a failover chain moves on, or doesn't, exactly as it would), or an unknown
 * outcome. Everything is optional; `{}` is a plain refusal with no reason.
 */
export type MockFailure = {
	/** Why it was refused. `auth`, `rate_limited`, `sender` and `account` fail over. */
	reason?: RejectionReason
	/** The send may have gone anyway: a timeout or a 5xx. Never fails over. */
	outcome_unknown?: boolean
	status?: number
	code?: string | number
	message?: string
	/** Seconds the simulated provider asks to wait, as a `Retry-After` would say. */
	retry_after?: number
}

/** Options every mock accepts on top of its channel's provider options. */
export type MockRecorderOptions<TCaptured = unknown> = {
	/**
	 * Make sends fail. `true` rejects every send with a plain simulated error; a
	 * {@link MockFailure} rejects every send with that one; a list is a script, one entry per
	 * send in order, where `null` or `false` succeeds and a send past the end succeeds too.
	 *
	 * ```ts
	 * // The first send is refused for its sender, the second goes through.
	 * new MockSms({ fail: [{ reason: "sender" }, null] })
	 * ```
	 */
	fail?: boolean | MockFailure | ReadonlyArray<MockFailure | null | false>
	/** Print each captured message. Off by default so tests stay quiet. */
	log?: boolean
	/**
	 * Hand each capture somewhere it can be read — the local dev inbox, in practice
	 * (see `inbox_sink`). Resolving true means it was taken and the console print is
	 * skipped in favour of the inbox; false or a throw falls back to printing.
	 */
	sink?: (captured: TCaptured) => Promise<boolean> | boolean
}

export class MockRecorder<TCaptured> {
	readonly #channel: Channel
	readonly #fail: MockRecorderOptions["fail"]
	#step = 0
	readonly #log: boolean
	readonly #sink?: (captured: TCaptured) => Promise<boolean> | boolean
	readonly #print: (captured: TCaptured) => void
	#counter = 0

	/** Every message captured, in send order. */
	readonly sent: Array<TCaptured> = []

	constructor(
		channel: Channel,
		options: MockRecorderOptions<TCaptured>,
		print: (captured: TCaptured) => void
	) {
		this.#channel = channel
		this.#fail = options.fail ?? false
		this.#log = options.log ?? false
		this.#sink = options.sink
		this.#print = print
	}

	/** The failure this send meets, if any: every send's, or the script's next entry. */
	#next_failure(): MockFailure | undefined {
		const fail = this.#fail
		if (!fail) return undefined
		if (fail === true) return {}
		if (Array.isArray(fail)) {
			const entry = (fail as ReadonlyArray<MockFailure | null | false>)[this.#step++]
			return entry || undefined
		}
		return fail as MockFailure
	}

	/** The most recently captured message, or undefined if nothing has been sent. */
	get last(): TCaptured | undefined {
		return this.sent.at(-1)
	}

	/** Forget all captured messages. */
	clear(): void {
		this.sent.length = 0
	}

	/**
	 * Record one send: simulate the configured failure, capture, hand to the sink or
	 * print, and return the `{ id, message }` response every mock resolves with.
	 */
	capture(captured: TCaptured): { id: string; message: TCaptured } {
		const failure = this.#next_failure()
		if (failure) {
			throw new PostboiError({
				provider: "mock",
				channel: this.#channel,
				message: failure.message ?? `Simulated failure from mock ${this.#channel} provider`,
				status: failure.status,
				code: failure.code,
				reason: failure.outcome_unknown ? undefined : failure.reason,
				outcome_unknown: failure.outcome_unknown ?? false,
				retry_after: failure.retry_after,
			})
		}
		this.sent.push(captured)
		if (this.#sink) {
			// Fire and forget: the send already resolved with the capture, and whether the
			// inbox took it only decides where a developer reads it. Refused (or unreachable)
			// falls back to the console so the message is never silently nowhere.
			const print = () => this.#log && this.#print(captured)
			void Promise.resolve()
				.then(() => this.#sink!(captured))
				.then((taken) => void (taken || print()), print)
		} else if (this.#log) {
			this.#print(captured)
		}
		return { id: `mock-${this.#channel}-${++this.#counter}`, message: captured }
	}
}
