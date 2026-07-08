import { PostboiError } from "../index.js"

/** Reasons webhook verification can fail. */
export type WebhookVerificationCode =
	| "invalid_signature"
	| "missing_secret"
	| "stale_timestamp"
	| "unsupported_runtime"

/**
 * Thrown when an incoming webhook fails verification — a bad signature, a missing
 * signing secret, or a stale timestamp (replay protection). A {@link PostboiError},
 * so `is_error` works; return 401 from your endpoint when you catch one.
 */
export class WebhookVerificationError extends PostboiError {
	constructor(args: {
		provider: string
		message: string
		code: WebhookVerificationCode
		raw?: unknown
	}) {
		super(args)
		this.name = "WebhookVerificationError"
	}
}
