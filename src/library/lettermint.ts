import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Lettermint provider constructor. */
type Options = ApiKeyOptions & {
	/** Route slug to send through; omit to use the project's default route. */
	route?: string
}

interface Attachment {
	filename: string
	content: string
	content_type?: string
}

export interface SendParams {
	route?: string
	from: string
	to: Array<string>
	cc?: Array<string>
	bcc?: Array<string>
	reply_to?: Array<string>
	subject: string
	html?: string
	text?: string
	headers?: Record<string, string>
	tags?: Array<{ name: string; value: string }>
	settings?: { track_opens?: boolean; track_clicks?: boolean }
	scheduled_at?: string
	attachments?: Array<Attachment>
}

type SendResponse = { message_id: string; status: string; scheduled_at?: string }

/**
 * Lettermint provider — https://lettermint.co/docs/api-reference/email/send-email
 *
 * Authenticates with a **sending token** (`lm_…`), not an API token — the two are
 * different credentials in Lettermint.
 *
 * @example
 * ```ts
 * import Lettermint from "postboi/lettermint"
 *
 * const mail = new Lettermint({
 *   api_key: LETTERMINT_SENDING_TOKEN,
 *   default: { from: "no-reply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Lettermint extends ProviderBase<SendResponse> {
	protected readonly provider = "lettermint"
	#api_key: string
	#route?: string

	constructor({ api_key, route, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#route = route || undefined
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const { opens, clicks } = message.tracking ?? {}

		const params: SendParams = {
			route: this.#route,
			from: this.stringify_address(this.parse_email_address(message.from)),
			to: this.parse_addresses(message.to).map((a) => this.stringify_address(a)),
			cc: message.cc
				? this.parse_addresses(message.cc).map((a) => this.stringify_address(a))
				: undefined,
			bcc: message.bcc
				? this.parse_addresses(message.bcc).map((a) => this.stringify_address(a))
				: undefined,
			reply_to: message.reply_to
				? this.parse_addresses(message.reply_to).map((a) => this.stringify_address(a))
				: undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: message.headers,
			tags: message.tags?.map((t) => ({ name: t, value: t })),
			// Only the flags the user set are emitted; the route's own settings cover the rest.
			settings:
				opens === undefined && clicks === undefined
					? undefined
					: { track_opens: opens, track_clicks: clicks },
			scheduled_at: message.scheduled_at?.toISOString(),
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						filename: a.name,
						content: a.content,
						content_type: a.mime_type,
					}))
				: undefined,
		}

		return {
			url: "https://api.lettermint.co/v1/send",
			headers: {
				"x-lettermint-token": this.#api_key,
				"Content-Type": "application/json",
				...(message.idempotency_key ? { "Idempotency-Key": message.idempotency_key } : {}),
			},
			body: JSON.stringify(params),
			idempotent: Boolean(message.idempotency_key),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.error === "string") return { message: e.error }
		if (typeof e.message === "string") return { message: e.message }
		return undefined
	}
}
