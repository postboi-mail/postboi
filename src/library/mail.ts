import type {
	SendOptions,
	TestSendOptions,
	BatchOptions,
	BatchData,
	Email,
	BatchResult,
	CancelResponse,
	ProviderBase,
} from "./index.js"
import type { HostedTest } from "./inspect/hosted.js"
import { PostboiError } from "./index.js"
// Type-only — erased at compile time, so the provider module stays a dynamic-only leaf
// (see the LOADERS note below).
import type Postboi from "./postboi_provider.js"
import { find_provider, scoped_options } from "./registry.js"
import { load_config, type PostboiConfig } from "./config.js"
import { ensure_env_loaded, env_defaults, is_development, read_env } from "./env.js"
import { resolve_inbox } from "./inbox.js"

type ProviderConstructor = new (options: Record<string, unknown>) => ProviderBase<unknown>

/**
 * Lazy loaders for every configurable provider, keyed by `POSTBOI_PROVIDER`. Using explicit
 * dynamic imports keeps each provider in its own chunk — `mail()` only loads the one in use.
 */
const LOADERS: Record<string, () => Promise<ProviderConstructor>> = {
	resend: () => import("./resend.js").then((m) => m.default as unknown as ProviderConstructor),
	postmark: () => import("./postmark.js").then((m) => m.default as unknown as ProviderConstructor),
	sendgrid: () => import("./sendgrid.js").then((m) => m.default as unknown as ProviderConstructor),
	mailgun: () => import("./mailgun.js").then((m) => m.default as unknown as ProviderConstructor),
	brevo: () => import("./brevo.js").then((m) => m.default as unknown as ProviderConstructor),
	cloudflare: () =>
		import("./cloudflare.js").then((m) => m.default as unknown as ProviderConstructor),
	mailersend: () =>
		import("./mailersend.js").then((m) => m.default as unknown as ProviderConstructor),
	sparkpost: () =>
		import("./sparkpost.js").then((m) => m.default as unknown as ProviderConstructor),
	mandrill: () => import("./mandrill.js").then((m) => m.default as unknown as ProviderConstructor),
	plunk: () => import("./plunk.js").then((m) => m.default as unknown as ProviderConstructor),
	mailtrap: () => import("./mailtrap.js").then((m) => m.default as unknown as ProviderConstructor),
	mailjet: () => import("./mailjet.js").then((m) => m.default as unknown as ProviderConstructor),
	elasticemail: () =>
		import("./elasticemail.js").then((m) => m.default as unknown as ProviderConstructor),
	mailpace: () => import("./mailpace.js").then((m) => m.default as unknown as ProviderConstructor),
	lettermint: () =>
		import("./lettermint.js").then((m) => m.default as unknown as ProviderConstructor),
	unosend: () => import("./unosend.js").then((m) => m.default as unknown as ProviderConstructor),
	sequenzy: () => import("./sequenzy.js").then((m) => m.default as unknown as ProviderConstructor),
	loops: () => import("./loops.js").then((m) => m.default as unknown as ProviderConstructor),
	mailchannels: () =>
		import("./mailchannels.js").then((m) => m.default as unknown as ProviderConstructor),
	smtp2go: () => import("./smtp2go.js").then((m) => m.default as unknown as ProviderConstructor),
	socketlabs: () =>
		import("./socketlabs.js").then((m) => m.default as unknown as ProviderConstructor),
	azure: () => import("./azure.js").then((m) => m.default as unknown as ProviderConstructor),
	gmail: () => import("./gmail.js").then((m) => m.default as unknown as ProviderConstructor),
	maileroo: () => import("./maileroo.js").then((m) => m.default as unknown as ProviderConstructor),
	ahasend: () => import("./ahasend.js").then((m) => m.default as unknown as ProviderConstructor),
	postal: () => import("./postal.js").then((m) => m.default as unknown as ProviderConstructor),
	customerio: () =>
		import("./customerio.js").then((m) => m.default as unknown as ProviderConstructor),
	infobip: () => import("./infobip.js").then((m) => m.default as unknown as ProviderConstructor),
	sendpulse: () =>
		import("./sendpulse.js").then((m) => m.default as unknown as ProviderConstructor),
	iterable: () => import("./iterable.js").then((m) => m.default as unknown as ProviderConstructor),
	jetemail: () => import("./jetemail.js").then((m) => m.default as unknown as ProviderConstructor),
	lettr: () => import("./lettr.js").then((m) => m.default as unknown as ProviderConstructor),
	primitive: () =>
		import("./primitive.js").then((m) => m.default as unknown as ProviderConstructor),
	scaleway: () => import("./scaleway.js").then((m) => m.default as unknown as ProviderConstructor),
	ses: () => import("./ses.js").then((m) => m.default as unknown as ProviderConstructor),
	microsoft365: () =>
		import("./microsoft365.js").then((m) => m.default as unknown as ProviderConstructor),
	smtp: () => import("./smtp.js").then((m) => m.default as unknown as ProviderConstructor),
	zepto: () => import("./zepto.js").then((m) => m.default as unknown as ProviderConstructor),
	netcore: () => import("./netcore.js").then((m) => m.default as unknown as ProviderConstructor),
	klaviyo: () => import("./klaviyo.js").then((m) => m.default as unknown as ProviderConstructor),
	hubspot: () => import("./hubspot.js").then((m) => m.default as unknown as ProviderConstructor),
	onesignal: () =>
		import("./onesignal.js").then((m) => m.default as unknown as ProviderConstructor),
	alibaba: () => import("./alibaba.js").then((m) => m.default as unknown as ProviderConstructor),
	yandex: () => import("./yandex.js").then((m) => m.default as unknown as ProviderConstructor),
	// The Postboi provider. Not in the registry (its only credential is POSTBOI_TOKEN, which the
	// provider reads itself) — a token in the environment routes send() here automatically.
	// NB: the leaf module, not the package root — a dynamic import of a module that is also
	// statically imported (the root is, via `postboi/kit`) merges it into the consumer's entry
	// chunk and adds an extra export SvelteKit's route validator rejects.
	postboi: () =>
		import("./postboi_provider.js").then((m) => m.default as unknown as ProviderConstructor),
	// Credential-free no-op — handy as a safe local default (`provider: "mock"`) that records
	// instead of sending. Deliberately absent from the registry so `postboi init` won't offer it.
	mock: () => import("./mock.js").then((m) => m.default as unknown as ProviderConstructor),
}

