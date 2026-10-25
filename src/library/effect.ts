/**
 * `postboi/effect`: Postboi for an Effect program.
 *
 * Everything the package root does, as Effects under the same names: `mail`, `sms` and
 * the other channels wrap the zero-config functions, the thrown `PostboiError` becomes a
 * tagged error you can `catchTag`, and `Mailer` and `Pusher` are services with layers.
 * Nothing here is a second send path; each function, and `Mailer.layer` and
 * `Pusher.layer`, calls the one `mail()` or `push()` everybody else does, so the dev inbox,
 * the hooks and the provider rules behave exactly as documented.
 *
 * It needs `effect` 4 in the app, which the package doesn't list as a dependency. Only this
 * entry imports it; the rest of the package stays dependency-free.
 */
import {
	Config,
	Context,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Schedule,
	Schema,
	type Duration,
} from "effect"
import type { CancelResponse, ProviderBase, SendOptions, FromAddress } from "./index.js"
import type { SmsCheck, SmsOptions, SmsReceipt } from "./sms/types.js"
import type { PushOptions } from "./push/types.js"
import type { PushProvider } from "./push/provider.js"
import type MockPush from "./push/mock.js"
import type { WhatsappOptions } from "./whatsapp/types.js"
import type { ChatOptions } from "./chat/types.js"
import type Mock from "./mock.js"
import {
	FailoverError,
	is_error,
	is_spam,
	SkipSendError,
	SpamError,
	PostboiError as RootPostboiError,
} from "./errors.js"
import {
	mail as root_mail,
	cancel as root_cancel,
	cancel_with,
	resolve_provider,
	send_with,
	with_remoteip,
} from "./mail.js"
import { escape_lines } from "./utils.js"
import { sms as root_sms } from "./sms/send.js"
import { push as root_push } from "./push/send.js"
import { whatsapp as root_whatsapp } from "./whatsapp/send.js"
import * as root_chat from "./chat/send.js"
import { send as fan_out, type FanOutOptions, type SendResult } from "./send.js"
import { retry_after_ms } from "./transport.js"

// ─── Errors ──────────────────────────────────────────────────────────────────

const ChannelSchema = Schema.Literals(["email", "sms", "push", "chat", "whatsapp"])

const ReasonSchema = Schema.Literals([
	"auth",
	"rate_limited",
	"sender",
	"account",
	"recipient",
	"compliance",
	"request",
])

/**
 * The normalised error every provider throws, as a tagged error. Same fields as the
 * class on the package root (`provider`, `channel`, `status`, `code`, `raw`,
 * `outcome_unknown`, `reason`, `retry_after`), so a handler written against one reads the
 * other, and the root's `whatsapp.closed`, `push.expired` and `fails_over` read it too;
 * `_tag` is what `Effect.catchTag` keys on. A failover chain's `FailoverError` is one of
 * these too, with every provider's error in `errors`, and so is an inbox's or a
 * mailbox's `wait()` running out, with its `cursor`, as on the root.
 */
export class PostboiError extends Schema.TaggedError<PostboiError>()("PostboiError", {
	message: Schema.String,
	/** The provider that produced the error, e.g. "resend". */
	provider: Schema.String,
	/** The channel the failure happened on, when one was known. */
	channel: Schema.optional(ChannelSchema),
	/** HTTP status code, when the failure came from a response. */
	status: Schema.optional(Schema.Number),
	/** Provider-specific error code, when available. */
	code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
	/** The original provider error payload (parsed body or thrown cause). */
	raw: Schema.optional(Schema.Defect()),
	/**
	 * Nothing proves the message wasn't sent: a timeout, a dropped connection or a 5xx.
	 * Sending it again can deliver it twice; see {@link retryable}.
	 */
	outcome_unknown: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
	/** Why the provider refused, normalized. Unset on everything but a proven refusal. */
	reason: Schema.optional(ReasonSchema),
	/** Seconds the provider's `Retry-After` asked for, when it answered with one. */
	retry_after: Schema.optional(Schema.Number),
	/**
	 * Where an inbox or a mailbox stood when its `wait()` ran out (`code: "timeout"`): pass
	 * it as `after` to wait on from there.
	 */
	cursor: Schema.optional(Schema.Number),
	/** A failover chain's errors, one per provider in the order they were tried. */
	errors: Schema.optional(
		Schema.Array(Schema.suspend((): Schema.Codec<PostboiError, unknown> => PostboiError))
	),
}) {}

