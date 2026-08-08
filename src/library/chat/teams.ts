import {
	ChatProvider,
	type ChatOptions,
	type PreparedChat,
	type WebhookChatOptions,
} from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"

type SendResponse = { ok: true }

/**
 * Microsoft Teams, via a **Power Automate Workflows** webhook (its URL lives on
 * `logic.azure.com` / `powerplatform.com`) posting an Adaptive Card.
 *
 * Legacy Office 365 connector URLs (`outlook.office.com/webhook/…`,
 * `….webhook.office.com/…`) are recognised and **rejected with an error**: Microsoft
 * disabled them in May 2026, and they fail by delivering nothing — silently — which is
 * the one failure mode worse than an exception.
 *
 * @example
 * ```ts
 * import Teams from "postboi/teams"
 *
 * const chat = new Teams({ webhook_url: process.env.TEAMS_WEBHOOK_URL })
 * await chat.send({ title: "Deploy", message: "Finished in 42s" })
 * ```
 */
export default class Teams extends ChatProvider<SendResponse> {
	protected readonly provider = "teams"

	constructor({ webhook_url, ...options }: WebhookChatOptions) {
		super({ ...options, default: { to: webhook_url, ...options.default } })
	}

	/**
	 * Checked at prepare time rather than construction, because the URL can also arrive as
	 * a per-send `to` override — and a dead webhook that answers 200 would otherwise look
	 * exactly like a delivered message.
	 */
	protected override async prepare_chat(options: ChatOptions): Promise<PreparedChat> {
		const message = await super.prepare_chat(options)
		if (/outlook\.office\.com\/webhook|\.webhook\.office\.com/i.test(message.to)) {
			throw new PostboiError({
				provider: this.provider,
				channel: "chat",
				code: "legacy_webhook",
				message:
					"This is an Office 365 connector URL — Microsoft disabled those in May 2026, and posts to them vanish silently. Create a Power Automate Workflows webhook instead (template: “Post to a channel when a webhook request is received”) and use its logic.azure.com URL.",
			})
		}
		return message
	}

	protected build_request(message: PreparedChat): RequestSpec {
		const body: Array<Record<string, unknown>> = []
		if (message.title) {
			body.push({
				type: "TextBlock",
				text: message.title,
				weight: "Bolder",
				size: "Medium",
				wrap: true,
			})
		}
		body.push({ type: "TextBlock", text: message.message, wrap: true })

		return {
			url: message.to,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "message",
				attachments: [
					{
						contentType: "application/vnd.microsoft.card.adaptive",
						content: {
							type: "AdaptiveCard",
							$schema: "http://adaptivecards.io/schemas/adaptive-card.json",
							version: "1.4",
							body,
						},
					},
				],
			}),
		}
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		// Power Automate answers { error: { code, message } } on rejection.
		const e = (data as { error?: Record<string, unknown> }).error
		if (e && typeof e.message === "string") {
			return { message: e.message, code: e.code as string | undefined }
		}
		return undefined
	}
}
