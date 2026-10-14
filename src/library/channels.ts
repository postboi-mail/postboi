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
import { FailoverError, PostboiError, fails_over, type Channel } from "./errors.js"
import type { BatchResult } from "./transport.js"
import {
	find_channel_provider,
	infer_channel_provider,
	provider_keys,
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
	) => { provider?: string | ReadonlyArray<string>; options?: Record<string, string> } | undefined
	/**
	 * May the channel name several providers, to fail over between? Only where the same
	 * message means the same thing to each of them: a text or a WhatsApp message does, while a
	 * push is addressed to one service's own device tokens and can't be sent through another.
	 */
	chains?: boolean
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
 *
 * Several providers named (`POSTBOI_SMS_PROVIDER=twilio,puresms`) are a failover chain:
 * each message goes to the first, and moves to the next only when it was refused for a
 * reason that is about that provider (see `fails_over`). Never after an unknown outcome:
 * the message may already be on its way, and a second provider would send it twice.
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
		const providers = await resolve_channel_chain(spec)
		if (providers.length === 1) {
			const [provider] = providers
			if (Array.isArray(options)) return provider.send(options, batch)
			return provider.send(options)
		}
		if (Array.isArray(options)) return send_batch_through(providers, options, batch)
		return send_through(providers, options)
	}
	return send_channel as ChannelSend<TOptions>
}

type Sends<TOptions> = {
	send(options: TOptions | Array<TOptions>, batch?: { concurrency?: number }): Promise<unknown>
}

/** One message down a chain: the first answer that isn't a failover, or every error. */
async function send_through<TOptions>(
	providers: ReadonlyArray<Sends<TOptions>>,
	options: TOptions
): Promise<unknown> {
	const errors: Array<PostboiError> = []
	for (const provider of providers) {
		try {
			return await provider.send(options)
		} catch (error) {
			// Transport normalizes everything it throws; anything else is a bug to surface.
			if (!(error instanceof PostboiError)) throw error
			errors.push(error)
			if (!fails_over(error)) break
		}
	}
	throw errors.length === 1 ? errors[0] : new FailoverError(errors)
}

/**
 * Many messages down a chain. Each provider is sent only what the one before it refused
 * for a failover reason, as one batch, so a chain costs nothing extra while the first
 * provider is healthy; results keep the caller's indexes.
 */
async function send_batch_through<TOptions>(
	providers: ReadonlyArray<Sends<TOptions>>,
	options: Array<TOptions>,
	batch: { concurrency?: number }
): Promise<Array<BatchResult<unknown>>> {
	const results: Array<BatchResult<unknown>> = []
	const errors: Array<Array<PostboiError>> = options.map(() => [])
	let pending = options.map((message, index) => ({ message, index }))
	for (const [step, provider] of providers.entries()) {
		const last = step === providers.length - 1
		const answers = (await provider.send(
			pending.map((item) => item.message),
			batch
		)) as Array<BatchResult<unknown>>
		const next: typeof pending = []
		for (const answer of answers) {
			const item = pending[answer.index]
			if (answer.ok) {
				results[item.index] = { ...answer, index: item.index }
				continue
			}
			const tried = errors[item.index]
			tried.push(answer.error)
			if (!last && fails_over(answer.error)) {
				next.push(item)
				continue
			}
			results[item.index] = {
				ok: false,
				index: item.index,
				error: tried.length === 1 ? tried[0] : new FailoverError(tried),
			}
		}
		pending = next
		if (pending.length === 0) break
	}
	return results
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
	section:
		| { provider?: string | ReadonlyArray<string>; options?: Record<string, string> }
		| undefined,
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
 * var take effect without a restart. A chain answers its first provider.
 */
export async function resolve_channel_provider<TProvider>(
	spec: ChannelResolution<TProvider>
): Promise<TProvider> {
	return (await resolve_channel_chain(spec))[0]
}

/**
 * Every provider the channel names, in failover order: one for a plain setting, several
 * for a chain (`POSTBOI_SMS_PROVIDER=twilio,puresms`), the logging mock alone in
 * development. Each one in a chain must be fully configured, because a backup that turns
 * out to be missing a credential is found at the worst moment otherwise.
 */
export async function resolve_channel_chain<TProvider>(
	spec: ChannelResolution<TProvider>
): Promise<Array<TProvider>> {
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
			return [await dev_mock(spec)]
		}
	}

	const section = spec.section(config)
	// Last resort, after both the explicit answers: credentials that can only mean one
	// provider are an answer too, and one the user already gave by setting them.
	const inferred = spec.infers
		? infer_channel_provider(spec.channel, (env) => read_env(env) !== undefined)
		: undefined
	const keys =
		provider_keys(read_env(spec.env_key)) ??
		provider_keys(section?.provider) ??
		(inferred ? [inferred] : undefined)

	// Nothing configured. In development that's a fresh clone, so log rather than fail;
	// anywhere else it's a broken deploy, and a silently-dropped message is worse than an
	// error nobody can miss.
	if (!keys) {
		if (is_development()) {
			if (!warned_dev_fallback.has(spec.channel)) {
				warned_dev_fallback.add(spec.channel)
				console.warn(spec.dev_fallback_warning)
			}
			// Captures land in the dev inbox when one is running, console otherwise.
			return [await dev_mock(spec)]
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

	if (keys.length > 1 && !spec.chains) {
		throw new PostboiError({
			provider: "postboi",
			channel: spec.channel,
			code: "provider_chain_not_supported",
			message: `${spec.env_key} names ${keys.join(", ")}, but ${spec.channel} sends through one provider. Name one.`,
		})
	}

	const providers: Array<TProvider> = []
	for (const key of keys) providers.push(await construct(spec, section, key))
	return providers
}

/** Construct one named provider with its credentials, or say which one it is missing. */
async function construct<TProvider>(
	spec: ChannelResolution<TProvider>,
	section: ReturnType<ChannelResolution<TProvider>["section"]>,
	key: string
): Promise<TProvider> {
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
	// The provider the config's `options` were written for: the one it names, or a chain's first.
	const primary = provider_keys(section?.provider)?.[0]
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
				(section?.options !== undefined && primary !== undefined && primary !== key
					? `. \`${spec.channel}.options\` in postboi.config.ts belong to "${primary}" and don't apply here`
					: "") +
				(spec.init_flag ? `. Run \`bunx postboi init ${spec.init_flag}\`.` : "."),
		})
	}

	// A mock reached through configuration is there for a human to read, so it logs.
	if (key === "mock") options.log = true

	const Provider = await load()
	return new Provider(options)
}