/**
 * A `before.send` hook cancelled the send. Its own tag rather than a `code` on
 * {@link PostboiError}: a skip is an outcome the hook asked for, and a program usually
 * wants to let it through where it would retry or report a real failure.
 */
export class SkipSend extends Schema.TaggedError<SkipSend>()("SkipSend", {
	message: Schema.String,
	/** `skipped`, or whatever the hook threw with. */
	code: Schema.String,
	channel: Schema.optional(ChannelSchema),
}) {}

/** A FormData body tripped the spam checks (the honeypot was filled). */
export class Spam extends Schema.TaggedError<Spam>()("Spam", {
	message: Schema.String,
	channel: Schema.optional(ChannelSchema),
}) {}

/** Everything a send can fail with. */
export type SendError = PostboiError | SkipSend | Spam

/**
 * What a thrown value becomes in the error channel. A `SpamError`, a `SkipSendError` or
 * a `PostboiError` from the package root is the matching tagged error, in that order (the
 * three are a class hierarchy, so the most specific has to be asked first). Anything else
 * is a defect: a bug, not a failure a program is written to handle.
 */
export function from_error(error: unknown): Effect.Effect<never, SendError> {
	if (is_spam(error))
		return Effect.fail(new Spam({ message: error.message, channel: error.channel }))
	if (error instanceof SkipSendError) {
		return Effect.fail(
			new SkipSend({
				message: error.message,
				code: String(error.code ?? "skipped"),
				channel: error.channel,
			})
		)
	}
	if (is_error(error)) return Effect.fail(tagged(error))
	return Effect.die(error)
}

/** The root's error as the tagged one, a chain's errors included. */
function tagged(error: RootPostboiError): PostboiError {
	return new PostboiError({
		message: error.message,
		provider: error.provider,
		channel: error.channel,
		status: error.status,
		code: typeof error.code === "string" || typeof error.code === "number" ? error.code : undefined,
		raw: error.raw,
		outcome_unknown: error.outcome_unknown,
		reason: error.reason,
		retry_after: error.retry_after,
		cursor: "cursor" in error && typeof error.cursor === "number" ? error.cursor : undefined,
		errors: error instanceof FailoverError ? error.errors.map(tagged) : undefined,
	})
}

/**
 * Run any promise-returning call from the package (`mail.lists.create(…)`, a provider's
 * `send`) as an Effect whose failures are the tagged errors above. The send functions
 * below are this applied to the zero-config entry points.
 */
export function tried<A>(run: () => Promise<A>): Effect.Effect<A, SendError> {
	return Effect.tryPromise({ try: run, catch: (error) => error }).pipe(Effect.catch(from_error))
}

// ─── Sends ───────────────────────────────────────────────────────────────────

/**
 * What a send answers with: the provider's own response, as `mail()` returns it. The
 * Postboi provider answers `{ id }` (plus `sandbox` and `claim_url` while the account is
 * unclaimed); every other provider answers its own shape, which is why this is `unknown`
 * rather than a promise the SDK can't keep for all of them.
 */
export type SendResponse = unknown

/** Send an email through whatever `mail()` is configured to send with. */
export const mail = Effect.fn("postboi.mail")((options: SendOptions) =>
	tried<SendResponse>(() => root_mail(options))
)

/** Cancel a scheduled email by the id its send answered with. */
export const cancel = Effect.fn("postboi.cancel")((id: string) =>
	tried<CancelResponse>(() => root_cancel(id))
)

