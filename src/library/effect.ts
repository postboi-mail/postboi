/**
 * `postboi/effect`: Postboi for an Effect program.
 *
 * Everything the package root does, as Effects: `send_mail` and the other channels wrap
 * the zero-config functions, the thrown `PostboiError` becomes a tagged error you can
 * `catchTag`, and `Mailer` is a service with a layer read from `Config`. Nothing
 * here is a second send path; each function calls the one `mail()` everybody else does,
 * so the dev inbox, the hooks and the provider rules behave exactly as documented.
 *
 * `effect` is an optional peer dependency. Only this entry imports it; the rest of the
 * package stays dependency-free.
 */
import {
	Config,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Schedule,
	Schema,
	type Duration,
} from "effect"
import type { CancelResponse, ProviderBase, SendOptions, FromAddress } from "./index.js"
import type { SmsCheck, SmsOptions, SmsReceipt } from "./sms/types.js"
import type { PushOptions } from "./push/types.js"
import type { WhatsappOptions } from "./whatsapp/types.js"
import type { ChatOptions } from "./chat/types.js"
import type Mock from "./mock.js"
import {
	FailoverError,
	is_error,
	is_spam,
	SkipSendError,
	type PostboiError as RootPostboiError,
} from "./errors.js"
import { mail, cancel, resolve_provider, with_remoteip } from "./mail.js"
import { escape_lines } from "./utils.js"
import { sms } from "./sms/send.js"
import { push } from "./push/send.js"
import { whatsapp } from "./whatsapp/send.js"
import { slack, discord, teams, telegram, bluesky } from "./chat/send.js"
import { send as fan_out, type FanOutOptions, type SendResult } from "./send.js"

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
 * `outcome_unknown`, `reason`), so a handler written against one reads the other; `_tag`
 * is what `Effect.catchTag` keys on. A failover chain's `FailoverError` is one of these
 * too, with every provider's error in `errors`, as on the root.
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
	raw: Schema.optional(Schema.Unknown),
	/**
	 * Nothing proves the message wasn't sent: a timeout, a dropped connection or a 5xx.
	 * Sending it again can deliver it twice; see {@link retryable}.
	 */
	outcome_unknown: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
	/** Why the provider refused, normalized. Unset on everything but a proven refusal. */
	reason: Schema.optional(ReasonSchema),
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
		code: error.code,
		raw: error.raw,
		outcome_unknown: error.outcome_unknown,
		reason: error.reason,
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
export const send_mail = Effect.fn("postboi.send_mail")((options: SendOptions) =>
	tried<SendResponse>(() => mail(options))
)

/** Cancel a scheduled email by the id its send answered with. */
export const cancel_mail = Effect.fn("postboi.cancel_mail")((id: string) =>
	tried<CancelResponse>(() => cancel(id))
)

/**
 * Send a text through the configured SMS provider, or down its failover chain. Every SMS
 * provider answers the same `SmsReceipt` (`id`, `ids`, `provider`, `delivery`).
 */
export const send_sms = Effect.fn("postboi.send_sms")((options: SmsOptions) =>
	tried<SmsReceipt>(() => sms(options))
)

/**
 * Check a text against the configured SMS provider without sending it, as
 * `sms.validate()` does: numbers, encoding, segments and every problem a send would
 * refuse it for. Fails only when no provider can be resolved.
 */
export const validate_sms = Effect.fn("postboi.validate_sms")((options: SmsOptions) =>
	tried<SmsCheck>(() => sms.validate(options))
)

/** Send a push notification through the configured push provider. */
export const send_push = Effect.fn("postboi.send_push")((options: PushOptions) =>
	tried<SendResponse>(() => push(options))
)

/** Send a WhatsApp message through the configured WhatsApp provider. */
export const send_whatsapp = Effect.fn("postboi.send_whatsapp")((options: WhatsappOptions) =>
	tried<SendResponse>(() => whatsapp(options))
)

// Chat is one function per platform, as on the package root: you always know which
// platform you are posting to, so the platform is the name.

/** Post to Slack. */
export const send_slack = Effect.fn("postboi.send_slack")((options: ChatOptions) =>
	tried<SendResponse>(() => slack(options))
)

/** Post to Discord. */
export const send_discord = Effect.fn("postboi.send_discord")((options: ChatOptions) =>
	tried<SendResponse>(() => discord(options))
)

/** Post to Microsoft Teams. */
export const send_teams = Effect.fn("postboi.send_teams")((options: ChatOptions) =>
	tried<SendResponse>(() => teams(options))
)

/** Send a Telegram message. */
export const send_telegram = Effect.fn("postboi.send_telegram")((options: ChatOptions) =>
	tried<SendResponse>(() => telegram(options))
)

