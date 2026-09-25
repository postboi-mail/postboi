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
import type { BatchResult } from "./transport.js"
import {
	find_channel_provider,
	infer_channel_provider,
	scoped_options,
	type ProviderField,
} from "./registry.js"
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
	/**
	 * May credentials alone choose this channel's provider, when nothing names one?
	 *
	 * Required rather than defaulted, because the safe answer differs per channel and a
	 * silent default is how the wrong one gets picked. SMS and WhatsApp say no for the
	 * reason `dev_intercept` exists two fields below: a wrong guess there is a billable
	 * message to a real handset that cannot be recalled, and the credentials that would
	 * do the guessing — `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` — are the Twilio
	 * SDK's zero-argument defaults, set by anyone using Voice or Verify. Push and chat
	 * say yes: a wrong guess costs nothing, and `bunx postboi init` writes the env var
	 * anyway, so inference only ever serves a hand-rolled setup.
	 */
	infers: boolean
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

/** The overloaded one-or-many shape every zero-config channel function shares. */
export interface ChannelSend<TOptions> {
	(options: TOptions): Promise<unknown>
	(options: Array<TOptions>, batch?: { concurrency?: number }): Promise<Array<BatchResult<unknown>>>
}

/**
 * Build a channel's zero-config entry point from its resolution spec — resolve the
 * provider afresh, then hand one-or-many to its send. One factory instead of a pasted
 * wrapper per channel, so a change to the dispatch shape can't land on three channels
 * and miss the fourth.
 */
export function channel_send<TOptions>(
	spec: ChannelResolution<{
		send(options: TOptions | Array<TOptions>, batch?: { concurrency?: number }): Promise<unknown>
	}>
): ChannelSend<TOptions> {
	async function send_channel(
		options: TOptions | Array<TOptions>,
		batch: { concurrency?: number } = {}
	): Promise<unknown> {
		const provider = await resolve_channel_provider(spec)
		if (Array.isArray(options)) return provider.send(options, batch)
		return provider.send(options)
	}
	return send_channel as ChannelSend<TOptions>
}

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
	section: { provider?: string; options?: Record<string, string> } | undefined,
	options: Record<string, unknown>,
	key: string
): ProviderField | undefined {
	// Scoped, not the raw bag: `options` written for the provider the config file names
	// must not reach a different one selected by env, a platform function or inference.
	const from_config = scoped_options(section, key)
	for (const field of fields) {
		const value = read_env(field.env) ?? from_config?.[field.arg] ?? field.default
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
	// Last resort, after both the explicit answers: credentials that can only mean one
	// provider are an answer too, and one the user already gave by setting them.
	const key =
		read_env(spec.env_key) ??
		section?.provider ??
		(spec.infers
			? infer_channel_provider(spec.channel, (env) => read_env(env) !== undefined)
			: undefined)

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
	const missing = resolve_fields(meta?.fields ?? [], section, options, key)
	if (missing) {
		throw new PostboiError({
			provider: key,
			channel: spec.channel,
			code: "missing_env",
			message:
				`${spec.channel} provider "${key}" needs ${missing.env}. Set it in the environment` +
				(missing.secret
					? ""
					: ` or as \`${spec.channel}.options.${missing.arg}\` in postboi.config.ts`) +
				// Without this, a config file plainly showing the option that's "missing" reads
				// as the library ignoring it, rather than as it belonging to another provider.
				(section?.options !== undefined &&
				section.provider !== undefined &&
				section.provider !== key
					? `. \`${spec.channel}.options\` in postboi.config.ts belong to "${section.provider}" and don't apply here`
					: "") +
				(spec.init_flag ? `. Run \`bunx postboi init ${spec.init_flag}\`.` : "."),
		})
	}

	// A mock reached through configuration is there for a human to read, so it logs.
	if (key === "mock") options.log = true

	const Provider = await load()
	return new Provider(options)
}
