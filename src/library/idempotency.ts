/**
 * A local record of which idempotency keys have been sent, so sending the same key twice
 * sends once. None of the SMS providers takes an idempotency key on a send, so this is the
 * only way a repeated `idempotency_key` can mean what it says.
 *
 * Each key is reserved before the request, atomically, and settled after it:
 *
 * - **Sent**: a repeat with the same message returns the first result and sends nothing.
 * - **Refused** by the provider, provably: the key is released, so the same key may try
 *   again (and a failover chain's next provider may take it).
 * - **Unknown** (a timeout, a 5xx): the key stays held. The message may be on its way, so a
 *   repeat throws with `outcome_unknown` rather than sending a second copy. Look it up with
 *   the provider, then use a new key.
 *
 * A repeat while the first is still in flight throws the same way. A repeat with a
 * different message under the same key throws {@link IdempotencyConflictError}: that's a
 * bug in how the key was built, and guessing which message was meant would hide it.
 *
 * A record names its message by a SHA-256 of it rather than by its text, and keeps the first
 * send's result to answer a repeat with: whatever the provider returned, which may name the
 * recipient. Give a store that outlives the process the same care as the send log.
 */
import { PostboiError, type Channel } from "./errors.js"

/** What a store holds against one key. */
export interface IdempotencyRecord {
	/** The SHA-256 of the message the key was first used for. */
	fingerprint: string
	/** `pending` while the first send is in flight, then `sent` or `unknown`. */
	state: "pending" | "sent" | "unknown"
	/** The first send's result, once `sent`. */
	result?: unknown
}

/**
 * Where idempotency keys are kept. {@link memory_idempotency_store} keeps them in this
 * process; for several instances, implement this over a database, with `reserve` as one
 * atomic insert-if-absent (a unique key, `INSERT … ON CONFLICT DO NOTHING`, Redis `SET NX`).
 */
export interface IdempotencyStore {
	/**
	 * Claim `key` for a message, atomically. Resolve `undefined` when the key was free and
	 * is now held as `pending` for this caller; resolve the existing record when it wasn't.
	 */
	reserve(key: string, fingerprint: string): Promise<IdempotencyRecord | undefined>
	/** Record how a held key ended: `sent` with its result, or `unknown`. */
	settle(key: string, record: IdempotencyRecord): Promise<void>
	/** Free a held key, after a refusal that proves nothing was sent. */
	release(key: string): Promise<void>
}

/**
 * Thrown when an `idempotency_key` already used for one message is used for a different
 * one. Nothing is sent. `code` is `idempotency_conflict`.
 */
export class IdempotencyConflictError extends PostboiError {
	constructor(args: { provider: string; channel?: Channel; key: string }) {
		super({
			provider: args.provider,
			channel: args.channel,
			code: "idempotency_conflict",
			message: `idempotency_key "${args.key}" was already used for a different message. Use a new key for a new message.`,
		})
		this.name = "IdempotencyConflictError"
	}
}

/**
 * An {@link IdempotencyStore} in this process's memory. It protects one process for as long
 * as it runs: a restart or a second instance doesn't see its keys, so for those implement
 * the interface over shared storage. Keys are forgotten after `ttl_ms` (a day by default).
 */
export function memory_idempotency_store(options: { ttl_ms?: number } = {}): IdempotencyStore {
	const ttl = options.ttl_ms ?? 24 * 60 * 60 * 1000
	const records = new Map<string, { record: IdempotencyRecord; expires: number }>()
	const live = (key: string) => {
		const entry = records.get(key)
		if (entry && entry.expires <= Date.now()) {
			records.delete(key)
			return undefined
		}
		return entry
	}
	return {
		async reserve(key, fingerprint) {
			const existing = live(key)
			if (existing) return existing.record
			records.set(key, { record: { fingerprint, state: "pending" }, expires: Date.now() + ttl })
			return undefined
		},
		async settle(key, record) {
			records.set(key, { record, expires: Date.now() + ttl })
		},
		async release(key) {
			records.delete(key)
		},
	}
}

/** The hex SHA-256 of a message's identifying fields, as a fingerprint for a store. */
export async function fingerprint(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value))
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Send once per key: reserve it, run `send`, and settle the key by what happened. Without a
 * store or a key this is just `send()`.
 */
export async function send_once<T>(options: {
	store: IdempotencyStore | undefined
	key: string | undefined
	message: unknown
	provider: string
	channel: Channel
	send: () => Promise<T>
}): Promise<T> {
	const { store, key, provider, channel } = options
	if (!store || !key) return options.send()

	const print = await fingerprint(options.message)
	const existing = await store.reserve(key, print)
	if (existing) {
		if (existing.fingerprint !== print)
			throw new IdempotencyConflictError({ provider, channel, key })
		if (existing.state === "sent") return existing.result as T
		throw new PostboiError({
			provider,
			channel,
			code: existing.state === "pending" ? "idempotency_in_progress" : "idempotency_unknown",
			outcome_unknown: true,
			message:
				existing.state === "pending"
					? `idempotency_key "${key}" is already being sent. Nothing was sent again.`
					: `idempotency_key "${key}" was used for a send whose outcome is unknown, so nothing was sent again. Check with the provider whether it went, then use a new key.`,
		})
	}

	let result: T
	try {
		result = await options.send()
	} catch (error) {
		// A refusal the provider proved means nothing went, so the key is free to try again.
		if (error instanceof PostboiError && !error.outcome_unknown) await store.release(key)
		else await store.settle(key, { fingerprint: print, state: "unknown" })
		throw error
	}
	await store.settle(key, { fingerprint: print, state: "sent", result })
	return result
}
