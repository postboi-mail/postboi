import type {
	PreparedMessage,
	CommonProviderOptions,
	ProviderError,
	RequestSpec,
	MailAddress,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"

/** Options for the Microsoft 365 (Graph) provider constructor. */
type Options = CommonProviderOptions & {
	/** Azure AD tenant ID (directory ID). */
	tenant_id: string
	/** Application (client) ID of the registered Azure AD app. */
	client_id: string
	/** Client secret of the registered app (needs the Mail.Send application permission). */
	client_secret: string
}

interface Recipient {
	emailAddress: { address: string; name?: string }
}

interface Attachment {
	"@odata.type": "#microsoft.graph.fileAttachment"
	name: string
	contentType: string
	contentBytes: string
}

interface GraphMessage {
	subject: string
	body: { contentType: "HTML" | "Text"; content: string }
	toRecipients: Array<Recipient>
	ccRecipients?: Array<Recipient>
	bccRecipients?: Array<Recipient>
	replyTo?: Array<Recipient>
	attachments?: Array<Attachment>
	internetMessageHeaders?: Array<{ name: string; value: string }>
}

export interface SendParams {
	message: GraphMessage
	saveToSentItems: boolean
}

type SendResponse = { accepted: true }

/**
 * Microsoft 365 (Microsoft Graph) mailer — https://learn.microsoft.com/graph/api/user-sendmail
 *
 * Authenticates with the OAuth2 client-credentials flow (app-only). Register an app in Azure AD,
 * grant it the **Mail.Send** *application* permission (admin-consented), and the `from` address
 * must be a mailbox that app is allowed to send as. Tokens are fetched on demand and cached until
 * they expire.
 *
 * @example
 * ```ts
 * import Microsoft365 from "postboi/microsoft365"
 *
 * const mail = new Microsoft365({
 *   tenant_id: process.env.MS365_TENANT_ID,
 *   client_id: process.env.MS365_CLIENT_ID,
 *   client_secret: process.env.MS365_CLIENT_SECRET,
 *   default: { from: "no-reply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Microsoft365 extends ProviderBase<SendResponse> {
	protected readonly provider = "microsoft365"
	#tenant_id: string
	#client_id: string
	#client_secret: string
	#token?: string
	#token_expires = 0

	constructor({ tenant_id, client_id, client_secret, ...options }: Options) {
		super(options)
		this.#tenant_id = tenant_id
		this.#client_id = client_id
		this.#client_secret = client_secret
	}

	/** Fetch (and cache) an app-only access token via the client-credentials flow. */
	async #access_token(): Promise<string> {
		if (this.#token && Date.now() < this.#token_expires) return this.#token

		const response = await fetch(
			`https://login.microsoftonline.com/${this.#tenant_id}/oauth2/v2.0/token`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.#client_id,
					client_secret: this.#client_secret,
					scope: "https://graph.microsoft.com/.default",
					grant_type: "client_credentials",
				}),
			}
		)
		const data = (await response.json().catch(() => undefined)) as
			| { access_token?: string; expires_in?: number; error?: string; error_description?: string }
			| undefined

		if (!response.ok || !data?.access_token) {
			throw new PostboiError({
				provider: this.provider,
				status: response.status,
				message: data?.error_description ?? "Failed to obtain Microsoft Graph access token",
				code: data?.error,
				raw: data,
			})
		}

		this.#token = data.access_token
		// Refresh 60s early so an in-flight send never races the expiry.
		this.#token_expires = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000
		return this.#token
	}

	#recipient(address: MailAddress): Recipient {
		return { emailAddress: address.name ? { address: address.address, name: address.name } : { address: address.address } }
	}

	#recipients(addresses: PreparedMessage["to"]): Array<Recipient> {
		return this.parse_addresses(addresses).map((a) => this.#recipient(a))
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const token = await this.#access_token()
		const from = this.parse_email_address(message.from)

		const graph: GraphMessage = {
			subject: message.subject,
			// Graph carries a single body; prefer HTML, fall back to the text alternative.
			body: message.html
				? { contentType: "HTML", content: message.html }
				: { contentType: "Text", content: message.text ?? "" },
			toRecipients: this.#recipients(message.to),
			ccRecipients: message.cc ? this.#recipients(message.cc) : undefined,
			bccRecipients: message.bcc ? this.#recipients(message.bcc) : undefined,
			replyTo: message.reply_to ? this.#recipients(message.reply_to) : undefined,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						"@odata.type": "#microsoft.graph.fileAttachment" as const,
						name: a.name,
						contentType: a.mime_type,
						contentBytes: a.content,
					}))
				: undefined,
			// Graph only accepts custom headers whose name starts with "X-"/"x-"; others are rejected.
			internetMessageHeaders: message.headers
				? Object.entries(message.headers).map(([name, value]) => ({ name, value }))
				: undefined,
		}

		// ponytail: sendMail has no native scheduling, so scheduled_at is ignored (sends immediately).
		const params: SendParams = { message: graph, saveToSentItems: false }

		return {
			url: `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from.address)}/sendMail`,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	/** sendMail returns 202 with an empty body on success — there is no message id. */
	protected parse_response(): SendResponse {
		return { accepted: true }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = (data as { error?: unknown }).error
		if (e && typeof e === "object") {
			const { message, code } = e as Record<string, unknown>
			if (typeof message === "string") {
				return { message, code: typeof code === "string" ? code : undefined }
			}
		}
		return undefined
	}
}
