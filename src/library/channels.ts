/**
 * The zero-config provider resolution shared by `sms()`, `whatsapp()`, `push()` and the
 * chat platform functions (`slack()` and friends).
 *
 * One implementation on purpose: the credential-precedence rule (env, then committed
 * config options, then the field default) and the errors it produces are behaviour users
 * expect to be identical across channels, and as three near-copies they had already
 * drifted — only the SMS copy mentioned the config fallback in its missing_env message.
 * `mail()` keeps its own resolver: its flow carries genuinely different cases (the dev
 * inbox, the POSTBOI_TOKEN shortcut, the shadowed-from warning).
 *
 * Internal: not part of the public surface.
 */
import { PostboiError, type Channel } from "./errors.js"
import { find_channel_provider, type ProviderField } from "./registry.js"
import { inbox_sink } from "./channel_inbox.js"
import { load_config, type PostboiConfig } from "./config.js"
import { ensure_env_loaded, is_development, read_env } from "./env.js"

/** What one channel supplies to make the shared resolver its own. */
export interface ChannelResolution<TProvider> {
	channel: Channel
	/** Env var naming the provider, e.g. "POSTBOI_SMS_PROVIDER". */
	env_key: string
	/** Lazy constructors keyed by provider key — same shape as mail()'s LOADERS. */
	loaders: Record<string, () => Promise<new (options: Record<string, unknown>) => TProvider>>
	/** Channel defaults read from the environment, passed as `options.default`. */
	env_defaults: () => Record<string, unknown>
	/** The channel's section of the config file. */
	section: (
		config: PostboiConfig
	) => { provider?: string; options?: Record<string, string> } | undefined
	/** `bunx postboi init` flag suggested in errors, e.g. "--sms". Empty to omit. */
	init_flag: string
	/** Printed once when nothing is configured in development. */
	dev_fallback_warning: string
	/**
	 * Development interception — for channels where a stray dev message costs money and
	 * reaches a real handset (SMS, WhatsApp). When set, every development send is captured
	 * regardless of configuration, unless explicitly opted out; checked before any
	 * credential is looked at, so a configured provider is outranked, not consulted.
	 */
	dev_intercept?: {
		/** Env switch that re-enables real sends when set to "send", e.g. "POSTBOI_SMS_DEV". */
		env_key: string
		/** The channel's `dev` flag in the config file — `false` means "send for real". */
		configured: (config: PostboiConfig) => boolean | undefined
		/** Printed once when interception first engages. */
		warning: string
	}
}

const warned_dev_fallback = new Set<Channel>()
const announced_intercept = new Set<Channel>()

/** Construct the channel's logging mock, sinking captures to the dev inbox when one runs. */
async function dev_mock<TProvider>(spec: ChannelResolution<TProvider>): Promise<TProvider> {
	const Mock = await spec.loaders.mock()
	return new Mock({ log: true, sink: inbox_sink(spec.channel), default: spec.env_defaults() })
}

/**
 * Resolve one provider's credential fields into constructor options: env first, then a
 * non-secret value committed to the channel's config section, then the field default.
 * Returns the first missing required field instead of throwing — what "missing" means
 * differs by caller (an error for a configured provider, the dev mock for a platform
 * function), but the precedence rule must not.
 */
export function resolve_fields(
	fields: ReadonlyArray<ProviderField>,
	section: { options?: Record<string, string> } | undefined,
	options: Record<string, unknown>
): ProviderField | undefined {
	for (const field of fields) {
		const value = read_env(field.env) ?? section?.options?.[field.arg] ?? field.default
		if (value === undefined) return field
		options[field.arg] = value
	}
	return undefined
}

/**
 * Construct the configured provider for a channel, or the logging mock in development
 * when nothing is configured. Reads env and config afresh on every call, like `mail()` —
 * providers are cheap to construct, and per-call resolution is what makes changing an env
 * var take effect without a restart.
 */
export async function resolve_channel_provider<TProvider>(
	spec: ChannelResolution<TProvider>
): Promise<TProvider> {
	const config = await load_config()
	await ensure_env_loaded()

	// Development interception, and deliberately stricter than email's dev inbox: it
	// engages whenever NODE_ENV=development, because the failure modes aren't comparable —
	// a stray email is embarrassing, a stray text costs money, reaches a real handset, and
	// cannot be recalled. The way back out is explicit (the channel's `dev` config flag or
	// its POSTBOI_*_DEV=send switch).
	const intercept = spec.dev_intercept
	if (intercept && is_development()) {
		const allowed = read_env(intercept.env_key) === "send" || intercept.configured(config) === false
		if (!allowed) {
			if (!announced_intercept.has(spec.channel)) {
				announced_intercept.add(spec.channel)
				console.warn(intercept.warning)
			}
			return dev_mock(spec)
		}
	}

	const section = spec.section(config)
	const key = read_env(spec.env_key) ?? section?.provider

	// Nothing configured. In development that's a fresh clone, so log rather than fail;
	// anywhere else it's a broken deploy, and a silently-dropped message is worse than an
	// error nobody can miss.
	if (!key) {
		if (is_development()) {
			if (!warned_dev_fallback.has(spec.channel)) {
				warned_dev_fallback.add(spec.channel)
				console.warn(spec.dev_fallback_warning)
			}
			// Captures land in the dev inbox when one is running, console otherwise.
			return dev_mock(spec)
		}
		throw new PostboiError({
			provider: "postboi",
			channel: spec.channel,
			code: `no_${spec.channel}_provider`,
			message:
				`No ${spec.channel} provider configured. ` +
				(spec.init_flag ? `Run \`bunx postboi init ${spec.init_flag}\`, or set` : "Set") +
				` ${spec.env_key}, or import one directly.`,
		})
	}

	const load = spec.loaders[key]
	if (!load) {
		throw new PostboiError({
			provider: "postboi",
			channel: spec.channel,
			code: `unknown_${spec.channel}_provider`,
			message: `Unknown ${spec.env_key} "${key}".`,
		})
	}

	const options: Record<string, unknown> = { default: spec.env_defaults() }
	// `meta` is undefined for credential-free providers (the mock) with no registry entry.
	const meta = find_channel_provider(spec.channel, key)
	const missing = resolve_fields(meta?.fields ?? [], section, options)
	if (missing) {
		throw new PostboiError({
			provider: key,
			channel: spec.channel,
			code: "missing_env",
			message:
				`${spec.channel} provider "${key}" needs ${missing.env} — set it in the environment` +
				(missing.secret
					? ""
					: ` or as \`${spec.channel}.options.${missing.arg}\` in postboi.config.ts`) +
				(spec.init_flag ? `. Run \`bunx postboi init ${spec.init_flag}\`.` : "."),
		})
	}

	// A mock reached through configuration is there for a human to read, so it logs.
	if (key === "mock") options.log = true

	const Provider = await load()
	return new Provider(options)
}
