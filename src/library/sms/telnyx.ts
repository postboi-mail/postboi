import { SmsProvider, type PreparedSms, type SmsApiKeyOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError, type RejectionReason } from "../errors.js"

/** Options for the Telnyx provider constructor. */
type Options = SmsApiKeyOptions & {
	/**
	 * Messaging profile id. Optional, but Telnyx needs one to send from a number pool or an
	 * alphanumeric sender, and with one set `from` can be left to the profile.
	 */
	messaging_profile_id?: string
	/** Where Telnyx posts this message's delivery events, over the profile's own setting. */
	webhook_url?: string
}

/** The Telnyx send payload — https://developers.telnyx.com/api/messaging/send-message */
export interface SendParams {
	to: string
	from?: string
	text: string
	messaging_profile_id?: string
	webhook_url?: string
	/** ISO 8601, for a scheduled send. */
	send_at?: string
	/** Public URLs, with `type: "MMS"`. */
	media_urls?: Array<string>
	type?: "SMS" | "MMS"
	[option: string]: unknown
}

type SendResponse = { id: string; status: string }

/**
 * Telnyx's error codes, by what they say about the refusal — titles from its error catalog,
 * https://developers.telnyx.com/development/api-fundamentals/api-errors (the 10DLC tables
 * reuse some of these numbers for other things; these are the send API's). Telnyx sends
 * them as strings. A code that isn't here is left to the HTTP status.
 */
const REASONS: Record<string, RejectionReason> = {
	"10009": "auth", // Authentication failed
	"10010": "auth", // Authorization failed
	"20001": "auth", // Invalid API Key secret
	"20002": "auth", // API Key revoked
	"20003": "auth", // API Key forbidden
	"20006": "auth", // Expired access token
	"20008": "auth", // Invalid API Key
	"10011": "rate_limited", // Too many requests
	"40318": "rate_limited", // Message queue full: wait before resending
	"40300": "compliance", // Blocked due to STOP message
	"40322": "compliance", // Blocked due to content
	"40310": "recipient", // Invalid 'to' address
	"40301": "recipient", // Unsupported message type for the 'to' address
	"40319": "recipient", // Incompatible message type for the 'to' address
	"40305": "sender", // Invalid 'from' address
	"40306": "sender", // Alpha sender not configured
	"40308": "sender", // Invalid 'from' address for MMS
	"40315": "sender", // Unhealthy 'from' address
	"40320": "sender", // Temporarily unusable 'from' address
	"40321": "sender", // No usable numbers on messaging profile
	"40329": "sender", // Tollfree number is not verified
	"40330": "sender", // Tollfree number is not provisioned
	"20013": "account", // Account blocked
	"20100": "account", // Insufficient funds
	"40309": "account", // Invalid destination region for the messaging profile
	"40312": "account", // Messaging profile is disabled
	"40314": "account", // Messaging disabled on account
	"40331": "account", // Missing whitelisted destinations
	"40333": "account", // Messaging profile spend limit reached
}

/**
 * Telnyx — https://developers.telnyx.com/docs/messaging
 *
 * Global, carrier-owned network and usually the cheapest US route. JSON with a Bearer key;
 * one recipient per request, like Twilio, so an array of sends is the way to reach several
 * people. `send_at` schedules a send.
 *
 * @example
 * ```ts
 * import Telnyx from "postboi/telnyx"
 *
 * const text = new Telnyx({ api_key: TELNYX_API_KEY, default: { from: "+15550001111" } })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export default class Telnyx extends SmsProvider<SendResponse> {
	protected readonly provider = "telnyx"
	protected override readonly supports_scheduling = true
	protected override readonly single_recipient = true
	protected override readonly max_media = 10
	protected override readonly reserved_options = [
		"to",
		"from",
		"text",
		"messaging_profile_id",
		"media_urls",
		"type",
		"webhook_url",
		"send_at",
	]
	#api_key: string
	#messaging_profile_id?: string
	#webhook_url?: string

	constructor({ api_key, messaging_profile_id, webhook_url, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#messaging_profile_id = messaging_profile_id || undefined
		this.#webhook_url = webhook_url || undefined
		// A profile with a number pool picks the sender itself.
		if (this.#messaging_profile_id) this.requires_from = false
	}

	protected build_request(message: PreparedSms): RequestSpec {
		if (message.to.length !== 1) {
			// The endpoint takes one `to`; reaching here means several recipients on a single
			// send, which would otherwise text only the first.
			throw new PostboiError({
				provider: this.provider,
				channel: "sms",
				code: "single_recipient_only",
				message:
					"Telnyx sends to one recipient per message. Pass an array of sends instead of an array of recipients.",
			})
		}
		const body: SendParams = {
			to: message.to[0],
			from: message.from,
			text: message.message,
			messaging_profile_id: this.#messaging_profile_id,
			webhook_url: this.#webhook_url,
			send_at: message.scheduled_at?.toISOString(),
			...(message.media ? { media_urls: message.media, type: "MMS" as const } : {}),
			...message.provider_options,
		}
		return {
			url: "https://api.telnyx.com/v2/messages",
			headers: { Authorization: `Bearer ${this.#api_key}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const d = (data as { data?: { id?: string; to?: Array<{ status?: string }> } } | null)?.data
		return { id: d?.id ?? "", status: d?.to?.[0]?.status ?? "queued" }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		const errors = (data as { errors?: Array<Record<string, unknown>> } | null)?.errors
		if (!Array.isArray(errors) || errors.length === 0) return undefined
		const [first] = errors
		const code = first.code === undefined ? undefined : String(first.code)
		const message = [first.title, first.detail]
			.filter((part) => typeof part === "string")
			.join(": ")
		return {
			message: message || "Telnyx refused the message",
			code,
			reason: code ? REASONS[code] : undefined,
		}
	}
}
