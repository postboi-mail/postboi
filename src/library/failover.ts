import type { SendOptions } from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"

/**
 * Composite provider that tries each underlying provider in order and returns the
 * first success. If every provider fails, it throws a {@link PostboiError} whose
 * `raw` is the array of underlying errors.
 *
 * Because it only depends on the shared core, importing it never pulls in any
 * specific provider — you bring your own.
 *
 * @example
 * ```ts
 * import Failover from "postboi/failover"
 * import Resend from "postboi/resend"
 * import Postmark from "postboi/postmark"
 *
 * const mail = new Failover([
 *   new Resend({ api_key: RESEND_API_KEY, default_from: "no-reply@example.com" }),
 *   new Postmark({ api_key: POSTMARK_TOKEN, default_from: "no-reply@example.com" }),
 * ])
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hi</p>" })
 * ```
 */
export default class Failover {
	#providers: Array<ProviderBase>

	constructor(providers: Array<ProviderBase>) {
		if (providers.length === 0) throw new Error("Failover requires at least one provider")
		this.#providers = providers
	}

	/** Try each provider in order; return the first success or throw if all fail. */
	async send(options: SendOptions): Promise<unknown> {
		const errors: Array<unknown> = []
		for (const provider of this.#providers) {
			try {
				return await provider.send(options)
			} catch (error) {
				errors.push(error)
			}
		}
		throw new PostboiError({
			provider: "failover",
			message: `All ${this.#providers.length} providers failed`,
			raw: errors,
		})
	}

	/** Type guard: is this a normalized Postboi error? */
	is_error(error: unknown): error is PostboiError {
		return error instanceof PostboiError
	}
}
