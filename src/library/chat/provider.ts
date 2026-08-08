/**
 * The chat channel's provider base.
 *
 * The thinnest channel we have: no addresses to parse, no encoding to count, no delivery
 * receipts. What varies between Slack, Discord, Teams and Telegram is only the payload
 * shape, so this class does little beyond applying defaults and checking there's somewhere
 * to post to.
 */
import { PostboiError, type Channel } from "../errors.js"
import { Transport, type BatchResult } from "../transport.js"
import { get_config } from "../config.js"
import { ensure_env_loaded } from "../env.js"
import type { ChatDefaults, ChatOptions, ChatProviderOptions, PreparedChat } from "./types.js"

export type {
	ChatDefaults,
	ChatOptions,
	ChatProviderOptions,
	PreparedChat,
	WebhookChatOptions,
} from "./types.js"

/**
 * Base class for chat providers.
 *
 * @example
 * ```ts
 * import Slack from "postboi/slack"
 *
 * const chat = new Slack({ webhook_url: SLACK_WEBHOOK_URL })
 * await chat.send({ message: "Deploy finished" })
 * ```
 */
export abstract class ChatProvider<TResponse = unknown> extends Transport<TResponse, PreparedChat> {
	protected readonly channel: Channel = "chat"

	protected defaults: ChatDefaults

	constructor(options: ChatProviderOptions = {}) {
		super(options)
		const s = get_config()
		this.defaults = { ...s.chat?.default, ...options.default }
	}

	/** Post one message. Throws a {@link PostboiError} on any failure. */
	send(options: ChatOptions): Promise<TResponse>
	/** Post many, with bounded concurrency. Never rejects — each yields its own result. */
	send(
		options: Array<ChatOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<TResponse>>>
	async send(
		options: ChatOptions | Array<ChatOptions>,
		batch: { concurrency?: number } = {}
	): Promise<TResponse | Array<BatchResult<TResponse>>> {
		if (Array.isArray(options)) {
			return this.run_batch(options, (one) => this.send(one), batch)
		}
		return this.with_hooks(
			() => this.prepare_chat(options),
			(message) => this.deliver(message)
		)
	}

	/** Apply defaults and check there's a destination and something to say. */
	protected async prepare_chat(options: ChatOptions): Promise<PreparedChat> {
		await ensure_env_loaded()

		const to = options.to ?? this.defaults.to
		if (!to) {
			throw new PostboiError({
				provider: this.provider,
				channel: "chat",
				code: "no_destination",
				message: `No destination for ${this.provider} — pass \`to\`, or configure one on the provider.`,
			})
		}
		if (!options.message?.trim()) {
			throw new PostboiError({
				provider: this.provider,
				channel: "chat",
				code: "empty_message",
				message: "Cannot post an empty message — `message` is required.",
			})
		}

		return {
			to,
			message: options.message,
			title: options.title,
			username: options.username ?? this.defaults.username,
		}
	}

	/**
	 * Most chat webhooks answer with an empty body or a bare `ok`, so there is nothing
	 * useful to parse. Providers that *do* return something override this.
	 */
	protected parse_response(_response: Response, _data: unknown): TResponse {
		return { ok: true } as TResponse
	}
}
