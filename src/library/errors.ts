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

/**
 * Why a provider refused a message, normalized across providers. Only ever set on a
 * refusal the provider proved; a timeout or a 5xx is `outcome_unknown` instead.
 *
 * - `auth`: the credentials were wrong or lack permission.
 * - `rate_limited`: too many requests; the provider says to come back later.
 * - `sender`: the From can't send this (unregistered, not SMS-capable, wrong pairing).
 * - `account`: the account can't send this (no balance, region off, a trial limit).
 * - `recipient`: the To isn't a number this can reach (invalid, a landline).
 * - `compliance`: the person opted out, or the content was blocked.
 * - `request`: anything else about the request itself.
 *
 * The first four are about *this* provider, so another might accept the same message:
 * those are the ones a provider chain fails over on (see {@link FAILOVER_REASONS}). The
 * last three would be refused anywhere.
 */
export type RejectionReason =
	| "auth"
	| "rate_limited"
	| "sender"
	| "account"
	| "recipient"
	| "compliance"
	| "request"

/** The reasons another provider might not share, so a chain moves on for them. */
export const FAILOVER_REASONS: ReadonlySet<RejectionReason> = new Set([
	"auth",
	"rate_limited",
	"sender",
	"account",
])

/** Normalized error fields a provider extracts from a failed response body. */
export type ProviderError = {
	message: string
	code?: string | number
	/** Why, where the provider's code says. Left out, the HTTP status decides. */
	reason?: RejectionReason
}

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
	 * first thing you need and the most annoying to reconstruct. Writable (unlike the rest)
	 * so `send()` can annotate the leg onto a subclass — a {@link SkipSendError} in
	 * particular — without re-wrapping it and destroying its `instanceof` identity.
	 */
	channel?: Channel
	/** HTTP status code, when the failure came from a response. */
	readonly status?: number
	/** Provider-specific error code, when available. */
	readonly code?: string | number
	/** The original provider error payload (parsed body or thrown cause). */
	readonly raw: unknown
	/**
	 * True when nothing proves the message wasn't sent: a timeout, a dropped connection or a
	 * 5xx. The provider may have queued it before answering badly or not at all, so sending
	 * it again can deliver it twice. Look it up with the provider, or resend with the same
	 * `idempotency_key` where the provider honours one. False for everything the provider
	 * refused outright and everything caught before a request was made.
	 */
	readonly outcome_unknown: boolean
	/**
	 * Why the provider refused, normalized: see {@link RejectionReason}. Set on refusals a
	 * provider answered (from its error code where it has one, else the HTTP status), and
	 * unset on everything else, an unknown outcome above all.
	 */
	readonly reason?: RejectionReason

	constructor(args: {
		provider: string
		message: string
		channel?: Channel
		status?: number
		code?: string | number
		raw?: unknown
		outcome_unknown?: boolean
		reason?: RejectionReason
	}) {
		super(args.message)
		this.name = "PostboiError"
		this.provider = args.provider
		this.channel = args.channel
		this.status = args.status
		this.code = args.code
		this.raw = args.raw
		this.outcome_unknown = args.outcome_unknown ?? false
		this.reason = args.reason
	}
}

/**
 * Thrown when a provider chain (`POSTBOI_SMS_PROVIDER=twilio,puresms`) failed over and the
 * message still didn't go. `errors` is every provider's error, in the order they were tried;
 * everything else — `provider`, `status`, `code`, `reason`, `outcome_unknown` — is the last
 * one's, since that is the answer the chain ended on. Catching `PostboiError` still catches it.
 */
export class FailoverError extends PostboiError {
	readonly errors: ReadonlyArray<PostboiError>

	constructor(errors: ReadonlyArray<PostboiError>) {
		const last = errors[errors.length - 1]
		super({
			provider: last.provider,
			channel: last.channel,
			status: last.status,
			code: last.code,
			raw: last.raw,
			outcome_unknown: last.outcome_unknown,
			reason: last.reason,
			message: errors
				.map((e) => `${e.provider}: ${e.message}${e.reason ? ` (${e.reason})` : ""}`)
				.join("; "),
		})
		this.name = "FailoverError"
		this.errors = errors
	}
}

/**
 * Would another provider in a chain be worth trying after this error? Only for a refusal
 * the provider proved, for a reason that is about that provider (see {@link FAILOVER_REASONS}).
 * Never after an unknown outcome — the message may already be on its way — and never for an
 * intentional skip.
 */
export function fails_over(error: unknown): boolean {
	return (
		error instanceof PostboiError &&
		!(error instanceof SkipSendError) &&
		!error.outcome_unknown &&
		error.reason !== undefined &&
		FAILOVER_REASONS.has(error.reason)
	)
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
 * Thrown when a FormData body trips the spam checks — the honeypot field (`_honey` by default)
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
