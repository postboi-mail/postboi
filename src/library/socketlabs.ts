import type {
	PreparedMessage,
	CommonProviderOptions,
	ProviderError,
	RequestSpec,
	MailAddress,
} from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the SocketLabs provider constructor. */
type Options = CommonProviderOptions & {
	/** The server to inject through — the 4- or 5-digit id beside the API key. */
	server_id: number | string
	/** The Injection API key for that server. */
	api_key: string
}

interface Address {
	emailAddress: string
	friendlyName?: string
}

interface Message {
	subject: string
	htmlBody?: string
	textBody?: string
	from: Address
	to: Array<Address>
	cc?: Array<Address>
	bcc?: Array<Address>
	replyTo?: Address
	customHeaders?: Array<{ name: string; value: string }>
	attachments?: Array<{ name: string; contentType: string; content: string }>
	mailingId?: string
}

export interface SendParams {
	serverId: number
	apiKey: string
	messages: Array<Message>
}

type SendResponse = {
	ErrorCode: string
	TransactionReceipt?: string
	MessageResults?: Array<{
		Index?: number
		ErrorCode?: string
		AddressResults?: Array<{ EmailAddress?: string; Accepted?: boolean; ErrorCode?: string }>
	}>
}

/**
 * SocketLabs provider — https://help.socketlabs.com/docs/email/v2/injection-api
 *
 * The Injection API: credentials travel in the JSON body (`serverId` + `apiKey`) beside
 * a `messages` array, one message here. Addresses are `{ emailAddress, friendlyName }`
 * objects, both bodies have a slot, a single `replyTo`, custom headers as name/value
 * pairs, base64 attachments, and the first `tag` becomes the `mailingId` SocketLabs
 * groups reporting by. `scheduled_at` and per-send `tracking` have no equivalent and
 * are dropped. A refusal comes back as a 200 whose `ErrorCode` isn't `Success`, so
 * `parse_error` reads the code whatever the status.
 *
 * @example
 * ```ts
 * import SocketLabs from "postboi/socketlabs"
 *
 * const mail = new SocketLabs({
 *   server_id: SOCKETLABS_SERVER_ID,
 *   api_key: SOCKETLABS_API_KEY,
 *   default: { from: "no-reply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class SocketLabs extends ProviderBase<SendResponse> {
	protected readonly provider = "socketlabs"
	#server_id: number
	#api_key: string

	constructor({ server_id, api_key, ...options }: Options) {
		super(options)
		this.#server_id = Number(server_id)
		this.#api_key = api_key
	}

	#address(a: MailAddress): Address {
		return a.name ? { emailAddress: a.address, friendlyName: a.name } : { emailAddress: a.address }
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const headers = Object.entries(message.headers ?? {}).map(([name, value]) => ({ name, value }))

		const one: Message = {
			subject: message.subject,
			htmlBody: message.html,
			textBody: message.text,
			from: this.#address(this.parse_email_address(message.from)),
			to: this.parse_addresses(message.to).map((a) => this.#address(a)),
			cc: message.cc ? this.parse_addresses(message.cc).map((a) => this.#address(a)) : undefined,
			bcc: message.bcc ? this.parse_addresses(message.bcc).map((a) => this.#address(a)) : undefined,
			replyTo: message.reply_to
				? this.#address(this.parse_addresses(message.reply_to)[0])
				: undefined,
			customHeaders: headers.length ? headers : undefined,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						name: a.name,
						contentType: a.mime_type,
						content: a.content,
					}))
				: undefined,
			mailingId: message.tags?.[0],
		}

		const params: SendParams = {
			serverId: this.#server_id,
			apiKey: this.#api_key,
			messages: [one],
		}

		return {
			url: "https://inject.socketlabs.com/api/v1/email",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	// `{ ErrorCode: "Success" }` is the only good answer; anything else names the refusal,
	// and a per-message code (in MessageResults) says which part of it.
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		const code = e.ErrorCode ?? e.errorCode
		if (typeof code !== "string") return undefined
		if (code === "Success") return undefined
		const results = (e.MessageResults ?? e.messageResults) as
			Array<Record<string, unknown>> | undefined
		const detail = results?.[0]?.ErrorCode ?? results?.[0]?.errorCode
		return {
			message: `socketlabs refused the send: ${code}${typeof detail === "string" && detail !== code ? ` (${detail})` : ""}`,
			code,
		}
	}
}