/**
 * Send a text through the configured SMS provider, or down its failover chain. Every SMS
 * provider answers the same `SmsReceipt` (`id`, `ids`, `provider`, `delivery`).
 */
export const sms = Object.assign(
	Effect.fn("postboi.sms")((options: SmsOptions) => tried<SmsReceipt>(() => root_sms(options))),
	{
		/**
		 * Check a text against the configured SMS provider without sending it, as the root's
		 * `sms.validate()` does: numbers, encoding, segments and every problem a send would
		 * refuse it for. Fails only when no provider can be resolved.
		 */
		validate: Effect.fn("postboi.sms.validate")((options: SmsOptions) =>
			tried<SmsCheck>(() => root_sms.validate(options))
		),
	}
)

/**
 * Send a push notification through the configured push provider. `push.expired(error)`
 * is the root's: did the push service say this target is dead?
 */
export const push = Object.assign(
	Effect.fn("postboi.push")((options: PushOptions) =>
		tried<SendResponse>(() => root_push(options))
	),
	{ expired: root_push.expired }
)

/** Send a WhatsApp message through the configured WhatsApp provider. */
export const whatsapp = Effect.fn("postboi.whatsapp")((options: WhatsappOptions) =>
	tried<SendResponse>(() => root_whatsapp(options))
)

// Chat is one function per platform, as on the package root: you always know which
// platform you are posting to, so the platform is the name.

/** Post to Slack. */
export const slack = Effect.fn("postboi.slack")((options: ChatOptions) =>
	tried<SendResponse>(() => root_chat.slack(options))
)

/** Post to Discord. */
export const discord = Effect.fn("postboi.discord")((options: ChatOptions) =>
	tried<SendResponse>(() => root_chat.discord(options))
)

/** Post to Microsoft Teams. */
export const teams = Effect.fn("postboi.teams")((options: ChatOptions) =>
	tried<SendResponse>(() => root_chat.teams(options))
)

/** Send a Telegram message. */
export const telegram = Effect.fn("postboi.telegram")((options: ChatOptions) =>
	tried<SendResponse>(() => root_chat.telegram(options))
)

/** Post to Bluesky. */
export const bluesky = Effect.fn("postboi.bluesky")((options: ChatOptions) =>
	tried<SendResponse>(() => root_chat.bluesky(options))
)

/**
 * The multi-channel `send()`: fan out to every channel in `to`, or walk a fallback chain.
 * Per-channel outcomes are in the result rather than the error channel, exactly as the
 * promise version resolves; only a send that could not be attempted at all fails.
 */
export const send = Effect.fn("postboi.send")((options: FanOutOptions) =>
	tried<SendResult>(() => fan_out(options))
)

// ─── Mailer service ──────────────────────────────────────────────────────────

/** `POSTBOI_PROVIDER` and `POSTBOI_TOKEN` from `Config`, as `mail()`'s overrides. */
const config_env = Effect.gen(function* () {
	const provider = yield* Config.option(Config.String("POSTBOI_PROVIDER"))
	const token = yield* Config.option(Config.Redacted("POSTBOI_TOKEN"))
	return {
		POSTBOI_PROVIDER: Option.getOrUndefined(provider),
		POSTBOI_TOKEN: Option.getOrUndefined(Option.map(token, Redacted.value)),
	}
}).pipe(
	// A config value that is present is always a readable string, so the only way
	// Config can fail here is a provider that cannot be read at all, which is a bug
	// in the program's wiring rather than a failure a send handler should see.
	Effect.catchTag("ConfigError", (error) => Effect.die(error))
)