let warned_shadowed_from = false
let warned_dev_fallback = false
let announced_inbox = false

/**
 * The local dev inbox standing in for whatever is configured, or null when none is
 * listening. Deliberately outranks a fully-credentialled provider: a laptop shouldn't be
 * able to mail a real customer by accident, which is the entire reason tools like Mailpit
 * exist. Running the inbox is the opt-in; `dev: { inbox: false }` or `POSTBOI_INBOX=off`
 * is the way back out.
 */
async function resolve_dev_inbox(config: PostboiConfig): Promise<ProviderBase<unknown> | null> {
	if (!is_development() || config.dev?.inbox === false) return null
	const inbox = await resolve_inbox()
	if (!inbox) return null
	if (!announced_inbox) {
		announced_inbox = true
		console.log(`postboi: capturing mail in the dev inbox — read it at ${inbox.url}`)
	}
	const Mock = await import("./mock.js").then((m) => m.default)
	return new Mock({ sink: inbox.deliver, on_cancel: inbox.cancel, default: env_defaults() })
}

/**
 * Construct the provider named by `POSTBOI_PROVIDER` from environment variables.
 *
 * `intercept` is set on the send path only. The `mail.lists` / `mail.contacts` namespaces
 * resolve without it, so managing an audience in dev still talks to the real API — it's
 * sending that we stand in front of, not everything the token can do.
 */
