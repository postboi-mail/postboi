import {
	SmsProvider,
	type PreparedSms,
	type SmsReceipt,
	type SmsApiKeyOptions,
	type SmsSenderKind,
} from "./provider.js"
import type { RequestSpec } from "../transport.js"
import type { ProviderError } from "../errors.js"

/** Options for The SMS Works provider constructor. */
type Options = SmsApiKeyOptions

/** The SMS Works send payload — https://api.thesmsworks.co.uk/v1 */
export interface SendParams {
	sender: string
	destination: string
	content: string
	/** ISO 8601, for a scheduled send. */
	schedule?: string
	tag?: string
	/** Echoed back on the delivery report, so a webhook can correlate. */
	metadata?: Record<string, string>
	[option: string]: unknown
}

type SendResponse = { messageid: string; status: string; credits?: number } & SmsReceipt

/**
 * The SMS Works — https://thesmsworks.co.uk/developers
 *
 * UK-native, and the default UK recommendation: it bills only for messages that are
 * actually delivered, and its `/batch/any` endpoint takes fully-rendered per-recipient
 * messages, which is the same shape our batch fan-out already produces.
 *
 * @example
 * ```ts
 * import SmsWorks from "postboi/smsworks"
 *
 * const text = new SmsWorks({ api_key: SMSWORKS_API_KEY, default: { from: "POSTBOI" } })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export default class SmsWorks extends SmsProvider<SendResponse> {
	protected readonly provider = "smsworks"
	// A UK number or an alphanumeric ID; no short codes.
	protected override readonly sender_kinds: ReadonlyArray<SmsSenderKind> = [
		"phone_number",
		"alphanumeric",
	]
	// `/message/schedule` takes an ISO date on the same payload.
	protected override readonly supports_scheduling = true
	protected override readonly reserved_options = [
		"sender",
		"destination",
		"content",
		"schedule",
		"tag",
	]
	#api_key: string
	#host = "https://api.thesmsworks.co.uk/v1"

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	#params(message: PreparedSms, destination: string): SendParams {
		return {
			sender: message.from ?? "",
			destination: destination.replace(/^\+/, ""),
			content: message.message,
			schedule: message.scheduled_at?.toISOString(),
			tag: message.tags?.[0],
			...message.provider_options,
		}
	}

	protected build_request(message: PreparedSms): RequestSpec {
		const headers = {
			// The token is a long-lived JWT from the dashboard, passed bare (no "Bearer").
			Authorization: this.#api_key,
			"Content-Type": "application/json",
		}
		// Scheduled sends go to the dedicated schedule endpoints — /message/send would
		// deliver immediately and silently ignore the schedule field, which is precisely
		// the failure supports_scheduling exists to rule out.
		const scheduled = message.scheduled_at !== undefined
		// One recipient is the common case and returns a single message id; several go to
		// the batch endpoint, which takes fully-rendered messages per recipient.
		if (message.to.length === 1) {
			return {
				url: `${this.#host}/message/${scheduled ? "schedule" : "send"}`,
				headers,
				body: JSON.stringify(this.#params(message, message.to[0])),
			}
		}
		return {
			url: `${this.#host}/batch/${scheduled ? "schedule" : "any"}`,
			headers,
			body: JSON.stringify({ messages: message.to.map((to) => this.#params(message, to)) }),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const d = data as Record<string, unknown> | null
		// The batch endpoint answers with { batchid }, the single send with { messageid }.
		const id = (d?.messageid ?? d?.batchid) as string | undefined
		const status = d?.status as string | undefined
		return {
			// No status is no word on its state: `queued`, and `scheduled` for a scheduled send.
			...this.receipt([id], status),
			messageid: id ?? "",
			status: status ?? "sent",
			credits: d?.credits as number,
		}
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		// Errors come back as { status, errorCode, message }; a success carries messageid.
		if (typeof e.message === "string" && !("messageid" in e) && !("batchid" in e)) {
			return { message: e.message, code: (e.errorCode as string | number) ?? undefined }
		}
		return undefined
	}

	/**
	 * Cancel a scheduled message. Only works while it's still pending — the API rejects
	 * anything already sent, which surfaces as a normal `PostboiError`.
	 */
	async cancel(id: string): Promise<{ id: string }> {
		await this.call(
			{
				url: `${this.#host}/message/${encodeURIComponent(id)}`,
				method: "DELETE",
				headers: { Authorization: this.#api_key },
			},
			"cancel"
		)
		return { id }
	}
}