/**
 * Email as a service. `Mailer.layer` sends through `mail()` itself, resolving the provider
 * on every send; `Mailer.layerStrict` does the same but fails the layer when no provider
 * resolves; `Mailer.layerProvider` wraps one you constructed (`new Resend({ … })`), and
 * `Mailer.layerMock` a recording mock for tests.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Mailer } from "postboi/effect"
 *
 * const program = Effect.gen(function* () {
 * 	const mailer = yield* Mailer
 * 	return yield* mailer.send({ to: "ada@example.com", subject: "Hi", body: "<p>Hello</p>" })
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(Mailer.layer)))
 * ```
 */
export class Mailer extends Context.Service<
	Mailer,
	{
		send(options: SendOptions): Effect.Effect<SendResponse, SendError>
		cancel(id: string): Effect.Effect<CancelResponse, SendError>
	}
>()("postboi/effect/Mailer") {
	/**
	 * A `Mailer` over a provider you constructed yourself. Every send goes to that provider,
	 * so it skips what `mail()` decides per send: the dev inbox, `mail({ test })`, and a
	 * provider or credential that changed since. The provider's own hooks and captcha check
	 * still run.
	 */
	static layerProvider(provider: ProviderBase<unknown>): Layer.Layer<Mailer> {
		return Layer.succeed(Mailer, service_over(provider))
	}

	/**
	 * Sends through `mail()`, so each send resolves the provider the way `mail()` does: the
	 * config file's `provider`, each provider's own credential, and the dev inbox and the
	 * console mock in development, all read when the send runs.
	 *
	 * `POSTBOI_PROVIDER` and `POSTBOI_TOKEN` are read through `Config` when the layer is
	 * built, so an app's own `ConfigProvider` can supply them; a value it gives beats the
	 * environment. The layer always builds. When nothing resolves, each send fails with the
	 * {@link PostboiError} `mail()` would throw (`no_provider`, `no_token` or `missing_env`).
	 */
	static readonly layer: Layer.Layer<Mailer> = Layer.effect(
		Mailer,
		Effect.map(config_env, service_through_mail)
	)

	/**
	 * {@link Mailer.layer}, but building it checks that a provider resolves, and a missing
	 * credential fails the layer with the {@link PostboiError} a send would get. For a script
	 * or a worker that should stop at start rather than at its first send. Sends still go
	 * through `mail()`, each resolving the provider again.
	 */
	static readonly layerStrict: Layer.Layer<Mailer, SendError> = Layer.effect(
		Mailer,
		Effect.gen(function* () {
			const env = yield* config_env
			yield* tried(() => resolve_provider({ intercept: true, env }))
			return service_through_mail(env)
		})
	)

	/**
	 * A `Mailer` over the recording mock from `postboi/mock`, for tests. Pass your own
	 * instance to read `mock.sent` and `mock.last` back; without one a silent mock with a
	 * placeholder `from` is built, for a test that only needs nothing to leave the process.
	 */
	static layerMock(mock?: Mock): Layer.Layer<Mailer> {
		return Layer.unwrap(
			Effect.gen(function* () {
				const instance =
					mock ??
					new (yield* Effect.promise(() => import("./mock.js").then((m) => m.default)))({
						default: { from: "Postboi tests <tests@postboi.invalid>" as FromAddress },
					})
				return Mailer.layerProvider(instance)
			})
		)
	}
}

/**
 * The visitor's IP for captcha verification, read when `send` is called rather than when
 * the Effect runs, so SvelteKit can still answer `getRequestEvent()`.
 */
function with_ip(options: SendOptions): SendOptions {
	const captcha = with_remoteip(options.captcha)
	return captcha === options.captcha ? options : { ...options, captcha }
}

function service_through_mail(env: Record<string, string | undefined>): Mailer["Service"] {
	return Mailer.of({
		send(options) {
			const sent = with_ip(options)
			return tried<SendResponse>(() => send_with(env, sent))
		},
		cancel: (id) => tried(() => cancel_with(env, id)),
	})
}

function service_over(provider: ProviderBase<unknown>): Mailer["Service"] {
	return Mailer.of({
		send(options) {
			const sent = with_ip(options)
			return tried<SendResponse>(() => provider.send(sent))
		},
		cancel: (id) => tried(() => provider.cancel(id)),
	})
}

