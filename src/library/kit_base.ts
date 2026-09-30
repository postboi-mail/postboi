import {
	fail,
	type RequestEvent,
	type ActionFailure,
	type RemoteForm,
	type RemoteFormInput,
} from "@sveltejs/kit"
// Type-only: `form` itself comes from `sveltekit`, which kit.ts fills in under Vite. This
// module never imports `$app/server`, so a plain `bun test` can import it (see kit.ts).
import type { form as sveltekit_form } from "$app/server"
// From ./mail.js directly, not the package root — the root statically re-exports the
// Postboi provider class, which must stay a dynamic-only leaf (see LOADERS in mail.ts).
import { mail as zero_config_mail, sveltekit, with_remoteip } from "./mail.js"
import { is_error, is_spam, type SendOptions } from "./index.js"
// Type-only — the webhooks module itself is loaded lazily inside the handler, so
// action-only users never pull the adapters or crypto into their bundle.
import type { WebhookEvent, ReceiveOptions } from "./webhooks/index.js"

// Re-export the core so `import { PostboiError, is_error, ... } from "postboi/kit"` works.
export * from "./index.js"
// The zero-config `cancel()` too — `mail` here is the form action below, not the sender,
// so for `mail.recipients.add()` / `mail.lists.*` import `mail` from "postboi".
export { cancel } from "./mail.js"

/** Anything that can send — a configured provider instance, or the zero-config `mail`. */
interface Mailer {
	send(options: SendOptions): Promise<unknown>
}

/** What a built action returns: the form succeeded, or a typed failure. */
type ActionResult = { success: true } | ActionFailure<{ error: string }>

/** A SvelteKit form action built by {@link action}. */
type FormAction = (event: RequestEvent) => Promise<ActionResult>

/**
 * Send options merged into every send — handy for forcing a recipient or subject
 * server-side so the form can't set them. The form's own data is always the body, so
 * `body` is not settable here.
 */
export type ActionFields = Partial<Omit<SendOptions, "body">>

export type ActionOptions = ActionFields & {
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
 * @example Forcing send options the form shouldn't control:
 * ```ts
 * export const actions = { default: action(mail, { to: "team@example.com" }) }
 * ```
 */
export function action(options?: ActionOptions): FormAction
export function action(mailer: Mailer, options?: ActionOptions): FormAction
export function action(a?: Mailer | ActionOptions, b: ActionOptions = {}): FormAction {
	const is_mailer = typeof (a as Mailer | undefined)?.send === "function"
	const mailer = is_mailer ? (a as Mailer) : undefined
	const { status = 400, ...fields } = is_mailer ? b : ((a as ActionOptions) ?? {})
	const dispatch = mailer ? (o: SendOptions) => mailer.send(o) : zero_config_mail

	return async (event) => {
		try {
			const body = await event.request.formData()
			await dispatch({
				...fields,
				body,
				captcha: with_remoteip(fields.captcha, event),
			})
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

/** What a remote mail form resolves to: `mail.result` after a submission. */
export type RemoteResult = { success: true } | { success: false; error: string }

/** The remote mail form built by {@link remote} — spread it onto a `<form>` element. */
export type RemoteMailForm = RemoteForm<RemoteFormInput, RemoteResult>

/**
 * Convert the structured data a remote `form` hands back into the FormData the send
 * pipeline expects: nested objects rejoin with `→` (the fieldset grouping syntax the
 * email renderer tables by), arrays become repeated fields, `File` values pass through
 * untouched so they arrive as attachments.
 */
export function remote_form_data(
	data: Record<string, unknown>,
	form = new FormData(),
	prefix = ""
): FormData {
	for (const [key, value] of Object.entries(data)) {
		const name = prefix ? `${prefix}→${key}` : key
		const values = Array.isArray(value) ? value : [value]
		for (const item of values) {
			if (item === undefined || item === null) continue
			if (item instanceof File) form.append(name, item)
			else if (typeof item === "object" && !Array.isArray(item)) {
				remote_form_data(item as Record<string, unknown>, form, name)
			} else form.append(name, String(item))
		}
	}
	return form
}

/**
 * Build a SvelteKit *remote function* form (experimental — needs
 * `kit.experimental.remoteFunctions` in the consumer's config). The remote counterpart
 * of {@link action}: call it in a `.remote.ts` file, export the result, and spread it
 * onto a `<form>` — no `+page.server.ts`, no action wiring, progressive enhancement
 * included. `postboi/remote` ships a ready-made zero-config instance.
 *
 * @example
 * ```ts
 * // src/lib/mail.remote.ts
 * import { remote } from "postboi/kit"
 * export const contact = remote({ to: "team@example.com" })
 * ```
 * ```svelte
 * <form {...contact}>
 * 	<input {...contact.fields.contact.name.as("text")} required />
 * 	<button disabled={!!contact.pending}>Send</button>
 * </form>
 * {#if contact.result?.success}<p>Thanks!</p>{/if}
 * ```
 *
 * Field names follow the remote-form rules (JS paths — nesting instead of `→`):
 * `fields.contact.name` renders in the email exactly like a classic `contact→name` field.
 */
export function remote(options?: ActionFields): RemoteMailForm
export function remote(mailer: Mailer, options?: ActionFields): RemoteMailForm
export function remote(a?: Mailer | ActionFields, b: ActionFields = {}): RemoteMailForm {
	const is_mailer = typeof (a as Mailer | undefined)?.send === "function"
	const mailer = is_mailer ? (a as Mailer) : undefined
	const fields = is_mailer ? b : ((a as ActionFields) ?? {})
	const dispatch = mailer ? (o: SendOptions) => mailer.send(o) : zero_config_mail
	const form = sveltekit.form as typeof sveltekit_form | undefined
	if (!form) {
		throw new Error(
			"postboi: remote() needs SvelteKit's $app/server, so it only runs in a .remote.ts file under Vite. Use action() or mail() elsewhere."
		)
	}

	return form("unchecked", async (data: RemoteFormInput) => {
		try {
			await dispatch({
				...fields,
				body: remote_form_data(data),
				captcha: with_remoteip(fields.captcha),
			})
			return { success: true as const }
		} catch (error) {
			// A tripped honeypot pretends to succeed — no email is sent, and the bot learns nothing.
			if (is_spam(error)) return { success: true as const }
			return { success: false as const, error: is_error(error) ? error.message : String(error) }
		}
	})
}

/**
 * Build a SvelteKit request handler that receives provider delivery-event webhooks:
 * verifies the signature, normalizes the payload, and calls your handler once per event.
 *
 * Responses are what providers expect: `200 {received}` on success, `401` on a failed
 * signature, `400` on an unparseable payload, and `500` when your handler throws — so
 * the provider retries. SNS subscription handshakes (SES, Scaleway) confirm themselves,
 * and a provider that checks the endpoint with a GET before subscribing (Meta) gets its
 * challenge echoed — export the same handler as `GET` and `POST` for those.
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
	// The universal handler in postboi/webhooks accepts anything carrying a .request —
	// a SvelteKit RequestEvent included. This wrapper narrows the type for +server.ts
	// exports and keeps the webhooks module out of kit's graph until a request arrives.
	return async (event) => {
		const { webhook: handle } = await import("./webhooks/handler.js")
		return handle(handler, options)(event)
	}
}
