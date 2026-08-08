/**
 * Normalized errors, shared by every channel.
 *
 * Its own module so {@link Transport} and the channel providers can both reach it without
 * importing each other — the package root re-exports all of it, so this file is internal.
 */

/**
 * A delivery channel. Providers declare which one they serve, and it rides along on errors
 * and lifecycle hooks so a caller fanning out across channels can tell what happened where.
 */
export type Channel = "email" | "sms" | "push" | "chat" | "whatsapp"

/** Normalized error fields a provider extracts from a failed response body. */
export type ProviderError = { message: string; code?: string | number }

/**
 * A normalized error thrown by every provider, so error handling is the same no matter
 * which provider or channel you use. The original provider payload is preserved on `raw`.
 */
export class PostboiError extends Error {
	/** The provider that produced the error, e.g. "resend". */
	readonly provider: string
	/**
	 * The channel the failure happened on. Undefined only for errors raised before a channel
	 * is known (an unresolvable provider, say). The reason it's here rather than inferred
	 * from `provider`: a fan-out reports one error per channel, and "which leg failed" is the
	 * first thing you need and the most annoying to reconstruct.
	 */
	readonly channel?: Channel
	/** HTTP status code, when the failure came from a response. */
	readonly status?: number
	/** Provider-specific error code, when available. */
	readonly code?: string | number
	/** The original provider error payload (parsed body or thrown cause). */
	readonly raw: unknown

	constructor(args: {
		provider: string
		message: string
		channel?: Channel
		status?: number
		code?: string | number
		raw?: unknown
	}) {
		super(args.message)
		this.name = "PostboiError"
		this.provider = args.provider
		this.channel = args.channel
		this.status = args.status
		this.code = args.code
		this.raw = args.raw
	}
}

/**
 * Thrown from a `before.send` hook to cancel a send (e.g. a suppressed/unsubscribed
 * recipient). It is a {@link PostboiError} with `code: "skipped"`, so it flows through
 * `is_error` and bulk `BatchResult`s; catch it with `instanceof SkipSendError`. Skips do
 * **not** trigger the `on.error` hook.
 */
export class SkipSendError extends PostboiError {
	constructor(message = "Send was skipped by a before.send hook", code: string = "skipped") {
		super({ provider: "skip", message, code })
		this.name = "SkipSendError"
	}
}

/**
 * Thrown when a FormData body trips the spam checks — the honeypot field (`🍯` by default)
 * was filled. A {@link SkipSendError} with `code: "spam"`, so like any intentional skip it
 * never reaches the `on.error` hook. `postboi/kit` turns it into a silent
 * `{ success: true }` so bots can't tell they were caught.
 */
export class SpamError extends SkipSendError {
	constructor(message = "Submission flagged as spam") {
		super(message, "spam")
		this.name = "SpamError"
	}
}

/** Type guard: is a caught value a normalized {@link PostboiError}? */
export function is_error(error: unknown): error is PostboiError {
	return error instanceof PostboiError
}

/** Type guard: is a caught value the spam-check {@link SpamError}? */
export function is_spam(error: unknown): error is SpamError {
	return error instanceof SpamError
}