// ─── Pusher service ──────────────────────────────────────────────────────────

/**
 * Push as a service, the way {@link Mailer} is email. `Pusher.layer` sends through
 * `push()`, resolving the provider on every send; `Pusher.layerProvider` wraps one you
 * constructed (`new WebPush({ … })`), and `Pusher.layerMock` the recording mock from
 * `postboi/push-mock`.
 */
export class Pusher extends Context.Service<
	Pusher,
	{ send(options: PushOptions): Effect.Effect<SendResponse, SendError> }
>()("postboi/effect/Pusher") {
	/** A `Pusher` over a push provider you constructed yourself. */
	static layerProvider(provider: PushProvider<unknown>): Layer.Layer<Pusher> {
		return Layer.succeed(
			Pusher,
			Pusher.of({ send: (options) => tried(() => provider.send(options)) })
		)
	}

	/** Sends through `push()`, which resolves the push provider on every send. */
	static readonly layer: Layer.Layer<Pusher> = Layer.succeed(Pusher, Pusher.of({ send: push }))

	/**
	 * A `Pusher` over the recording mock from `postboi/push-mock`, for tests. Pass your own
	 * instance to read `mock.sent` back, or one made with `{ expired: true }` to test the
	 * handling of a dead subscription.
	 */
	static layerMock(mock?: MockPush): Layer.Layer<Pusher> {
		return Layer.unwrap(
			Effect.gen(function* () {
				const instance =
					mock ??
					new (yield* Effect.promise(() => import("./push/mock.js").then((m) => m.default)))()
				return Pusher.layerProvider(instance)
			})
		)
	}
}

// ─── Promise code ────────────────────────────────────────────────────────────

/**
 * The tagged error as the package root's class, so promise code can catch it with
 * `instanceof PostboiError`, `SkipSendError` or `SpamError` from `postboi`. Anything else
 * comes back as it was.
 */
export function root_error(error: unknown): unknown {
	if (error instanceof Spam)
		return Object.assign(new SpamError(error.message), { channel: error.channel })
	if (error instanceof SkipSend) {
		return Object.assign(new SkipSendError(error.message, error.code), { channel: error.channel })
	}
	if (error instanceof PostboiError) return untagged(error)
	return error
}

function untagged(error: PostboiError): RootPostboiError {
	const root = error.errors
		? new FailoverError(error.errors.map(untagged))
		: new RootPostboiError({
				message: error.message,
				provider: error.provider,
				channel: error.channel,
				status: error.status,
				code: error.code,
				raw: error.raw,
				outcome_unknown: error.outcome_unknown,
				reason: error.reason,
				retry_after: error.retry_after,
			})
	return error.cursor === undefined ? root : Object.assign(root, { cursor: error.cursor })
}

/** What {@link promise_runtime} answers. */
export interface PromiseRuntime<R> {
	/** Run an Effect to a promise. A failure rejects with the root's error class. */
	run<A, E>(effect: Effect.Effect<A, E, R>): Promise<A>
	/** Run against another layer from now on (a test's mock), or the original with none. */
	use(layer?: Layer.Layer<R>): void
	/** Release what the layer built. */
	dispose(): Promise<void>
}

/**
 * Run Effects from promise code, for an app that keeps promise exports over its Effect
 * forms. The layer (`Mailer.layer` unless you pass one) is built once, on the first `run`,
 * and `use` swaps it, so a test can point the promise exports at `Mailer.layerMock(mock)`.
 *
 * @example
 * ```ts
 * import { promise_runtime } from "postboi/effect"
 *
 * const mailer = promise_runtime()
 * export const send_welcome = (to: string) => mailer.run(welcome(to))
 *
 * // In a test:
 * mailer.use(Mailer.layerMock(mock))
 * ```
 */
