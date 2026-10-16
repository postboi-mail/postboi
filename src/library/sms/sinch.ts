import { SmsProvider, type PreparedSms, type SmsProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import type { ProviderError } from "../errors.js"

/** Options for the Sinch provider constructor. */
type Options = SmsProviderOptions & {
	/** Service plan ID, from the dashboard. */
	service_plan_id: string
	/** API token for that service plan. */
	api_token: string
	/** Region: `us` (the default), `eu`, `au`, `br` or `ca`. */
	region?: string
	/** Where Sinch posts this batch's delivery reports, over the plan's own setting. */
	callback_url?: string
}

/** The Sinch batch payload — https://developers.sinch.com/docs/sms/api-reference/ */
export interface SendParams {
	from?: string
	/** E.164, up to 1000. */
	to: Array<string>
	body: string
	/** ISO 8601, to send later. */
	send_at?: string
	/** ISO 8601; sending stops then. At most three days after `send_at`. */
	expire_at?: string
	client_reference?: string
	callback_url?: string
	delivery_report?: string
	[option: string]: unknown
}

type SendResponse = { id: string }

/** Three days, the most Sinch keeps trying. */
const MAX_VALIDITY = 3 * 24 * 60 * 60

/**
 * Sinch — https://developers.sinch.com/docs/sms/
 *
 * Global, through the SMS API's batches: one request takes up to 1000 recipients and
 * answers one batch id. `send_at` schedules, and `validity` becomes `expire_at`, measured
 * from the send (or the scheduled time). The first tag rides along as `client_reference`,
 * which Sinch echoes on its delivery reports.
 *
 * Sinch's error bodies are `{ code, text }`; a refusal's `reason` comes from the status.
 *
 * @example
 * ```ts
 * import Sinch from "postboi/sinch"
 *
 * const text = new Sinch({ service_plan_id, api_token, region: "eu", default: { from: "ACME" } })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export default class Sinch extends SmsProvider<SendResponse> {
	protected readonly provider = "sinch"
	protected override readonly supports_scheduling = true
	protected override readonly validity_range = [1, MAX_VALIDITY] as const
	protected override readonly reserved_options = [
		"from",
		"to",
		"body",
		"send_at",
		"expire_at",
		"client_reference",
		"callback_url",
	]
	#service_plan_id: string
	#api_token: string
	#host: string
	#callback_url?: string

	constructor({ service_plan_id, api_token, region, callback_url, ...options }: Options) {
		super(options)
		this.#service_plan_id = service_plan_id
		this.#api_token = api_token
		this.#host = `https://${region || "us"}.sms.api.sinch.com`
		this.#callback_url = callback_url || undefined
	}

	protected build_request(message: PreparedSms): RequestSpec {
		const starts = message.scheduled_at ?? new Date()
		const body: SendParams = {
			from: message.from,
			to: message.to,
			body: message.message,
			send_at: message.scheduled_at?.toISOString(),
			expire_at:
				message.validity !== undefined
					? new Date(starts.getTime() + message.validity * 1000).toISOString()
					: undefined,
			client_reference: message.tags?.[0],
			callback_url: this.#callback_url,
			// Sinch posts no delivery report at all unless asked for one ("none" is its default),
			// so a callback URL alone would never be called.
			delivery_report: this.#callback_url ? "per_recipient" : undefined,
			...message.provider_options,
		}
		return {
			url: `${this.#host}/xms/v1/${encodeURIComponent(this.#service_plan_id)}/batches`,
			headers: { Authorization: `Bearer ${this.#api_token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return { id: (data as { id?: string } | null)?.id ?? "" }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if ("id" in e) return undefined
		if (typeof e.text !== "string") return undefined
		return { message: e.text, code: typeof e.code === "string" ? e.code : undefined }
	}
}
