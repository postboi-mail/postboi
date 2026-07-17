import { fail, json, type RequestEvent, type ActionFailure } from "@sveltejs/kit"
// From ./mail.js directly, not the package root — the root statically re-exports the
// Postboi provider class, which must stay a dynamic-only leaf (see LOADERS in mail.ts).
import { mail as zero_config_mail } from "./mail.js"
import { is_error, is_spam, type SendOptions } from "./index.js"
// Type-only — the webhooks module itself is loaded lazily inside the handler, so
// action-only users never pull the adapters or crypto into their bundle.
import type { WebhookEvent, ReceiveOptions } from "./webhooks/index.js"

// Re-export the core so `import { PostboiError, is_error, ... } from "postboi/kit"` works.
export * from "./index.js"
// The zero-config `cancel()` too (`mail` here is the form action below, not the sender).
export { cancel } from "./mail.js"

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

/**
 * Build a SvelteKit request handler that receives provider delivery-event webhooks:
 * verifies the signature, normalizes the payload, and calls your handler once per event.
 *
 * Responses are what providers expect: `200 {received}` on success, `401` on a failed
 * signature, `400` on an unparseable payload, and `500` when your handler throws — so
 * the provider retries. SNS subscription handshakes (SES, Scaleway) confirm themselves.
 *
 * @example
 * ```ts
 * // src/routes/webhooks/email/+server.ts
 * import { webhook } from "postboi/kit"
 *
 * export const POST = webhook(async (event) => {
 * 	if (event.type === "opened") {
 * 		console.log(`${event.email} opened in ${event.client?.name} on ${event.client?.device}`)
 * 	}
 * })
 * ```
 */
export function webhook(
	handler: (event: WebhookEvent) => void | Promise<void>,
	options?: ReceiveOptions
): (event: RequestEvent) => Promise<Response> {
	return async ({ request }) => {
		const { receive, WebhookVerificationError } = await import("./webhooks/index.js")

		let events: Array<WebhookEvent>
		try {
			events = await receive(request, options)
		} catch (error) {
			if (error instanceof WebhookVerificationError) {
				return json({ error: error.message }, { status: 401 })
			}
			const message = is_error(error) ? error.message : String(error)
			return json({ error: message }, { status: 400 })
		}

		try {
			for (const event of events) await handler(event)
		} catch (error) {
			// A throwing handler returns 500 so the provider redelivers the event.
			const message = error instanceof Error ? error.message : String(error)
			return json({ error: message }, { status: 500 })
		}

		return json({ received: events.length })
	}
}
