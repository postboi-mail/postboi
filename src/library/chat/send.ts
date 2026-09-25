/**
 * The zero-config `chat()`, on the shared channel resolution in `channels.ts` — plus the
 * per-platform `slack()`, `discord()`, `teams()` and `telegram()`, which skip the
 * which-provider question entirely: each reads its own platform's credential from the
 * environment, so an app can post to several platforms side by side.
 *
 * Note there is **no development interception** here, unlike SMS. Posting to your own
 * Slack channel while developing is normally the point — it costs nothing, reaches only
 * your own team, and can be deleted. The interception SMS gets exists because a stray text
 * costs money and can't be recalled; neither applies.
 */
import type { BatchResult } from "../transport.js"
import type { ChatDefaults, ChatOptions } from "./types.js"
import type { ChatProvider } from "./provider.js"
import { resolve_channel_provider, resolve_fields, type ChannelResolution } from "../channels.js"
import { inbox_sink } from "../channel_inbox.js"
import { find_chat_provider, type ChatProviderKey } from "../registry.js"
import { load_config } from "../config.js"
import { PostboiError } from "../errors.js"
import { ensure_env_loaded, is_development, read_env } from "../env.js"

type ChatConstructor = new (options: Record<string, unknown>) => ChatProvider<unknown>

/** Lazy loaders keyed by `POSTBOI_CHAT_PROVIDER`. */
const LOADERS: ChannelResolution<ChatProvider<unknown>>["loaders"] = {
	slack: () => import("./slack.js").then((m) => m.default as unknown as ChatConstructor),
	discord: () => import("./discord.js").then((m) => m.default as unknown as ChatConstructor),
	teams: () => import("./teams.js").then((m) => m.default as unknown as ChatConstructor),
	telegram: () => import("./telegram.js").then((m) => m.default as unknown as ChatConstructor),
	bluesky: () => import("./bluesky.js").then((m) => m.default as unknown as ChatConstructor),
	mock: () => import("./mock.js").then((m) => m.default as unknown as ChatConstructor),
}

/** Read the chat defaults from the environment. Only defined values are included. */
export function chat_env_defaults(): ChatDefaults {
	const out: ChatDefaults = {}
	const to = read_env("POSTBOI_CHAT_TO")
	const username = read_env("POSTBOI_CHAT_USERNAME")
	if (to !== undefined) out.to = to
	if (username !== undefined) out.username = username
	return out
}

const RESOLUTION: ChannelResolution<ChatProvider<unknown>> = {
	channel: "chat",
	env_key: "POSTBOI_CHAT_PROVIDER",
	loaders: LOADERS,
	env_defaults: chat_env_defaults as () => Record<string, unknown>,
	section: (config) => config.chat,
	init_flag: "--chat",
	// Free and revocable, and the ecosystem-standard webhook names are marked ambient,
	// so what remains inferable is credentials nobody sets by accident.
	infers: true,
	dev_fallback_warning:
		"postboi: no chat provider configured, so messages are logged to the console instead of posted. Run `bunx postboi init --chat` to post for real.",
}

/**
 * Recognise a chat platform from a full webhook URL. The URL shapes are stable, vendor
 * branded, and the whole credential — so a `to` that matches one is configuration enough
 * for `send()`'s chat leg, no `POSTBOI_CHAT_PROVIDER` required.
 */