async function resolve_provider({ intercept = false } = {}): Promise<ProviderBase<unknown>> {
	// Load global config (postboi.config.ts / package.json) first, so hooks and the
	// `provider` fallback are available; ProviderBase merges the rest at construction.
	const config = await load_config()
	// Make `.env` values visible in dev (SvelteKit etc. don't put them on process.env).
	await ensure_env_loaded()

	// Before any credential is looked at: with an inbox open, what's configured doesn't
	// matter, and neither does a missing credential.
	if (intercept) {
		const inbox = await resolve_dev_inbox(config)
		if (inbox) return inbox
	}

	// The classic trap: a leftover POSTBOI_FROM silently beats the committed config
	// default. Say so once instead of sending from the wrong address in silence.
	const env_from = read_env("POSTBOI_FROM")
	const config_from = config.default?.from
	if (env_from && typeof config_from === "string" && env_from !== config_from) {
		if (!warned_shadowed_from) {
			warned_shadowed_from = true
			console.warn(
				`postboi: POSTBOI_FROM (${env_from}) overrides default.from in postboi.config (${config_from}) — remove one of them.`
			)
		}
	}
	// A POSTBOI_TOKEN alone is enough to send: with nothing else configured, dispatch to
	// The Postboi provider — the zero-config path `bunx postboi init` sets up.
	const key =
		read_env("POSTBOI_PROVIDER") ??
		config.provider ??
		(read_env("POSTBOI_TOKEN") ? "postboi" : undefined)

	// Nothing to send with. In development that is the normal state of a fresh clone, so
	// log the mail instead of failing and let the app code stay unconditional. Anywhere
	// else it is a broken deploy: throw, because a magic link or receipt that silently
	// becomes a console line locks people out with no error anywhere.
	if (!key || (key === "postboi" && !read_env("POSTBOI_TOKEN"))) {
		if (is_development()) {
			if (!warned_dev_fallback) {
				warned_dev_fallback = true
				console.warn(
					`postboi: no ${key === "postboi" ? "POSTBOI_TOKEN" : "provider"} configured, so mail is logged to the console instead of sending. Run \`bunx postboi init\` to send for real.`
				)
			}
			const Mock = await import("./mock.js").then((m) => m.default)
			return new Mock({ log: true, default: env_defaults() })
		}
		throw new PostboiError({
			provider: "postboi",
			code: key ? "no_token" : "no_provider",
			message: key
				? "No Postboi token found. Run `bunx postboi init`, set POSTBOI_TOKEN, or pass { token }."
				: 'No provider configured. Run `bunx postboi init` (it sets POSTBOI_TOKEN or POSTBOI_PROVIDER), set `provider` in postboi.config.ts, or import one directly, e.g. `import Resend from "postboi/resend"`.',
		})
	}

	const load = LOADERS[key]
	if (!load) {
		throw new PostboiError({
			provider: "postboi",
			code: "unknown_provider",
			message: `Unknown POSTBOI_PROVIDER "${key}".`,
		})
	}

	const options: Record<string, unknown> = { default: env_defaults() }
	// `meta` is undefined for credential-free providers (e.g. mock) that have no registry entry.
	const meta = find_provider(key)
	// Scoped: `options` written for the provider the config file names must not reach a
	// different one chosen by POSTBOI_PROVIDER — `api_key` is shared by 15 providers here,
	// so the unscoped bag sent a Mailgun key to api.resend.com in an Authorization header.
	const from_config = scoped_options(config, key)
	const shadowed =
		config.options !== undefined && config.provider !== undefined && config.provider !== key
			? ` \`options\` in postboi.config.ts belong to "${config.provider}" and don't apply here.`
			: ""
	for (const field of meta?.fields ?? []) {
		// env wins, then a non-secret value from the config file, then the field default.
		const value = read_env(field.env) ?? from_config?.[field.arg] ?? field.default
		if (value === undefined) {
			throw new PostboiError({
				provider: key,
				code: "missing_env",
				message: `Provider "${key}" needs ${field.env} — set it in the environment${field.secret ? "" : ` or as \`options.${field.arg}\` in postboi.config.ts`}.${shadowed} Run \`bunx postboi init\`.`,
			})
		}
		options[field.arg] = value
	}

	// A mock reached through `provider: "mock"` or POSTBOI_PROVIDER is there for a human to
	// read, so it logs. `new Mock()` stays silent — that is the test path, where the point is
	// asserting on `sent`, not printing to the run.
	if (key === "mock") options.log = true

	const Provider = await load()
	return new Provider(options)
}

/**
 * `mail({ test: … })` — the send that goes to the proving house instead of a person.
 * Creates (or continues) the named test entry on Postboi's hosted testing and submits
 * the email as a new attempt; the finished report is on the answer. Deliberately not
 * intercepted by the dev inbox or the mock: a test run *is* the interception, and it
 * only exists on the hosted API.
 */
async function send_test(options: TestSendOptions): Promise<HostedTest> {
	// `body` may be a promise (symmetry with the real send path) — but a test takes the
	// email as rendered HTML: FormData is a submission being forwarded, not a template
	// being proven, and its rendering belongs to the provider that will actually send it.
	const body = await options.body
	if (typeof body !== "string") {
		throw new PostboiError({
			provider: "postboi",
			code: "invalid_test_body",
			message: "mail({ test }) proves a rendered email — pass `body` as an HTML string.",
		})
	}
	const { hosted_test } = await import("./inspect/hosted.js")
	return hosted_test({
		series: options.test,
		html: body,
		text: options.text,
		subject: options.subject,
		clients: options.clients,
	})
}

