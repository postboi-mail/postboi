import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the HubSpot provider constructor. */
type Options = ApiKeyOptions & {
	/**
	 * The transactional email to send — its numeric id in HubSpot (open the email in the
	 * editor; the id is in the URL). HubSpot only sends emails designed there.
	 */
	email_id: number | string
	/** Contact properties set on the recipient with every send, under the message's own. */
	contact_properties?: Record<string, unknown>
	/** Custom properties merged into every send, under the message's own. */
	custom_properties?: Record<string, unknown>
}

export interface SendParams {
	emailId: number
	message: {
		to: string
		from?: string
		cc?: Array<string>
		bcc?: Array<string>
		replyTo?: Array<string>
		sendId?: string
	}
	contactProperties?: Record<string, unknown>
	customProperties?: Record<string, unknown>
}

type SendResponse = {
	requestedAt?: string
	startedAt?: string
	completedAt?: string
	status?: string
	statusId?: string
	sendResult?: string
	eventId?: { id?: string; created?: string }
}

/**
 * `sendResult` values that mean the mail is on its way. Anything else is a refusal.
 * `IDEMPOTENT_IGNORE` is one of them: it is what HubSpot answers when the `sendId` has
 * been seen before — the mail went out on the first attempt, so the retry that provoked
 * it succeeded too. Throwing there would defeat the whole point of `idempotency_key`.
 */
const DELIVERED = new Set(["SENT", "QUEUED", "IDEMPOTENT_IGNORE"])

/**
 * HubSpot single-send provider — https://developers.hubspot.com/docs/api-reference/marketing-transactional-single-send-v3
 *
 * HubSpot has no raw-content send: every email is a transactional email designed in
 * HubSpot, so the provider takes an `email_id` and hands the send over as custom
 * properties — `subject`, `html`, `text`, `from` and the recipient's `name` — for that
 * email's template to place, and a [batch](https://docs.postboi.app/bulk) with `data`
 * fills `{placeholders}` before they go. One recipient per send (`cc` and `bcc` are
 * forwarded as HubSpot's own arrays); `idempotency_key` becomes `sendId`, which is what
 * stops a retry sending twice. Attachments, `headers`, `tags`, `scheduled_at` and
 * `tracking` have no equivalent and are dropped.
 *
 * A refusal often arrives as HTTP 200 with a `sendResult` — `INVALID_TO_ADDRESS`,
 * `PREVIOUSLY_BOUNCED`, `MISSING_TEMPLATE_PROPERTIES` — so anything but `SENT` or
 * `QUEUED` is thrown with that value as the error code rather than returned as a success.
 *
 * The credential is a private app access token with the `transactional-email` scope; the
 * feature itself needs Marketing Hub Enterprise plus the transactional email add-on.
 *
 * @example
 * ```ts
 * import HubSpot from "postboi/hubspot"
 *
 * const mail = new HubSpot({ api_key: HUBSPOT_ACCESS_TOKEN, email_id: 123456789 })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class HubSpot extends ProviderBase<SendResponse> {
	protected readonly provider = "hubspot"
	// The transactional email names the sender; a send without `from` is fine.
	protected readonly requires_from = false
	#api_key: string
	#email_id: number
	#contact_properties?: Record<string, unknown>
	#custom_properties?: Record<string, unknown>

	constructor({ api_key, email_id, contact_properties, custom_properties, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#email_id = Number(email_id)
		this.#contact_properties = contact_properties
		this.#custom_properties = custom_properties
	}

	protected build_request(message: PreparedMessage): RequestSpec {
		const to = this.single_recipient(message, "HubSpot sends one transactional email per send.")

		const params: SendParams = {
			emailId: this.#email_id,
			message: {
				to: to.address,
				from: message.from
					? this.stringify_address(this.parse_email_address(message.from))
					: undefined,
				cc: message.cc ? this.parse_addresses(message.cc).map((a) => a.address) : undefined,
				bcc: message.bcc ? this.parse_addresses(message.bcc).map((a) => a.address) : undefined,
				replyTo: message.reply_to
					? this.parse_addresses(message.reply_to).map((a) => a.address)
					: undefined,
				sendId: message.idempotency_key,
			},
			contactProperties: this.#contact_properties,
			customProperties: { ...this.#custom_properties, ...this.template_fields(message, to) },
		}

		return {
			url: "https://api.hubapi.com/marketing/v3/transactional/single-email/send",
			headers: {
				Authorization: `Bearer ${this.#api_key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
			idempotent: Boolean(message.idempotency_key),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return (data ?? {}) as SendResponse
	}

	/**
	 * Two shapes: HubSpot's standard `{ status: "error", message, category }`, and the 200
	 * that reports a per-send refusal in `sendResult`.
	 */
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (e.status === "error" && typeof e.message === "string") {
			return {
				message: e.message,
				code: typeof e.category === "string" ? e.category : undefined,
			}
		}
		if (typeof e.sendResult === "string" && !DELIVERED.has(e.sendResult)) {
			return { message: `hubspot answered ${e.sendResult}`, code: e.sendResult }
		}
		return undefined
	}
}
