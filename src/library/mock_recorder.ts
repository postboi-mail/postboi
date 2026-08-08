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
import { PostboiError, type Channel } from "./errors.js"

/** Options every mock accepts on top of its channel's provider options. */
export type MockRecorderOptions<TCaptured = unknown> = {
	/** When true, every `send` rejects with a simulated {@link PostboiError}. */
	fail?: boolean
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
	readonly #fail: boolean
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
		if (this.#fail) {
			throw new PostboiError({
				provider: "mock",
				channel: this.#channel,
				message: `Simulated failure from mock ${this.#channel} provider`,
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
