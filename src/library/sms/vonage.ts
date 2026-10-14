import { SmsProvider, type PreparedSms, type SmsProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError, type RejectionReason } from "../errors.js"
import { pem_to_der, to_base64url } from "../encoding.js"

/**
 * Options for the Vonage provider constructor. Either pair authenticates: the API key and
 * secret, or an application's id and private key. Use the application when the number is
 * linked to one, because Vonage refuses Basic auth for those, and an application is what
 * its webhooks are configured on.
 */
type Options = SmsProviderOptions & {
	api_key: string
	api_secret?: string
	application_id?: string
	/** The application's private key, PEM. Escaped newlines (`\n`) are accepted. */
	private_key?: string
	/** API region: `api` (the default), `api-eu`, `api-us` or `api-ap`. */
	region?: string
	/** Where Vonage posts this message's status, over the application's own setting. */
	webhook_url?: string
}

/** The Messages API payload for one SMS — https://developer.vonage.com/en/api/messages */
export interface SendParams {
	message_type: "text"
	channel: "sms"
	/** E.164 without the `+`. */
	to: string
	from: string
	text: string
	/** Echoed on the status webhook; up to 100 characters. */
	client_ref?: string
	webhook_url?: string
}

type SendResponse = { message_uuid: string }

/**
 * Vonage's Messages API error codes, by what they say about the refusal — from
 * https://developer.vonage.com/en/api-errors/messages. A code that isn't here is left to the
 * HTTP status (401 auth, 402 a low balance, 422 a bad request).
 */
const REASONS: Record<string, RejectionReason> = {
	"1000": "rate_limited", // Throttled: wait and retry
	"1241": "rate_limited", // Too many send requests
	"1472": "rate_limited", // Fraud Defender SMS burst protection: traffic limit reached
	"1060": "account", // Partner account barred
	"1080": "account", // Account not enabled for REST
	"1160": "account", // Non-whitelisted destination
	"1460": "account", // Daily message limit exceeded
	"1120": "sender", // Illegal sender address: the SenderID wasn't accepted locally
	"1420": "sender", // Invalid sender for the channel
	"1476": "sender", // Do Not Originate: the From is on a DNO list
	"1170": "recipient", // Invalid recipient
	"1190": "recipient", // Absent subscriber, permanent
	"1290": "recipient", // The recipient's pre-paid account can't receive
	"1430": "recipient", // Invalid recipient for the channel
	"1050": "compliance", // Number barred
	"1240": "compliance", // Illegal number: the recipient texted STOP
	"1210": "compliance", // Anti-spam rejection
	"1470": "compliance", // Fraud Defender traffic rule
}

/** How long a minted JWT is used for. Vonage accepts them for 15 minutes; this leaves room. */
const JWT_REUSE_S = 10 * 60
const JWT_LIFETIME_S = 15 * 60

const encoder = new TextEncoder()

/**
 * Vonage — https://developer.vonage.com/en/messaging/sms/overview
 *
 * Global, through the **Messages API** (`/v1/messages`), not the legacy SMS API: it answers
 * an HTTP status per request rather than a 200 with per-message codes, and signs its
 * webhooks. Numbers go over the wire without their `+`. One recipient per request, and no
 * scheduling, so a `scheduled_at` is refused rather than sent now.
 *
 * @example
 * ```ts
 * import Vonage from "postboi/vonage"
 *
 * const text = new Vonage({ api_key, api_secret, default: { from: "ACME" } })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export default class Vonage extends SmsProvider<SendResponse> {
	protected readonly provider = "vonage"
	#basic?: string
	#application?: { id: string; key: string }
	#jwt?: { token: string; until: number }
	#host: string
	#webhook_url?: string

	constructor({
		api_key,
		api_secret,
		application_id,
		private_key,
		region,
		webhook_url,
		...options
	}: Options) {
		super(options)
		if (application_id && private_key) {
			this.#application = { id: application_id, key: private_key.replace(/\\n/g, "\n") }
		} else if (api_key && api_secret) {
			this.#basic = `Basic ${btoa(`${api_key}:${api_secret}`)}`
		} else {
			throw new PostboiError({
				provider: "vonage",
				channel: "sms",
				code: "missing_env",
				message:
					"vonage needs VONAGE_API_SECRET, or VONAGE_APPLICATION_ID and VONAGE_PRIVATE_KEY, beside VONAGE_API_KEY.",
			})
		}
		this.#host = `https://${region || "api"}.nexmo.com`
		this.#webhook_url = webhook_url || undefined
	}

	/** An RS256 JWT for the application, minted once and reused until near its expiry. */
	async #bearer(): Promise<string> {
		const now = Math.floor(Date.now() / 1000)
		if (this.#jwt && this.#jwt.until > now) return this.#jwt.token
		const application = this.#application as { id: string; key: string }
		const header = to_base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
		const claims = {
			application_id: application.id,
			iat: now,
			exp: now + JWT_LIFETIME_S,
			jti: crypto.randomUUID(),
		}
		const signing_input = `${header}.${to_base64url(encoder.encode(JSON.stringify(claims)))}`
		const key = await crypto.subtle.importKey(
			"pkcs8",
			pem_to_der(application.key),
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["sign"]
		)
		const signature = await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			key,
			encoder.encode(signing_input)
		)
		const token = `${signing_input}.${to_base64url(new Uint8Array(signature))}`
		this.#jwt = { token: `Bearer ${token}`, until: now + JWT_REUSE_S }
		return this.#jwt.token
	}

	protected async build_request(message: PreparedSms): Promise<RequestSpec> {
		if (message.to.length !== 1) {
			throw new PostboiError({
				provider: this.provider,
				channel: "sms",
				code: "single_recipient_only",
				message:
					"Vonage sends to one recipient per message. Pass an array of sends instead of an array of recipients.",
			})
		}
		const body: SendParams = {
			message_type: "text",
			channel: "sms",
			to: message.to[0].replace(/^\+/, ""),
			from: (message.from ?? "").replace(/^\+/, ""),
			text: message.message,
			client_ref: message.tags?.[0]?.slice(0, 100),
			webhook_url: this.#webhook_url,
		}
		return {
			url: `${this.#host}/v1/messages`,
			headers: {
				Authorization: this.#basic ?? (await this.#bearer()),
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(body),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return { message_uuid: (data as { message_uuid?: string } | null)?.message_uuid ?? "" }
	}

	/**
	 * Errors are RFC 7807 problem details. The code is the fragment of `type`
	 * (`…/api-errors/messages#1420`) or, failing that, a numeric `title`.
	 */
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.title !== "string" && typeof e.detail !== "string") return undefined
		const fragment = typeof e.type === "string" ? e.type.split("#")[1] : undefined
		const code = fragment ?? (/^\d+$/.test(String(e.title)) ? String(e.title) : undefined)
		const message = [e.title, e.detail].filter((part) => typeof part === "string").join(": ")
		return {
			message: message || "Vonage refused the message",
			code,
			reason: code === "throttled" ? "rate_limited" : code ? REASONS[code] : undefined,
		}
	}
}