/** Post to Bluesky. */
export const send_bluesky = Effect.fn("postboi.send_bluesky")((options: ChatOptions) =>
	tried<SendResponse>(() => bluesky(options))
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

/**
 * The provider as a service. `Mailer.layer` resolves it once, from `Config`, the way
 * `mail()` would on every call; `Mailer.layerProvider` wraps one you constructed
 * (`new Resend({ … })`), and `Mailer.layerMock` a recording mock for tests.
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
	/** A `Mailer` over a provider you constructed yourself. */
	static layerProvider(provider: ProviderBase<unknown>): Layer.Layer<Mailer> {
		return Layer.succeed(Mailer, service_over(provider))
	}

	/**
	 * The provider `mail()` would pick, resolved once when the layer is built.
	 *
	 * `POSTBOI_PROVIDER` and `POSTBOI_TOKEN` are read through `Config`, so an app's own
	 * `ConfigProvider` can supply them; a value it gives beats the environment. Everything
	 * else about the choice (the config file's `provider`, each provider's own credential,
	 * the dev inbox and the console mock in development) is the package's one rule, shared
	 * with `mail()` rather than restated here. A missing credential fails the layer with a
	 * {@link PostboiError} carrying `no_provider`, `no_token` or `missing_env`, as a send
	 * from `mail()` would.
	 */
	static readonly layer: Layer.Layer<Mailer, SendError> = Layer.unwrap(
		Effect.gen(function* () {
			const provider = yield* Config.option(Config.String("POSTBOI_PROVIDER"))
			const token = yield* Config.option(Config.Redacted("POSTBOI_TOKEN"))
			const resolved = yield* tried(() =>
				resolve_provider({
					intercept: true,
					env: {
						POSTBOI_PROVIDER: Option.getOrUndefined(provider),
						POSTBOI_TOKEN: Option.getOrUndefined(Option.map(token, Redacted.value)),
					},
				})
			)
			return Mailer.layerProvider(resolved)
		}).pipe(
			// A config value that is present is always a readable string, so the only way
			// Config can fail here is a provider that cannot be read at all, which is a bug
			// in the program's wiring rather than a failure a send handler should see.
			Effect.catchTag("ConfigError", (error) => Effect.die(error))
		)
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
 * The service over one provider. `send` fills in the visitor's IP for captcha
 * verification exactly as `mail()` does, read before the first await so SvelteKit can
 * still answer `getRequestEvent()`; a `Mailer` send inside a form action otherwise
 * verified Turnstile without the IP `mail()` would have sent.
 */
function service_over(provider: ProviderBase<unknown>): Mailer["Service"] {
	return Mailer.of({
		send(options) {
			const captcha = with_remoteip(options.captcha)
			const sent = captcha === options.captcha ? options : { ...options, captcha }
			return tried<SendResponse>(() => provider.send(sent))
		},
		cancel: (id) => tried(() => provider.cancel(id)),
	})
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
			request.html !== undefined || request.text !== undefined ? true : "a send needs html or text"
		)
	)
)

/** A decoded {@link SendRequest}. */
export type SendRequest = typeof SendRequest.Type

/** Decode an unknown value (a parsed JSON body) into a {@link SendRequest}. */
export const decode_send_request = Schema.decodeUnknownEffect(SendRequest)

/**
 * Turn a decoded {@link SendRequest} into the options `send_mail` (or `Mailer.send`)
 * takes. `html` is the body; a text-only request keeps its text as the plain-text part
 * and sends it as the body too, escaped with its line breaks kept (`escape_lines`),
 * because a string `body` is always HTML to a provider: raw, a `<` or an `&` in the
 * text would be read as markup and a line break would collapse into a space.
 */
export function send_options(request: SendRequest): SendOptions {
	const options: SendOptions = {
		body: request.html ?? escape_lines(request.text ?? ""),
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
 * does. Pass it when the send carries an `idempotency_key` the provider deduplicates on.
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
	if (error.outcome_unknown) return retry_unknown
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
 * fails at once.
 *
 * This and the provider's own `retries` option overlap, so pick one. The provider retries
 * the HTTP request inside the send, before hooks see an error; this retries the whole
 * Effect, hooks included. Setting both stacks them, so a `retries: 2` provider inside a
 * `with_retry` of 2 makes up to nine requests.
 */
export function with_retry<A, E, R>(
	effect: Effect.Effect<A, E, R>,
	{ times = 2, base = "500 millis", retry_unknown = false }: RetryOptions = {}
): Effect.Effect<A, E, R> {
	return effect.pipe(
		Effect.retry({
			while: (error) => retryable(error, retry_unknown),
			schedule: Schedule.max([Schedule.exponential(base), Schedule.recurs(times)]),
		})
	)
}
