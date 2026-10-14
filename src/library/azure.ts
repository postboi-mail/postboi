import type {
	PreparedMessage,
	CommonProviderOptions,
	ProviderError,
	RequestSpec,
	MailAddress,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"
import { base64_decode, base64_encode } from "./encoding.js"

/** Options for the Azure Communication Services provider constructor. */
type Options = CommonProviderOptions & {
	/**
	 * The resource's connection string from the Azure portal —
	 * `endpoint=https://<resource>.communication.azure.com/;accesskey=…`. Either this or
	 * `endpoint` + `access_key`.
	 */
	connection_string?: string
	/** The resource endpoint, `https://<resource>.communication.azure.com`. */
	endpoint?: string
	/** The resource's access key (base64). */
	access_key?: string
}

interface Address {
	address: string
	displayName?: string
}

export interface SendParams {
	senderAddress: string
	content: { subject: string; plainText?: string; html?: string }
	recipients: { to: Array<Address>; cc?: Array<Address>; bcc?: Array<Address> }
	replyTo?: Array<Address>
	headers?: Record<string, string>
	attachments?: Array<{ name: string; contentType: string; contentInBase64: string }>
	userEngagementTrackingDisabled?: boolean
}

type SendResponse = {
	/** The operation id — what delivery reports and `Operation-Location` are keyed by. */
	id: string
	status: string
	error?: { code?: string; message?: string }
}

const API_VERSION = "2023-03-31"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Split a connection string into its endpoint and access key. */
function parse_connection_string(value: string): { endpoint?: string; access_key?: string } {
	const parts: Record<string, string> = {}
	for (const pair of value.split(";")) {
		const eq = pair.indexOf("=")
		if (eq < 0) continue
		parts[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim()
	}
	return { endpoint: parts.endpoint, access_key: parts.accesskey }
}

/**
 * Azure Communication Services Email provider —
 * https://learn.microsoft.com/rest/api/communication/email/email/send
 *
 * The REST send, authenticated the way the Azure SDKs do it: an HMAC-SHA256 over the
 * verb, path and `x-ms-date;host;x-ms-content-sha256`, keyed with the resource's access
 * key. Addresses become `{ address, displayName }`, both bodies have a slot, `replyTo`
 * takes every reply-to address, custom `headers` and base64 attachments pass through.
 * Azure's tracking is a resource-level switch; the one per-send control is turning it
 * off, so `tracking: { opens: false, clicks: false }` sets
 * `userEngagementTrackingDisabled` and anything else leaves the resource setting alone.
 * `senderAddress` is the bare address — the display name is configured on the domain's
 * MailFrom address in Azure. `tags` and `scheduled_at` have no equivalent and are
 * dropped. A UUID `idempotency_key` is forwarded as the `Operation-Id`.
 *
 * @example
 * ```ts
 * import Azure from "postboi/azure"
 *
 * const mail = new Azure({
 *   connection_string: COMMUNICATION_SERVICES_CONNECTION_STRING,
 *   default: { from: "DoNotReply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Azure extends ProviderBase<SendResponse> {
	protected readonly provider = "azure"
	#endpoint: URL
	#access_key: string
	#signing_key?: Promise<CryptoKey>

	/** The access key imported for HMAC once per instance, not once per send. */
	#key(): Promise<CryptoKey> {
		this.#signing_key ??= crypto.subtle.importKey(
			"raw",
			base64_decode(this.#access_key),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"]
		)
		return this.#signing_key
	}

	constructor({ connection_string, endpoint, access_key, ...options }: Options) {
		super(options)
		const parsed = connection_string ? parse_connection_string(connection_string) : {}
		const resolved_endpoint = endpoint ?? parsed.endpoint
		const resolved_key = access_key ?? parsed.access_key
		if (!resolved_endpoint || !resolved_key) {
			throw new PostboiError({
				provider: "azure",
				code: "missing_credentials",
				message:
					"Azure Communication Services needs a connection_string (endpoint=…;accesskey=…) or an endpoint and access_key.",
			})
		}
		this.#endpoint = new URL(resolved_endpoint)
		this.#access_key = resolved_key
	}

	#address(a: MailAddress): Address {
		return a.name ? { address: a.address, displayName: a.name } : { address: a.address }
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const params: SendParams = {
			senderAddress: this.parse_email_address(message.from).address,
			content: { subject: message.subject, plainText: message.text, html: message.html },
			recipients: {
				to: this.parse_addresses(message.to).map((a) => this.#address(a)),
				cc: message.cc ? this.parse_addresses(message.cc).map((a) => this.#address(a)) : undefined,
				bcc: message.bcc
					? this.parse_addresses(message.bcc).map((a) => this.#address(a))
					: undefined,
			},
			replyTo: message.reply_to
				? this.parse_addresses(message.reply_to).map((a) => this.#address(a))
				: undefined,
			headers: message.headers,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						name: a.name,
						contentType: a.mime_type,
						contentInBase64: a.content,
					}))
				: undefined,
		}
		if (this.tracking_switch(message.tracking) === false) {
			params.userEngagementTrackingDisabled = true
		}

		const body = JSON.stringify(params)
		const url = new URL(`/emails:send?api-version=${API_VERSION}`, this.#endpoint)
		const date = new Date().toUTCString()
		const encoder = new TextEncoder()
		const content_hash = base64_encode(
			new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body)))
		)
		const to_sign = `POST\n${url.pathname}${url.search}\n${date};${url.host};${content_hash}`
		const signature = base64_encode(
			new Uint8Array(await crypto.subtle.sign("HMAC", await this.#key(), encoder.encode(to_sign)))
		)

		return {
			url: url.href,
			headers: {
				"x-ms-date": date,
				"x-ms-content-sha256": content_hash,
				Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
				"Content-Type": "application/json",
				...(message.idempotency_key && UUID.test(message.idempotency_key)
					? { "Operation-Id": message.idempotency_key }
					: {}),
			},
			body,
			// Azure only takes a UUID as an Operation-Id; any other key isn't sent.
			idempotent: Boolean(message.idempotency_key && UUID.test(message.idempotency_key)),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	// Errors are `{ error: { code, message } }`; a 202 whose `status` is already Failed
	// carries the same object under `error`.
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		const error = e.error as Record<string, unknown> | undefined
		if (error && typeof error.message === "string") {
			return {
				message: error.message,
				code: typeof error.code === "string" ? error.code : undefined,
			}
		}
		if (e.status === "Failed") return { message: "azure reported the send as Failed" }
		return undefined
	}
}
