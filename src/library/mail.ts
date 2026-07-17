import type {
	SendOptions,
	BatchOptions,
	BatchData,
	Email,
	BatchResult,
	CancelResponse,
	ProviderBase,
} from "./index.js"
import { PostboiError } from "./index.js"
import { find_provider } from "./registry.js"
import { load_config } from "./config.js"
import { ensure_env_loaded, env_defaults, read_env } from "./env.js"

type ProviderConstructor = new (options: Record<string, unknown>) => ProviderBase<unknown>

/**
 * Lazy loaders for every configurable provider, keyed by `POSTBOI_PROVIDER`. Using explicit
 * dynamic imports keeps each provider in its own chunk — `send()` only loads the one in use.
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
	mailpace: () => import("./mailpace.js").then((m) => m.default as unknown as ProviderConstructor),
	scaleway: () => import("./scaleway.js").then((m) => m.default as unknown as ProviderConstructor),
	ses: () => import("./ses.js").then((m) => m.default as unknown as ProviderConstructor),
	microsoft365: () =>
		import("./microsoft365.js").then((m) => m.default as unknown as ProviderConstructor),
	smtp: () => import("./smtp.js").then((m) => m.default as unknown as ProviderConstructor),
	zepto: () => import("./zepto.js").then((m) => m.default as unknown as ProviderConstructor),
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

/** Construct the provider named by `POSTBOI_PROVIDER` from environment variables. */
async function resolve_provider(): Promise<ProviderBase<unknown>> {
	// Load global config (postboi.config.ts / package.json) first, so hooks and the
	// `provider` fallback are available; ProviderBase merges the rest at construction.
	const config = await load_config()
	// Make `.env` values visible in dev (SvelteKit etc. don't put them on process.env).
	await ensure_env_loaded()

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
	if (!key) {
		throw new PostboiError({
			provider: "postboi",
			code: "no_provider",
			message:
				'No provider configured. Run `bunx postboi init` (it sets POSTBOI_TOKEN or POSTBOI_PROVIDER), set `provider` in postboi.config.ts, or import one directly, e.g. `import Resend from "postboi/resend"`.',
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
	for (const field of meta?.fields ?? []) {
		// env wins, then a non-secret value from the config file, then the field default.
		const value = read_env(field.env) ?? config.options?.[field.arg] ?? field.default
		if (value === undefined) {
			throw new PostboiError({
				provider: key,
				code: "missing_env",
				message: `Provider "${key}" needs ${field.env} — set it in the environment${field.secret ? "" : ` or as \`options.${field.arg}\` in postboi.config.ts`}. Run \`bunx postboi init\`.`,
			})
		}
		options[field.arg] = value
	}

	const Provider = await load()
	return new Provider(options)
}

/**
 * Send without constructing anything. The provider is whichever `POSTBOI_PROVIDER` names
 * (set by `bunx postboi init`); its credentials and the `POSTBOI_*` defaults are read from
 * the environment on each call. Pass an array to send many.
 *
 * @example
 * ```ts
 * import { mail } from "postboi"
 * await mail({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
 * ```
 */
export function mail<const T extends ReadonlyArray<Email>>(
	options: Omit<BatchOptions, "to" | "data"> & { to: T; data: BatchData<T> }
): Promise<Array<BatchResult<unknown>>>
export function mail(options: SendOptions): Promise<unknown>
export function mail(
	options: Array<SendOptions>,
	batch?: { concurrency?: number }
): Promise<Array<BatchResult<unknown>>>
export async function mail(
	options: SendOptions | BatchOptions | Array<SendOptions>,
	batch: { concurrency?: number } = {}
): Promise<unknown> {
	const provider = await resolve_provider()
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
	const provider = await resolve_provider()
	return provider.cancel(id)
}
