import { ChatProvider, type PreparedChat, type WebhookChatOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import type { ProviderError } from "../errors.js"

type SendResponse = { ok: true }

/**
 * Slack incoming webhooks — https://api.slack.com/messaging/webhooks
 *
 * The destination is baked into the webhook URL, so there's no channel to name and no
 * token to send: whoever holds the URL can post. Treat it as a secret.
 *
 * @example
 * ```ts
 * import Slack from "postboi/slack"
 *
 * const chat = new Slack({ webhook_url: process.env.SLACK_WEBHOOK_URL })
 * await chat.send({ message: "Deploy finished" })
 * ```
 */
export default class Slack extends ChatProvider<SendResponse> {
	protected readonly provider = "slack"

	constructor({ webhook_url, ...options }: WebhookChatOptions) {
		super({ ...options, default: { to: webhook_url, ...options.default } })
	}

	protected build_request(message: PreparedChat): RequestSpec {
		// mrkdwn, not markdown: Slack's own dialect, where *bold* is single-asterisk.
		const text = message.title ? `*${message.title}*\n${message.message}` : message.message
		return {
			url: message.to,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text,
				...(message.username ? { username: message.username } : {}),
			}),
		}
	}

	protected parse_error(response: Response, data: unknown): ProviderError | undefined {
		// Slack answers "ok" in the body on success and a plain-text reason on failure
		// (invalid_payload, channel_not_found, …) — there is no JSON error envelope.
		if (response.ok) return undefined
		if (typeof data === "string" && data && data !== "ok") return { message: data, code: data }
		return undefined
	}
}
