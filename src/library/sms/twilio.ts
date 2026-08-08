import { SmsProvider, type PreparedSms, type SmsProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"
import {
	twilio_auth,
	twilio_messages_url,
	twilio_parse_error,
	twilio_parse_response,
	type TwilioSendResponse,
} from "../twilio_common.js"

/** Options for the Twilio provider constructor. */
type Options = SmsProviderOptions & {
	/** Account SID (starts `AC…`). */
	account_sid: string
	/** Auth token. */
	auth_token: string
	/**
	 * Messaging Service SID (`MG…`). Optional, but Twilio **requires** one to schedule a
	 * message, and it's how you get sender pools and automatic RCS upgrade.
	 */
	messaging_service_sid?: string
}

type SendResponse = TwilioSendResponse

/**
 * Twilio — https://www.twilio.com/docs/messaging/api/message-resource
 *
 * The global option, and the one every SMS example on the internet uses. Note the API is
 * form-encoded rather than JSON, and parameter names are PascalCase.
 *
 * Adding an RCS-capable sender to the Messaging Service makes Twilio upgrade eligible
 * messages to RCS automatically, with SMS fallback and no code change here.
 *
 * @example
 * ```ts
 * import Twilio from "postboi/twilio"
 *
 * const text = new Twilio({
 *   account_sid: TWILIO_ACCOUNT_SID,
 *   auth_token: TWILIO_AUTH_TOKEN,
 *   default: { from: "+15550001111" },
 * })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export default class Twilio extends SmsProvider<SendResponse> {
	protected readonly provider = "twilio"
	protected override readonly supports_scheduling = true
	#account_sid: string
	#auth_token: string
	#messaging_service_sid?: string

	constructor({ account_sid, auth_token, messaging_service_sid, ...options }: Options) {
		super(options)
		this.#account_sid = account_sid
		this.#auth_token = auth_token
		this.#messaging_service_sid = messaging_service_sid || undefined
		// A Messaging Service supplies the sender pool, so `from` is genuinely optional —
		// without this, the base class's no_sender guard rejects the standard
		// MessagingServiceSid-only setup before build_request's optional-From path can run.
		if (this.#messaging_service_sid) this.requires_from = false
	}

	protected build_request(message: PreparedSms): RequestSpec {
		if (message.to.length !== 1) {
			// Twilio's Message resource is one recipient per request. The batch fan-out in
			// Transport already turns an array of sends into individual calls, so reaching
			// here means several recipients on a *single* send — which would silently text
			// only the first.
			throw new PostboiError({
				provider: this.provider,
				channel: "sms",
				code: "single_recipient_only",
				message:
					"Twilio sends to one recipient per message — pass an array of sends instead of an array of recipients.",
			})
		}

		const body = new URLSearchParams()
		body.set("To", message.to[0])
		if (this.#messaging_service_sid) body.set("MessagingServiceSid", this.#messaging_service_sid)
		if (message.from) body.set("From", message.from)
		body.set("Body", message.message)
		if (message.scheduled_at) {
			if (!this.#messaging_service_sid) {
				throw new PostboiError({
					provider: this.provider,
					channel: "sms",
					code: "scheduling_needs_service",
					message:
						"Twilio can only schedule through a Messaging Service — construct the provider with { messaging_service_sid }.",
				})
			}
			body.set("ScheduleType", "fixed")
			body.set("SendAt", message.scheduled_at.toISOString())
		}

		return {
			url: twilio_messages_url(this.#account_sid),
			headers: {
				Authorization: twilio_auth(this.#account_sid, this.#auth_token),
				"Content-Type": "application/x-www-form-urlencoded",
				...(message.idempotency_key
					? { "I-Twilio-Idempotency-Token": message.idempotency_key }
					: {}),
			},
			body: body.toString(),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return twilio_parse_response(data)
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		return twilio_parse_error(data)
	}

	/** Cancel a scheduled message — only possible while its status is still `scheduled`. */
	async cancel(id: string): Promise<{ id: string }> {
		const response = await this.request({
			url: twilio_messages_url(this.#account_sid, id),
			headers: {
				Authorization: twilio_auth(this.#account_sid, this.#auth_token),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ Status: "canceled" }).toString(),
		})
		const data = await this.read_json(response)
		const error = this.error_for(response, data, "cancel")
		if (error) throw error
		return { id }
	}
}
