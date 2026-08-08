import {
	WhatsappProvider,
	type PreparedWhatsapp,
	type WhatsappProviderOptions,
} from "./provider.js"
import type { RequestSpec } from "../transport.js"
import type { ProviderError } from "../errors.js"
import {
	twilio_auth,
	twilio_messages_url,
	twilio_parse_error,
	twilio_parse_response,
	type TwilioSendResponse,
} from "../twilio_common.js"

/** Options for the Twilio WhatsApp provider constructor. */
type Options = WhatsappProviderOptions & {
	/** Account SID (starts `AC…`) — the same credentials as Twilio SMS. */
	account_sid: string
	/** Auth token. */
	auth_token: string
	/**
	 * Messaging Service SID (`MG…`). Optional — a service with a WhatsApp sender attached
	 * supplies the sender, making `from` unnecessary.
	 */
	messaging_service_sid?: string
}

type SendResponse = TwilioSendResponse

/**
 * Twilio's error code for a free-form message sent outside the 24-hour customer service
 * window — the one WhatsApp failure every caller needs to recognise.
 */
const OUTSIDE_WINDOW = 63016

/**
 * WhatsApp via Twilio — https://www.twilio.com/docs/whatsapp/api
 *
 * The same Message resource as Twilio SMS with `whatsapp:`-prefixed addresses (the prefix
 * is added for you), and the cheaper way in than Meta directly if you're already on
 * Twilio. Templates are Twilio **Content SIDs** (`HX…`, from the Content Template
 * Builder), not Meta template names.
 *
 * @example
 * ```ts
 * import TwilioWhatsapp from "postboi/whatsapp-twilio"
 *
 * const wa = new TwilioWhatsapp({
 *   account_sid: TWILIO_ACCOUNT_SID,
 *   auth_token: TWILIO_AUTH_TOKEN,
 *   default: { from: "+14155238886" },
 * })
 * await wa.send({ to: "+447788223344", template: "HXb5b62575e6e4ff6129ad7c8efe1f983e" })
 * ```
 */
export default class TwilioWhatsapp extends WhatsappProvider<SendResponse> {
	protected readonly provider = "twilio"
	#account_sid: string
	#auth_token: string
	#messaging_service_sid?: string

	constructor({ account_sid, auth_token, messaging_service_sid, ...options }: Options) {
		super(options)
		this.#account_sid = account_sid
		this.#auth_token = auth_token
		this.#messaging_service_sid = messaging_service_sid || undefined
		// A Messaging Service with a WhatsApp sender supplies `from`, same as Twilio SMS.
		if (this.#messaging_service_sid) this.requires_from = false
	}

	protected build_request(message: PreparedWhatsapp): RequestSpec {
		const body = new URLSearchParams()
		body.set("To", prefixed(message.to))
		if (this.#messaging_service_sid) body.set("MessagingServiceSid", this.#messaging_service_sid)
		if (message.from) body.set("From", prefixed(message.from))
		if (message.template) {
			body.set("ContentSid", message.template)
			if (message.variables) body.set("ContentVariables", JSON.stringify(message.variables))
		} else {
			body.set("Body", message.message ?? "")
		}

		return {
			url: twilio_messages_url(this.#account_sid),
			headers: {
				Authorization: twilio_auth(this.#account_sid, this.#auth_token),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: body.toString(),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return twilio_parse_response(data)
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		const error = twilio_parse_error(data)
		// The one WhatsApp-specific mapping: outside the 24-hour customer service window.
		if (error?.code === OUTSIDE_WINDOW) {
			return {
				message:
					"Outside the 24-hour customer service window — free-form text can't be delivered. Send a pre-approved template instead. Check with whatsapp.closed(error).",
				code: "outside_window",
			}
		}
		return error
	}
}

/** Twilio addresses WhatsApp with a `whatsapp:` prefix on ordinary E.164 numbers. */
function prefixed(number: string): string {
	return number.startsWith("whatsapp:") ? number : `whatsapp:${number}`
}
