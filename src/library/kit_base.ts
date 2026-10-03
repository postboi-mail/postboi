import { fail, isActionFailure, type RequestEvent, type ActionFailure } from "@sveltejs/kit"
// Type-only: `form` itself comes from `sveltekit`, which kit.ts fills in under Vite. This
// module never imports `$app/server`, so a plain `bun test` can import it (see kit.ts).
import type { form as sveltekit_form } from "$app/server"
import type { StandardSchemaV1 } from "@standard-schema/spec"
// From ./mail.js directly, not the package root — the root statically re-exports the
// Postboi provider class, which must stay a dynamic-only leaf (see LOADERS in mail.ts).
import { current_request, mail as zero_config_mail, sveltekit, with_remoteip } from "./mail.js"
import {
	CAPTCHA_FIELDS,
	HONEYPOT_FIELD,
	HONEYPOT_FIELDS,
	SPECIAL_FIELDS,
	TURNSTILE_REMOTE_FIELD,
	is_error,
	is_spam,
	type Email,
	type SendOptions,
} from "./index.js"
import { get_config } from "./config.js"
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
type ActionResult<F = { error: string }> =
	| { success: true }
	| ActionFailure<{ error: string }>
	| ActionFailure<F>

/** A SvelteKit form action built by {@link action}. */
type FormAction<F = { error: string }> = (event: RequestEvent) => Promise<ActionResult<F>>

/**
 * Send options merged into every send — handy for forcing a recipient or subject
 * server-side so the form can't set them. The form's own data is always the body, so
 * `body` is not settable here.
 *
 * Blank strings count as unset, so an empty CMS field falls through to the post or the
 * defaults. `from` takes any address, because a CMS string can't satisfy the generated
 * types; the API still refuses one the account can't send from (`from_not_allowed`).
 */
export type ActionFields = Partial<Omit<SendOptions, "body" | "from">> & { from?: Email }

export type ActionOptions = ActionFields & {
	/** HTTP status returned when sending fails. Defaults to 400. */
	status?: number
}

/**
 * Options worked out per submission, from the request and the post. `data` is the post,
 * parsed once: read it, change it (delete fields, validate), and return the options, or
 * `fail(…)` to stop the send. A `_`-prefixed field it reads that isn't one of postboi's own
 * (`_subject`, `_reply_to`, …) never reaches the email, so a routing id can ride in the body.
 */
export type Resolver<T, F = never> = (submission: {
	event: RequestEvent
	data: FormData
	field: FieldReader
}) => T | ActionFailure<F> | void | Promise<T | ActionFailure<F> | void>

/**
 * One text field from the post, trimmed, or `undefined` when it's missing, blank or a file.
 * `String(data.get("email"))` turns a missing field into the string `"null"`, which counts
 * as set: a `reply_to` of "null", or a CMS lookup for `stories/null`. `field.all(name)` is
 * the same for a field posted more than once (a checkbox group): every non-blank value, in
 * order, or `[]`. Both trim, so a check that counts characters exactly reads `data` itself.
 */
export type FieldReader = ((name: string) => string | undefined) & {
	all(name: string): Array<string>
}

function field_reader(data: FormData): FieldReader {
	const text = (value: FormDataEntryValue | null) =>
		typeof value === "string" && value.trim() ? value.trim() : undefined
	return Object.assign((name: string) => text(data.get(name)), {
		all: (name: string) =>
			data.getAll(name).flatMap((value) => {
				const kept = text(value)
				return kept === undefined ? [] : [kept]
			}),
	})
}

/** postboi's own `_` fields: a resolver reading these doesn't take them out of the post. */
const OWN_FIELDS = new Set<string>([...SPECIAL_FIELDS, ...HONEYPOT_FIELDS, ...CAPTCHA_FIELDS])

const is_failure = <F>(value: unknown): value is ActionFailure<F> => isActionFailure(value)

/**
 * SvelteKit's `RemoteFormInput` and `RemoteForm`, spelled so one declaration reads on both
 * majors: SvelteKit 2 exports the pair from `@sveltejs/kit` and SvelteKit 3 moved it to
 * `$app/server`, and a shipped `.d.ts` can only name one place. `form` itself has lived on
 * `$app/server` all along, so the input is restated (it is the public shape of what a form
 * posts) and the form is read off `form`'s own return type.
 *
 * `form` is overloaded, and an instantiation expression has to satisfy every overload's
 * constraint at once: the unchecked overload wants a `RemoteFormInput` and the checked one
 * wants a Standard Schema. An intersection of the two is both, and the checked overload,
 * the last one, which is the one `ReturnType` reads, infers its input back out of the
 * schema half, which is `Input` again. So the fields come out typed exactly as `Input`
 * says, on both majors; `any` here would have made every field an unknown one.
 */
