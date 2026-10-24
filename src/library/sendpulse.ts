import type { PreparedMessage, CommonProviderOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"
import { cached_token } from "./push/oauth.js"

/** Options for the SendPulse provider constructor. */
type Options = CommonProviderOptions & {
	/** The REST API id from Settings → API. */
	client_id: string
	/** The REST API secret beside it. */
	client_secret: string
}

export interface SendParams {
	email: {
		/** Base64 — SendPulse's own rule for the HTML body. */
		html?: string
		text?: string
		subject: string
		from: { email: string; name?: string }
		to: Array<{ email: string; name?: string }>
		cc?: Array<{ email: string; name?: string }>
		bcc?: Array<{ email: string; name?: string }>
		/** Filename → base64 content. */
		attachments_binary?: Record<string, string>
	}
}

type SendResponse = {
	result: boolean
	id: string
}

/**
 * SendPulse provider — https://sendpulse.com/integrations/api/smtp
 *
 * SendPulse's transactional (SMTP) API sits behind OAuth: the REST id and secret are
 * exchanged for a bearer token first, cached and shared across instances the way the
 * push providers' tokens are. The send itself is one JSON object — addresses as
 * `{ email, name }`, the HTML body base64-encoded as SendPulse requires, the text body
 * as-is, attachments as a filename→base64 map. `reply_to`, `headers`, `tags`,
 * `scheduled_at` and `tracking` have no slot on the transactional send and are dropped.
 *
 * @example
 * ```ts
 * import SendPulse from "postboi/sendpulse"
 *
 * const mail = new SendPulse({
 *   client_id: SENDPULSE_CLIENT_ID,
 *   client_secret: SENDPULSE_CLIENT_SECRET,
 *   default: { from: "no-reply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class SendPulse extends ProviderBase<SendResponse> {
	protected readonly provider = "sendpulse"
	#client_id: string
	#client_secret: string

	constructor({ client_id, client_secret, ...options }: Options) {
		super(options)
		this.#client_id = client_id
		this.#client_secret = client_secret
	}

	/** The bearer token — a live cached one, or a fresh client-credentials exchange. */
	async #token(): Promise<string> {
		return cached_token(`sendpulse:${this.#client_id}`, Date.now(), () => this.#exchange())
	}

	async #exchange(): Promise<{ value: string; expires_in: number }> {
		const response = await fetch("https://api.sendpulse.com/oauth/access_token", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "client_credentials",
				client_id: this.#client_id,
				client_secret: this.#client_secret,
			}),
		})
		const data = (await response.json().catch(() => undefined)) as
			{ access_token?: string; expires_in?: number; message?: string; error?: string } | undefined
		if (!response.ok || !data?.access_token) {
			throw new PostboiError({
				provider: this.provider,
				status: response.status,
				message: data?.message ?? data?.error ?? "Failed to obtain a SendPulse access token",
				raw: data,
			})
		}
		return { value: data.access_token, expires_in: data.expires_in ?? 3600 }
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const token = await this.#token()

		const params: SendParams = {
			email: {
				html: message.html ? Buffer.from(message.html, "utf8").toString("base64") : undefined,
				text: message.text,
				subject: message.subject,
				from: this.email_name(this.parse_email_address(message.from)),
				to: this.parse_addresses(message.to).map((a) => this.email_name(a)),
				cc: message.cc
					? this.parse_addresses(message.cc).map((a) => this.email_name(a))
					: undefined,
				bcc: message.bcc
					? this.parse_addresses(message.bcc).map((a) => this.email_name(a))
					: undefined,
				attachments_binary: message.attachments
					? await this.attachment_map(message.attachments)
					: undefined,
			},
		}

		return {
			url: "https://api.sendpulse.com/smtp/emails",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	// Refusals are `{ is_error: true, error_code, message }` (or `{ result: false, message }`).
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (
			e.is_error === true ||
			e.result === false ||
			(typeof e.message === "string" && e.result !== true)
		) {
			return {
				message: typeof e.message === "string" ? e.message : "sendpulse rejected the send",
				code:
					typeof e.error_code === "number" || typeof e.error_code === "string"
						? e.error_code
						: undefined,
			}
		}
		return undefined
	}
}
