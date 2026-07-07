import { fail, type RequestEvent, type ActionFailure } from "@sveltejs/kit"
import { mail as zero_config_mail } from "./postboi.js"
import { is_error, is_spam, type SendOptions } from "./index.js"

// Re-export the core so `import { PostboiError, is_error, ... } from "postboi/kit"` works.
export * from "./index.js"

/** Anything that can send — a configured provider instance, or the zero-config `mail`. */
interface Mailer {
	send(options: SendOptions): Promise<unknown>
}

/** What a built action returns: the form succeeded, or a typed failure. */
type ActionResult = { success: true } | ActionFailure<{ error: string }>

/** A SvelteKit form action built by {@link action}. */
type FormAction = (event: RequestEvent) => Promise<ActionResult>

export interface ActionOptions {
	/**
	 * Fields merged into the send — handy for forcing a recipient or subject server-side so
	 * the form can't set them. The form's FormData is always used as the body.
	 */
	fields?: Partial<Omit<SendOptions, "body">>
	/** HTTP status returned when sending fails. Defaults to 400. */
	status?: number
}

/**
 * Build a SvelteKit form action that reads the request's FormData, sends it, and returns
 * `{ success: true }` — or `fail(status, { error })` if sending throws. Removes the
 * `await request.formData()` / `try`/`catch` / `is_error` ceremony from every action.
 *
 * @example Zero-config — uses the provider configured by `bunx postboi init`:
 * ```ts
 * import { mail } from "postboi/kit"
 * export const actions = { default: mail }
 * ```
 *
 * @example With a configured provider instance:
 * ```ts
 * import { action } from "postboi/kit"
 * import Resend from "postboi/resend"
 *
 * const resend = new Resend({ api_key: RESEND_API_KEY, default: { from: "no-reply@example.com" } })
 * export const actions = { default: action(resend) }
 * ```
 *
 * @example Forcing fields the form shouldn't control:
 * ```ts
 * export const actions = { default: action(mail, { fields: { to: "team@example.com" } }) }
 * ```
 */
export function action(options?: ActionOptions): FormAction
export function action(mailer: Mailer, options?: ActionOptions): FormAction
export function action(a?: Mailer | ActionOptions, b: ActionOptions = {}): FormAction {
	const is_mailer = typeof (a as Mailer | undefined)?.send === "function"
	const mailer = is_mailer ? (a as Mailer) : undefined
	const options = is_mailer ? b : ((a as ActionOptions) ?? {})
	const dispatch = mailer ? (o: SendOptions) => mailer.send(o) : zero_config_mail
	const status = options.status ?? 400

	return async ({ request }) => {
		try {
			const body = await request.formData()
			await dispatch({ ...options.fields, body })
			return { success: true }
		} catch (error) {
			// A tripped honeypot pretends to succeed — no email is sent, and the bot learns nothing.
			if (is_spam(error)) return { success: true }
			return fail(status, { error: is_error(error) ? error.message : String(error) })
		}
	}
}

/**
 * A ready-made zero-config form action. Drop it straight into a route:
 *
 * ```ts
 * import { mail } from "postboi/kit"
 * export const actions = { default: mail }
 * ```
 *
 * It sends via whichever provider `POSTBOI_PROVIDER` names (set by `bunx postboi init`).
 */
export const mail: FormAction = action()
