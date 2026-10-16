import { SmsProvider, type PreparedSms, type SmsProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import type { ProviderError } from "../errors.js"

/** Options for the Plivo provider constructor. */
type Options = SmsProviderOptions & {
	/** Auth ID, from the Plivo console. */
	auth_id: string
	/** Auth token. */
	auth_token: string
	/** A Powerpack's UUID, to send from its number pool instead of a fixed `from`. */
	powerpack_uuid?: string
}

/** The Plivo send payload — https://www.plivo.com/docs/messaging/api/message/send-a-message */
export interface SendParams {
	src?: string
	powerpack_uuid?: string
	/** E.164 without the `+`; several joined with `<`. */
	dst: string
	text: string
	type?: "sms" | "mms"
	media_urls?: Array<string>
	/** Seconds Plivo queues the message before giving up, 5 to 10799. */
	message_expiry?: number
	[option: string]: unknown
}

type SendResponse = { message_uuid: Array<string>; api_id?: string }

/**
 * Plivo — https://www.plivo.com/docs/messaging
 *
 * Global, with MMS in the US and Canada. JSON with Basic auth (Auth ID and token). Several
 * recipients go in one request, joined with `<`, and each gets its own id in
 * `message_uuid`. No scheduling, so a `scheduled_at` is refused rather than sent now.
 *
 * Plivo doesn't document its error bodies, so a refusal's `reason` comes from the HTTP
 * status alone: a 401 is `auth`, a 429 `rate_limited`, anything else `request`.
 *
 * @example
 * ```ts
 * import Plivo from "postboi/plivo"
 *
 * const text = new Plivo({ auth_id, auth_token, default: { from: "+15550001111" } })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export default class Plivo extends SmsProvider<SendResponse> {
	protected readonly provider = "plivo"
	protected override readonly max_media = 10
	protected override readonly validity_range = [5, 10799] as const
	protected override readonly reserved_options = [
		"src",
		"powerpack_uuid",
		"dst",
		"text",
		"type",
		"media_urls",
		"message_expiry",
	]
	#auth_id: string
	#auth_token: string
	#powerpack_uuid?: string

	constructor({ auth_id, auth_token, powerpack_uuid, ...options }: Options) {
		super(options)
		this.#auth_id = auth_id
		this.#auth_token = auth_token
		this.#powerpack_uuid = powerpack_uuid || undefined
		// A Powerpack's number pool picks the sender.
		if (this.#powerpack_uuid) this.requires_from = false
	}

	protected build_request(message: PreparedSms): RequestSpec {
		const body: SendParams = {
			src: this.#powerpack_uuid ? undefined : message.from,
			powerpack_uuid: this.#powerpack_uuid,
			dst: message.to.map((to) => to.replace(/^\+/, "")).join("<"),
			text: message.message,
			...(message.media ? { type: "mms" as const, media_urls: message.media } : {}),
			message_expiry: message.validity,
			...message.provider_options,
		}
		return {
			url: `https://api.plivo.com/v1/Account/${encodeURIComponent(this.#auth_id)}/Message/`,
			headers: {
				Authorization: `Basic ${btoa(`${this.#auth_id}:${this.#auth_token}`)}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const d = data as { message_uuid?: Array<string>; api_id?: string } | null
		return { message_uuid: d?.message_uuid ?? [], api_id: d?.api_id }
	}

	/** Errors carry `{ api_id, error }`; the text is all there is. */
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if ("message_uuid" in e) return undefined
		if (typeof e.error === "string") return { message: e.error }
		return undefined
	}
}