export function promise_runtime<R = Mailer>(
	layer: Layer.Layer<R> = Mailer.layer as unknown as Layer.Layer<R>
): PromiseRuntime<R> {
	let current = layer
	let runtime: ManagedRuntime.ManagedRuntime<R, never> | undefined
	return {
		run(effect) {
			runtime ??= ManagedRuntime.make(current)
			return runtime.runPromise(effect).catch((error: unknown) => {
				throw root_error(error)
			})
		},
		use(next) {
			void runtime?.dispose()
			runtime = undefined
			current = next ?? layer
		},
		async dispose() {
			const disposing = runtime
			runtime = undefined
			await disposing?.dispose()
		},
	}
}

// ─── Wire shapes ─────────────────────────────────────────────────────────────

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))
const Address = NonEmpty
// A list of addresses has to hold one: `to: []` is a send to nobody, and refusing it at
// the door says so in the request's own words rather than in a provider's.
const Addresses = Schema.Union([
	Address,
	Schema.Array(Address).pipe(Schema.check(Schema.isNonEmpty())),
])

/**
 * The subset of {@link SendOptions} a server can accept over the wire: a request to send,
 * as a form post or a JSON body would carry it. Deliberately not the whole of
 * `SendOptions`, which carries functions, `FormData` and promises that have no wire form.
 * Decode it with `decode_send_request` and hand the result to {@link send_options}.
 *
 * Whoever sends one picks the recipients, the sender and the content, so accept it only
 * from callers you trust. A public form posts `FormData` to `mail` instead, which
 * ignores a posted `_to`, `_cc`, `_bcc` or `_from` unless the send sets `form_addressing`.
 *
 * An address here is a non-empty string in whatever form `mail()` accepts
 * (`ada@example.com`, `Ada <ada@example.com>`, or a comma-separated list); the provider
 * parses and rejects it as it would any other send. `idempotency_key` and `in_reply_to`
 * are passed through as they are: a key for the providers that deduplicate on one, and
 * the `in_…` id of a received message the send answers.
 */
export const SendRequest = Schema.Struct({
	to: Schema.optionalKey(Addresses),
	from: Schema.optionalKey(Address),
	reply_to: Schema.optionalKey(Addresses),
	cc: Schema.optionalKey(Addresses),
	bcc: Schema.optionalKey(Addresses),
	subject: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String),
	html: Schema.optionalKey(Schema.String),
	headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	idempotency_key: Schema.optionalKey(NonEmpty),
	in_reply_to: Schema.optionalKey(NonEmpty),
}).pipe(
	Schema.check(
		Schema.makeFilter((request) =>
			request.html || request.text ? true : "a send needs html or text"
		)
	)
)

/** A decoded {@link SendRequest}. */
export type SendRequest = typeof SendRequest.Type

/** Decode an unknown value (a parsed JSON body) into a {@link SendRequest}. */
export const decode_send_request = Schema.decodeUnknownEffect(SendRequest)

/**
 * Turn a decoded {@link SendRequest} into the options `mail` (or `Mailer.send`)
 * takes. `html` is the body; a text-only request keeps its text as the plain-text part
 * and sends it as the body too, escaped with its line breaks kept (`escape_lines`),
 * because a string `body` is always HTML to a provider: raw, a `<` or an `&` in the
 * text would be read as markup and a line break would collapse into a space.
 */
export function send_options(request: SendRequest): SendOptions {
	const options: SendOptions = {
		body: request.html || escape_lines(request.text ?? ""),
	}
	if (request.to !== undefined) options.to = plural(request.to)
	if (request.from !== undefined) options.from = request.from as FromAddress
	if (request.reply_to !== undefined) options.reply_to = plural(request.reply_to)
	if (request.cc !== undefined) options.cc = plural(request.cc)
	if (request.bcc !== undefined) options.bcc = plural(request.bcc)
	if (request.subject !== undefined) options.subject = request.subject
	if (request.text !== undefined) options.text = request.text
	if (request.headers !== undefined) options.headers = { ...request.headers }
	if (request.tags !== undefined) options.tags = [...request.tags]
	if (request.idempotency_key !== undefined) options.idempotency_key = request.idempotency_key
	if (request.in_reply_to !== undefined) options.in_reply_to = request.in_reply_to
	return options
}

