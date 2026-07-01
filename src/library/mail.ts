import type {
	SendOptions,
	BatchOptions,
	BatchData,
	Email,
	BatchResult,
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
	// Credential-free no-op — handy as a safe local default (`provider: "mock"`) that records
	// instead of sending. Deliberately absent from the registry so `postboi init` won't offer it.
	mock: () => import("./mock.js").then((m) => m.default as unknown as ProviderConstructor),
}

/** Construct the provider named by `POSTBOI_PROVIDER` from environment variables. */
async function resolve_provider(): Promise<ProviderBase<unknown>> {
	// Load global config (postboi.config.ts / package.json) first, so hooks and the
	// `provider` fallback are available; ProviderBase merges the rest at construction.
	const config = await load_config()
	// Make `.env` values visible in dev (SvelteKit etc. don't put them on process.env).
	await ensure_env_loaded()
	const key = read_env("POSTBOI_PROVIDER") ?? config.provider
	if (!key) {
		throw new PostboiError({
			provider: "postboi",
			code: "no_provider",
			message:
				'No provider configured. Run `bunx postboi init` (it sets POSTBOI_PROVIDER), set `provider` in postboi.config.ts, or import one directly, e.g. `import Resend from "postboi/resend"`.',
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
