/**
 * The chat channel's public types — Slack, Discord, Teams and Telegram.
 *
 * Free of runtime imports so the package root can widen `Hooks` to include
 * {@link PreparedChat} without pulling a chat provider into the email module graph.
 */
import type { TransportOptions } from "../transport.js"

/** Default values applied to every chat post when the option is omitted. */
export type ChatDefaults = {
	/**
	 * Where to post by default. A webhook URL for Slack/Discord/Teams, or a chat id for
	 * Telegram. Usually set once on the provider rather than per message.
	 */
	to?: string
	/** Display name override, where the platform supports one (Slack, Discord). */
	username?: string
}

/** Options accepted by `chat(...)` and every chat provider's `send`. */
export interface ChatOptions {
	/**
	 * Where to post — a webhook URL (Slack, Discord, Teams) or a chat id (Telegram).
	 * Falls back to the provider's default, which is the common case: one configured
	 * destination, many messages.
	 */
	to?: string
	/** The message body. Plain text; each provider maps it to its own payload shape. */
	message: string
	/** Optional heading, rendered where the platform has somewhere to put one. */
	title?: string
	/** Display name override, where the platform supports one (Slack, Discord). */
	username?: string
}

/** A fully-resolved chat message handed to a provider's `build_request`. */
export interface PreparedChat {
	to: string
	message: string
	title?: string
	username?: string
}

/** Constructor options shared by every chat provider. */
export type ChatProviderOptions = TransportOptions<PreparedChat> & {
	/** Default field values applied when a post omits them. */
	default?: ChatDefaults
}

/**
 * Options for the webhook-based providers (Slack, Discord, Teams), where the destination
 * *is* the credential — anyone with the URL can post, so it belongs in the environment
 * rather than in committed config.
 */
export type WebhookChatOptions = ChatProviderOptions & {
	/** The incoming-webhook URL. Also usable per message via `to`. */
	webhook_url: string
}