/** `SendOptions` wants mutable arrays where a decoded schema answers readonly ones. */
function plural(value: string | ReadonlyArray<string>): string | Array<string> {
	return typeof value === "string" ? value : [...value]
}

// ─── Retry ───────────────────────────────────────────────────────────────────

/**
 * Is this a failure worth trying again? The transport's response rule, restated for the
 * error channel. A 429 always is: the provider refused and said to come back. A 5xx, a
 * timeout or a dropped connection is only when it proves nothing went out, which is what
 * `outcome_unknown: false` says (a read, say); with `outcome_unknown: true` the provider
 * may already have the message, and sending again can deliver it twice, so those are
 * retried only when `retry_unknown` says so, as the transport's option of the same name
 * does, and only for a 5xx, a timeout or a dropped connection, never for a batch the
 * provider took part of. Pass it when the send carries an `idempotency_key` the provider
 * deduplicates on.
 *
 * A 4xx is the request's fault and comes back the same way; a skip or a spam verdict was
 * asked for; and an error with no status and no unknown outcome is not retried here,
 * because a refusal before any request (`no_provider`, a missing credential) arrives that
 * way, and so does a read whose connection dropped, which only the transport can tell
 * apart. Its `retries` option is what retries those.
 */
export function retryable(error: unknown, retry_unknown = false): boolean {
	if (!(error instanceof PostboiError)) return false
	if (error.status === 429) return true
	if (error.outcome_unknown) {
		return retry_unknown && (error.status === undefined || error.status >= 500)
	}
	return error.status !== undefined && error.status >= 500
}

/** What {@link with_retry} takes. */
export interface RetryOptions {
	/** How many times to try again after the first failure. Defaults to 2. */
	times?: number
	/** The first delay; each one after it doubles. Defaults to 500 milliseconds. */
	base?: Duration.Input
	/**
	 * Retry a failure whose outcome is unknown too (a 5xx, a timeout or a dropped
	 * connection on a send). Only safe when the send carries an `idempotency_key` the
	 * provider deduplicates on; see {@link retryable}. Defaults to false.
	 */
	retry_unknown?: boolean
}

/**
 * Retry a send on the failures a provider might answer differently next time: a 429, a
 * 5xx that proves nothing was sent, and with `retry_unknown` an unknown outcome as well.
 * Exponential backoff from `base`, at most `times` more attempts, and any other failure
 * fails at once. When the provider answered with a `Retry-After`, the next attempt waits
 * that long instead (at most a minute, as the transport waits).
 *
 * This and the provider's own `retries` option overlap, so pick one. The provider retries
 * the HTTP request inside the send, before hooks see an error; this retries the whole
 * Effect, hooks included. Setting both stacks them, so a `retries: 2` provider inside a
 * `with_retry` of 2 makes up to nine requests. A form send with a captcha needs the
 * provider's `retries`: a retry here checks its Turnstile token again, and the first
 * check used it up.
 */
export function with_retry<A, E, R>(
	effect: Effect.Effect<A, E, R>,
	{ times = 2, base = "500 millis", retry_unknown = false }: RetryOptions = {}
): Effect.Effect<A, E, R> {
	return effect.pipe(
		Effect.retry({
			while: (error) => retryable(error, retry_unknown),
			schedule: Schedule.max([Schedule.exponential(base), Schedule.recurs(times)]).pipe(
				Schedule.modifyDelay(({ input, duration }) =>
					Effect.succeed<Duration.Input>(
						(input instanceof PostboiError ? retry_after_ms(input.retry_after) : undefined) ??
							duration
					)
				)
			),
		})
	)
}