export interface RemoteFormInput {
	[key: string]: MaybeArray<string | number | boolean | File | RemoteFormInput> | undefined
}
type MaybeArray<T> = T | Array<T>
type RemoteForm<Input extends RemoteFormInput, Output> = ReturnType<
	typeof sveltekit_form<Input & StandardSchemaV1<Input, Record<string, unknown>>, Output>
>

const TRACKED = ["get", "getAll", "has"] as const

/**
 * Run `fn`, recording which fields it reads off `data`, so the ones a resolver consumed can
 * be dropped. The FormData is back to its own methods afterwards.
 */
async function track_reads<R>(data: FormData, fn: () => R | Promise<R>) {
	const read = new Set<string>()
	for (const method of TRACKED) {
		const original = data[method].bind(data) as (name: string) => unknown
		data[method] = ((name: string) => (read.add(name), original(name))) as never
	}
	try {
		return { read, result: await fn() }
	} finally {
		for (const method of TRACKED) delete (data as unknown as Record<string, unknown>)[method]
	}
}

/**
 * The options for one submission: as given, or from the resolver. Null for a bot that filled
 * the honeypot, which gets nothing run on its behalf (no lookups, no fetching URLs it posted).
 */
async function resolve<
	T extends ActionFields,
	F,
	S extends { event: RequestEvent; data: FormData },