export function platform_for_webhook(to: string): "slack" | "discord" | undefined {
	if (/^https:\/\/hooks\.slack\.com\//.test(to)) return "slack"
	if (/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\//.test(to))
		return "discord"
	return undefined
}

/**
 * The channel-generic chat send: the provider comes from `POSTBOI_CHAT_PROVIDER` /
 * `chat.provider` — or, when `to` is a recognisable webhook URL, from the URL itself,
 * which is how the documented `send({ to: { chat: hook } })` works with nothing but
 * `SLACK_WEBHOOK_URL`-style setup. **Not exported from the package root** — you always
 * know which platform you're posting to, so the public surface is `slack()`, `discord()`,
 * `teams()` and `telegram()`. This exists as `send()`'s chat leg, where "the team chat,
 * whichever platform that is" is a real question because the caller is channel-generic.
 *
 * @internal
 */
export function chat(options: ChatOptions): Promise<unknown>
export function chat(
	options: Array<ChatOptions>,
	batch?: { concurrency?: number }
): Promise<Array<BatchResult<unknown>>>
export async function chat(
	options: ChatOptions | Array<ChatOptions>,
	batch: { concurrency?: number } = {}
): Promise<unknown> {
	// The webhook in `to` is definitive when it names a platform — a configured provider
	// of a different platform could never post to it anyway. send()'s chat leg always
	// passes a single options object, which is why the array path doesn't infer.
	if (!Array.isArray(options) && typeof options.to === "string") {
		const key = platform_for_webhook(options.to)
		if (key) {
			const Provider = await LOADERS[key]()
			return new Provider({ webhook_url: options.to, default: chat_env_defaults() }).send(options)
		}
	}
	const provider = await resolve_channel_provider(RESOLUTION)
	if (Array.isArray(options)) return provider.send(options, batch)
	return provider.send(options)
}

/** The zero-config shape shared by `chat()` and the per-platform functions. */
interface PlatformSend {
	(options: ChatOptions): Promise<unknown>
	(
		options: Array<ChatOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<unknown>>>
}

const warned_platform = new Set<ChatProviderKey>()

/** Construct one platform's provider from its own env credential (or the config file). */
async function resolve_platform(key: ChatProviderKey): Promise<ChatProvider<unknown>> {
	const config = await load_config()
	await ensure_env_loaded()

	// The platform is fixed, so only its credentials need resolving — the same precedence
	// rule as the shared resolver (env, then a non-secret committed config value, then the
	// field default), via the same code.
	const meta = find_chat_provider(key)!
	const options: Record<string, unknown> = { default: chat_env_defaults() }
	// Keyed on `key`, not `config.chat.provider`: calling discord() while the config file
	// configures slack must not hand Discord the Slack webhook URL — they share `webhook_url`.
	const missing = resolve_fields(meta.fields, config.chat, options, key)
	if (missing) {
		// Unconfigured in development is a fresh clone: capture to the inbox/console
		// rather than fail, the same fallback the shared resolver has.
		if (is_development()) {
			if (!warned_platform.has(key)) {
				warned_platform.add(key)
				console.warn(
					`postboi: no ${missing.env} set, so ${key} messages are logged instead of posted.`
				)
			}
			const Mock = await LOADERS.mock()
			// The platform rides on the mock so the dev inbox can dress the conversation as
			// Slack, Discord, Teams or Telegram rather than as a generic chat.
			return new Mock({
				log: true,
				sink: inbox_sink("chat"),
				platform: key,
				default: chat_env_defaults(),
			})
		}
		throw new PostboiError({
			provider: key,
			channel: "chat",
			code: "missing_env",
			message:
				`${key}() needs ${missing.env}. Set it in the environment` +
				(missing.secret ? "" : ` or as \`chat.options.${missing.arg}\` in postboi.config.ts`) +
				". Run `bunx postboi init --chat`.",
		})
	}
	const Provider = await LOADERS[key]()
	return new Provider(options)
}

function platform(key: ChatProviderKey): PlatformSend {
	async function send(
		options: ChatOptions | Array<ChatOptions>,
		batch: { concurrency?: number } = {}
	): Promise<unknown> {
		const provider = await resolve_platform(key)
		if (Array.isArray(options)) return provider.send(options, batch)
		return provider.send(options)
	}
	return send as PlatformSend
}

/**
 * Post to Slack without constructing anything — `SLACK_WEBHOOK_URL` is the whole setup.
 * Unlike `chat()`, the platform is in the name, so an app can post to several: `slack()`
 * for alerts and `discord()` for the community are two imports, not a provider choice.
 *
 * @example
 * ```ts
 * import { slack } from "postboi"
 *
 * await slack({ title: "Deploy", message: "Finished in 42s" })
 * ```
 */
export const slack: PlatformSend = platform("slack")

/** Post to Discord without constructing anything — `DISCORD_WEBHOOK_URL` is the setup. */
export const discord: PlatformSend = platform("discord")

/** Post to Teams without constructing anything — `TEAMS_WEBHOOK_URL` (a Workflows URL). */
export const teams: PlatformSend = platform("teams")

/**
 * Message Telegram without constructing anything — `TELEGRAM_BOT_TOKEN`, plus the chat id
 * the bot should post to (per send, or committed as `chat.default.to`).
 *
 * @example
 * ```ts
 * import { telegram } from "postboi"
 *
 * await telegram({ to: "987654321", message: "Deploy finished" })
 * ```
 */
export const telegram: PlatformSend = platform("telegram")

/**
 * Post to Bluesky without constructing anything — `BLUESKY_HANDLE` and
 * `BLUESKY_APP_PASSWORD` are the setup. Unlike its neighbours here, **the post is
 * public**: there is no channel, no room and no recipient, only your own feed.
 *
 * @example
 * ```ts
 * import { bluesky } from "postboi"
 *
 * await bluesky({ message: "Postboi 0.25 is out — https://postboi.app" })
 * ```
 */
export const bluesky: PlatformSend = platform("bluesky")
