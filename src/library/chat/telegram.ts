import { ChatProvider, type ChatProviderOptions, type PreparedChat } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import type { ProviderError } from "../errors.js"
import { escape_html } from "../utils.js"

/** Options for the Telegram provider constructor. */
type Options = ChatProviderOptions & {
	/** Bot token from @BotFather, e.g. `123456:ABC-DEF…`. */
	bot_token: string
}

type SendResponse = { message_id: number }

/**
 * Telegram Bot API — https://core.telegram.org/bots/api#sendmessage
 *
 * Unlike the webhook providers, the credential (bot token) and the destination (`chat_id`)
 * are separate, and **the destination is a registered identity, not an address**: a bot
 * cannot message someone who has not first started a chat with it, and you have to capture
 * the `chat_id` from an inbound update to know it. That's the same shape as a push
 * subscription token, so it needs somewhere to be stored — not something you can just know.
 *
 * @example
 * ```ts
 * import Telegram from "postboi/telegram"
 *
 * const chat = new Telegram({ bot_token: process.env.TELEGRAM_BOT_TOKEN })
 * await chat.send({ to: "123456789", message: "Deploy finished" })
 * ```
 */
export default class Telegram extends ChatProvider<SendResponse> {
	protected readonly provider = "telegram"
	#bot_token: string

	constructor({ bot_token, ...options }: Options) {
		super(options)
		this.#bot_token = bot_token
	}

	protected build_request(message: PreparedChat): RequestSpec {
		// A bold title needs a parse mode, and legacy Markdown applied to raw user text is a
		// trap: one unbalanced `_` or `*` in the body (think "user_accounts") and Telegram
		// rejects the whole send with 400. HTML mode has well-defined escaping — and only
		// three characters to escape — so the body survives whatever it contains. With no
		// title there's no formatting, so plain text needs neither mode nor escaping.
		const text = message.title
			? `<b>${escape_html(message.title)}</b>\n${escape_html(message.message)}`
			: message.message
		return {
			url: `https://api.telegram.org/bot${this.#bot_token}/sendMessage`,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: message.to,
				text,
				...(message.title ? { parse_mode: "HTML" } : {}),
			}),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const result = (data as { result?: { message_id?: number } } | null)?.result
		return { message_id: result?.message_id ?? 0 }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		// Telegram always answers { ok, description?, error_code? } — ok:false is the signal,
		// and it can arrive with a 200, so this can't lean on the HTTP status.
		if (e.ok === false) {
			return {
				message: (e.description as string) ?? "Telegram request failed",
				code: e.error_code as number | undefined,
			}
		}
		return undefined
	}
}