// The bare send function. Exported below as `mail`, augmented with the resource
// namespaces (`mail.recipients`, `mail.lists`, …).
function send_mail(options: TestSendOptions): Promise<HostedTest>
function send_mail<const T extends ReadonlyArray<Email>>(
	options: Omit<BatchOptions, "to" | "data"> & { to: T; data: BatchData<T> }
): Promise<Array<BatchResult<unknown>>>
function send_mail(options: SendOptions): Promise<unknown>
function send_mail(
	options: Array<SendOptions>,
	batch?: { concurrency?: number }
): Promise<Array<BatchResult<unknown>>>
async function send_mail(
	options: SendOptions | TestSendOptions | BatchOptions | Array<SendOptions>,
	batch: { concurrency?: number } = {}
): Promise<unknown> {
	if (!Array.isArray(options) && "test" in options && typeof options.test === "string") {
		return send_test(options as TestSendOptions)
	}
	const provider = await resolve_provider({ intercept: true })
	if (Array.isArray(options)) return provider.send(options, batch)
	return provider.send(options as SendOptions)
}

/**
 * Cancel a scheduled email without constructing anything — resolves the same provider
 * `mail()` uses and calls its `cancel`. Providers without a cancellation API reject
 * with code `cancel_not_supported`.
 *
 * @example
 * ```ts
 * import { mail, cancel } from "postboi"
 * const { id } = await mail({ to: "a@example.com", body: "<p>Hi</p>", scheduled_at: { days: 1 } })
 * await cancel(id)
 * ```
 */
export async function cancel(id: string): Promise<CancelResponse> {
	// Interception included: with the inbox open the id came from the mock, so the real
	// provider has never heard of it.
	const provider = await resolve_provider({ intercept: true })
	return provider.cancel(id)
}

/**
 * Resolve the configured provider, asserting it's the Postboi provider — lists, recipients,
 * suppressions and notifications live on its API. Duck-typed rather than `instanceof`:
 * importing the class here would defeat the dynamic-only leaf (see LOADERS).
 */
async function postboi_provider(): Promise<Postboi> {
	const provider = await resolve_provider()
	if (!("lists" in provider)) {
		throw new PostboiError({
			provider: "postboi",
			code: "lists_not_supported",
			message:
				"List, recipient, suppression and notification management needs the Postboi provider — set POSTBOI_TOKEN (run `bunx postboi init`).",
		})
	}
	return provider as Postboi
}

type PostboiNamespace =
	| "messages"
	| "lists"
	| "recipients"
	| "contacts"
	| "notifications"
	| "suppressions"
	| "forms"
	| "exports"

/**
 * A zero-config mirror of a Postboi namespace: every method call resolves the provider
 * afresh (reading env each time, like `mail()` itself), then forwards to it. Kept in one
 * proxy so every namespace shares the resolve-then-forward logic.
 */
function lazy_namespace<K extends PostboiNamespace>(name: K): Postboi[K] {
	return new Proxy({} as Postboi[K], {
		get(_target, method: string) {
			return async (...args: Array<unknown>) => {
				const provider = await postboi_provider()
				const ns = provider[name] as Record<string, (...a: Array<unknown>) => unknown>
				return ns[method](...args)
			}
		},
	})
}

/**
 * Send without constructing anything — and manage lists, recipients, suppressions,
 * notifications and messages off the same object. The provider is whichever
 * `POSTBOI_PROVIDER` names (set by `bunx postboi init`); its credentials and the
 * `POSTBOI_*` defaults are read from the environment on each call. Pass an array to `mail()`
 * to send many. The `mail.*` namespaces need the Postboi provider (lists live on its API).
 *
 * @example
 * ```ts
 * import { mail } from "postboi"
 *
 * await mail({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
 * await mail({ test: "welcome", subject: "Hi", body: "<p>Hello</p>" }) // hosted test run
 * await mail.recipients.add("Newsletter", "ada@example.com")
 * await mail.lists.create("Newsletter", { confirmation: true })
 * ```
 */
export const mail: typeof send_mail & Pick<Postboi, PostboiNamespace> = Object.assign(send_mail, {
	messages: lazy_namespace("messages"),
	lists: lazy_namespace("lists"),
	recipients: lazy_namespace("recipients"),
	contacts: lazy_namespace("contacts"),
	notifications: lazy_namespace("notifications"),
	suppressions: lazy_namespace("suppressions"),
	forms: lazy_namespace("forms"),
	exports: lazy_namespace("exports"),
})
