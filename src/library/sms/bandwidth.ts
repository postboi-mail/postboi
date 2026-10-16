import {
	SmsProvider,
	type PreparedSms,
	type SmsReceipt,
	type SmsProviderOptions,
	type SmsSenderKind,
} from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"

/** Options for the Bandwidth provider constructor. */
type Options = SmsProviderOptions & {
	/** The account ID, as shown in the Bandwidth App. */
	account_id: string
	/** API username. */
	username: string
	/** API password. */
	password: string
	/** The messaging application the sending number belongs to. */
	application_id: string
}

/** The Bandwidth message payload — https://dev.bandwidth.com/apis/messaging/ */
export interface SendParams {
	applicationId: string
	/** E.164. Several numbers here are one group message, so a send carries one. */
	to: Array<string>
	from: string
	text: string
	media?: Array<string>
	/** Echoed on the message's callbacks. */
	tag?: string
	[option: string]: unknown
}

type SendResponse = { id: string; segment_count?: number } & SmsReceipt

/**
 * Bandwidth — https://dev.bandwidth.com/docs/messaging/
 *
 * US carrier-owned network. JSON with Basic auth. Several numbers in one request are a
 * *group* message, everyone seeing everyone, so a send carries one recipient and an array
 * of sends reaches several people. MMS through `media`. Bandwidth takes an `expiration`,
 * but documents no limit on it, so `validity` is refused here rather than guessed at;
 * `provider_options: { expiration }` sets it directly. No scheduling.
 *
 * Errors are `{ type, description }`; a refusal's `reason` comes from the status.
 *
 * @example
 * ```ts
 * import Bandwidth from "postboi/bandwidth"
 *
 * const text = new Bandwidth({ account_id, username, password, application_id, default: { from: "+15550001111" } })
 * await text.send({ to: "+15557770006", message: "Your code is 4291" })
 * ```
 */
export default class Bandwidth extends SmsProvider<SendResponse> {
	protected readonly provider = "bandwidth"
	// US numbers and short codes; Bandwidth has no alphanumeric sender IDs.
	protected override readonly sender_kinds: ReadonlyArray<SmsSenderKind> = [
		"phone_number",
		"short_code",
	]
	protected override readonly single_recipient = true
	protected override readonly max_media = 10
	protected override readonly reserved_options = [
		"applicationId",
		"to",
		"from",
		"text",
		"media",
		"tag",
	]
	#account_id: string
	#auth: string
	#application_id: string

	constructor({ account_id, username, password, application_id, ...options }: Options) {
		super(options)
		this.#account_id = account_id
		this.#auth = `Basic ${btoa(`${username}:${password}`)}`
		this.#application_id = application_id
	}

	protected build_request(message: PreparedSms): RequestSpec {
		if (message.to.length !== 1) {
			// Several numbers in `to` would be one group message, everyone seeing everyone.
			throw new PostboiError({
				provider: this.provider,
				channel: "sms",
				code: "single_recipient_only",
				message:
					"Bandwidth sends to one recipient per message. Pass an array of sends instead of an array of recipients.",
			})
		}
		const body: SendParams = {
			applicationId: this.#application_id,
			to: message.to,
			from: message.from ?? "",
			text: message.message,
			media: message.media,
			tag: message.tags?.[0],
			...message.provider_options,
		}
		return {
			url: `https://messaging.bandwidth.com/api/v2/users/${encodeURIComponent(this.#account_id)}/messages`,
			headers: { Authorization: this.#auth, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const d = data as { id?: string; segmentCount?: number } | null
		return { ...this.receipt([d?.id]), segment_count: d?.segmentCount }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if ("id" in e) return undefined
		if (typeof e.description !== "string") return undefined
		return { message: e.description, code: typeof e.type === "string" ? e.type : undefined }
	}
}