>(
	given:
		| T
		| ((
				submission: S & { field: FieldReader }
		  ) => T | ActionFailure<F> | void | Promise<T | ActionFailure<F> | void>)
		| undefined,
	submission: S
): Promise<T | ActionFailure<F> | null> {
	if (typeof given !== "function") return given ?? ({} as T)
	const { data } = submission
	// The project's own honeypot setting, as the provider will apply it (a mailer instance's
	// own override is only seen at send time, which still drops the bot).
	const honeypot = get_config().captcha?.honeypot
	const trap = honeypot === false ? undefined : honeypot || HONEYPOT_FIELD
	const honey = trap ? data.get(trap) : null
	if (typeof honey === "string" && honey.trim()) return null
	const { read, result } = await track_reads(data, () =>
		given({ ...submission, field: field_reader(data) })
	)
	if (is_failure<F>(result)) return result
	for (const name of read) {
		if (name.startsWith("_") && !OWN_FIELDS.has(name) && name !== trap) data.delete(name)
	}
	return result ?? ({} as T)
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
export function action<F = { error: string }>(
	options?: ActionOptions | Resolver<ActionOptions, F>
): FormAction<F>
export function action<F = { error: string }>(
	mailer: Mailer,
	options?: ActionOptions | Resolver<ActionOptions, F>
): FormAction<F>
export function action<F>(
	a?: Mailer | ActionOptions | Resolver<ActionOptions, F>,
	b?: ActionOptions | Resolver<ActionOptions, F>
): FormAction<F> {
	const is_mailer = typeof (a as Mailer | undefined)?.send === "function"
	const mailer = is_mailer ? (a as Mailer) : undefined
	const given = is_mailer ? b : (a as ActionOptions | Resolver<ActionOptions, F> | undefined)
	const dispatch = mailer ? (o: SendOptions) => mailer.send(o) : zero_config_mail

	return async (event) => {
		let status = typeof given === "function" ? 400 : (given?.status ?? 400)
		try {
			const body = await event.request.formData()
			const resolved = await resolve(given, { event, data: body })
			if (resolved === null) return { success: true }
			if (is_failure<F>(resolved)) return resolved
			const { status: failure_status = 400, ...fields } = resolved
			status = failure_status
			await dispatch({
				...fields,
				body,
				captcha: with_remoteip(fields.captcha, event),
			} as SendOptions)
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
 * What a remote mail form resolves to: `mail.result` after a submission. `R` is what an
 * `after` hook returned, merged in on a successful send (absent when the honeypot tripped).
 */
export type RemoteResult<R = object> =
	| ({ success: true } & Partial<R>)
	| { success: false; error: string }

/** The remote mail form built by {@link remote} — spread it onto a `<form>` element. */
export type RemoteMailForm<
	Input extends RemoteFormInput = RemoteFormInput,
	R = object,
> = RemoteForm<Input, RemoteResult<R>>

/**
 * A remote form's options, from the submission. As {@link Resolver}, plus `value` (the post as
 * your schema validated it, or as submitted) and `after`: run once the email has gone, and
 * whatever it returns is merged into the form's result, `{ success: true, subscribed }` say.
 * An `after` that throws is your error, not a failed send, so it isn't caught.
 */
export type RemoteResolver<V, R = object> = (submission: {
	event: RequestEvent
	data: FormData
	field: FieldReader
	value: V
}) =>
	| RemoteOptions<R>
	| ActionFailure<unknown>
	| void
	| Promise<RemoteOptions<R> | ActionFailure<unknown> | void>

type RemoteOptions<R> = ActionFields & { after?: () => R | Promise<R> }

/** A Standard Schema over a remote form's fields: valibot, zod, arktype and the rest. */
type Schema = StandardSchemaV1<RemoteFormInput, Record<string, unknown>>

const is_schema = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && "~standard" in value

/** The spam fields a schema gets on top of its own. */
const SPAM_FIELDS = [HONEYPOT_FIELD, TURNSTILE_REMOTE_FIELD]

/**
 * `schema`, but keeping the honeypot and the captcha token. SvelteKit validates a remote form
 * against its schema and drops every field the schema doesn't declare, silently, so a schema
 * written for the form's own fields would switch spam protection off. They're taken out
 * before your schema sees the input and put back on its output.
 */
function with_spam_fields<S extends Schema>(schema: S): S {
	const standard = schema["~standard"]
	return {
		"~standard": {
			...standard,
			validate(input: unknown) {
				const fields = { ...(input as Record<string, unknown>) }
				const spam: Record<string, unknown> = {}
				for (const name of SPAM_FIELDS) {
					if (name in fields) spam[name] = fields[name]
					delete fields[name]
				}
				const keep = (result: StandardSchemaV1.Result<Record<string, unknown>>) =>
					result.issues ? result : { value: { ...result.value, ...spam } }
				const result = standard.validate(fields)
				return result instanceof Promise ? result.then(keep) : keep(result)
			},
		},
	} as S
}

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
			} else if (typeof item === "boolean") {
				// A checkbox left unticked is a row of "false" nobody wants to read; a ticked one
				// says so the way a person would.
				if (item) form.append(name, "Yes")
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
export function remote<R = object>(
	options?: ActionFields | RemoteResolver<RemoteFormInput, R>
): RemoteMailForm<RemoteFormInput, R>
export function remote<R = object>(
	mailer: Mailer,
	options?: ActionFields | RemoteResolver<RemoteFormInput, R>
): RemoteMailForm<RemoteFormInput, R>
export function remote<S extends Schema, R = object>(
	schema: S,
	options?: ActionFields | RemoteResolver<StandardSchemaV1.InferOutput<S>, R>
): RemoteMailForm<StandardSchemaV1.InferInput<S>, R>
export function remote<S extends Schema, R = object>(
	mailer: Mailer,
	schema: S,
	options?: ActionFields | RemoteResolver<StandardSchemaV1.InferOutput<S>, R>
): RemoteMailForm<StandardSchemaV1.InferInput<S>, R>
export function remote(...args: Array<unknown>): RemoteMailForm<RemoteFormInput, object> {
	const mailer =
		typeof (args[0] as Mailer | undefined)?.send === "function"
			? (args.shift() as Mailer)
			: undefined
	const schema = is_schema(args[0]) ? (args.shift() as Schema) : undefined
	const given = args[0] as RemoteOptions<object> | RemoteResolver<unknown, object> | undefined
	const dispatch = mailer ? (o: SendOptions) => mailer.send(o) : zero_config_mail
	const form = sveltekit.form as typeof sveltekit_form | undefined
	if (!form) {
		throw new Error(
			"postboi: remote() needs SvelteKit's $app/server, so it only runs in a .remote.ts file under Vite. Use action() or mail() elsewhere."
		)
	}

	const handler = async (value: RemoteFormInput) => {
		let after: RemoteOptions<object>["after"]
		try {
			const body = remote_form_data(value)
			const resolved = await resolve(given, {
				event: current_request() as RequestEvent,
				data: body,
				value,
			})
			if (resolved === null) return { success: true as const }
			if (is_failure<unknown>(resolved)) {
				const failure = resolved.data as { error?: unknown } | undefined
				const error = typeof failure?.error === "string" ? failure.error : "Invalid submission"
				return { success: false as const, error }
			}
			const { after: then, ...fields } = resolved
			after = then
			await dispatch({
				...fields,
				body,
				captcha: with_remoteip(fields.captcha),
			} as SendOptions)
		} catch (error) {
			// A tripped honeypot pretends to succeed — no email is sent, and the bot learns nothing.
			if (is_spam(error)) return { success: true as const }
			return { success: false as const, error: is_error(error) ? error.message : String(error) }
		}
		// `success` last: an `after` can add to the result, not overrule the send it follows.
		return { ...(await after?.()), success: true as const }
	}

	if (!schema) return form("unchecked", handler)
	// The schema's checks (booleans must be optional, and so on) are SvelteKit's to make on the
	// caller's own schema type; here it's already erased to Schema.
	const checked = form as unknown as (schema: Schema, fn: typeof handler) => unknown
	return checked(with_spam_fields(schema), handler) as RemoteMailForm<RemoteFormInput, object>
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
