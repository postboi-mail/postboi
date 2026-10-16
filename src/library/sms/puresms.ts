import {
	SmsProvider,
	type PreparedSms,
	type SmsReceipt,
	type SmsApiKeyOptions,
	type SmsSenderKind,
} from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"

/** Options for the PureSMS provider constructor. */
type Options = SmsApiKeyOptions

/** One message on the PureSMS payload — https://the.divergent.guide/puresms/developers/ */
export interface SendParams {
	sender: string
	/** E.164, plus included. */
	recipient: string
	content: string
	/** ISO 8601 in UTC, for a scheduled send. */
	sendAtUtc?: string
	/** Echoed on the delivery receipt, so a webhook can correlate. */
	clientReference?: string
	[option: string]: unknown
}

/** `kind` says which endpoint `cancel` needs; `count` only comes back from a batch. */
type SendResponse = { id: string; kind: "message" | "batch"; count?: number } & SmsReceipt

/**
 * PureSMS — https://puresms.uk/developers
 *
 * UK-native, flat-rate pay-as-you-go and hosted in the EU. PureSMS is a brand on Divergent
 * Connect, which is why the API lives at `connect-api.divergent.cloud`.
 *
 * @example
 * ```ts
 * import PureSms from "postboi/puresms"
 *
 * const text = new PureSms({ api_key: PURESMS_API_KEY, default: { from: "POSTBOI" } })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export default class PureSms extends SmsProvider<SendResponse> {
	protected readonly provider = "puresms"
	// A UK number or an alphanumeric ID; no short codes.
	protected override readonly sender_kinds: ReadonlyArray<SmsSenderKind> = [
		"phone_number",
		"alphanumeric",
	]
	// `sendAtUtc` sits on the message for a single send and on the batch for bulk, and
	// `cancel` undoes either while it's still pending.
	protected override readonly supports_scheduling = true
	protected override readonly reserved_options = [
		"sender",
		"recipient",
		"content",
		"sendAtUtc",
		"clientReference",
	]
	#api_key: string
	#host = "https://connect-api.divergent.cloud"

	constructor({ api_key, ...options }: Options) {
		super(options)
		this.#api_key = api_key
	}

	#headers(json = true) {
		return { "X-Api-Key": this.#api_key, ...(json && { "Content-Type": "application/json" }) }
	}

	#params(message: PreparedSms, recipient: string, sendAtUtc?: string): SendParams {
		return {
			sender: message.from ?? "",
			recipient,
			content: message.message,
			sendAtUtc,
			clientReference: message.tags?.[0],
			...message.provider_options,
		}
	}

	protected build_request(message: PreparedSms): RequestSpec {
		const send_at = message.scheduled_at?.toISOString()
		// One recipient answers with a message id; several go to the bulk endpoint, which
		// takes fully-rendered messages and schedules the whole batch from the top level.
		if (message.to.length === 1) {
			const body = this.#params(message, message.to[0], send_at)
			return { url: `${this.#host}/sms/send`, headers: this.#headers(), body: JSON.stringify(body) }
		}
		const messages = message.to.map((to) => this.#params(message, to))
		return {
			url: `${this.#host}/sms/send/bulk`,
			headers: this.#headers(),
			body: JSON.stringify({ sendAtUtc: send_at, messages }),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const d = data as Record<string, unknown> | null
		// Ids are int64s serialised as strings; the bulk endpoint calls its one `batchId`.
		if (d?.batchId !== undefined) {
			const receipt = this.receipt([String(d.batchId)])
			return { ...receipt, kind: "batch", count: d.messageCount as number }
		}
		return { ...this.receipt([d?.id === undefined ? undefined : String(d.id)]), kind: "message" }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		// A batch that was only partly accepted answers 207 with the accepted count and one
		// entry per rejected message. That is `ok` to fetch, and no other provider resolves a
		// send that dropped a recipient, so it is a failure here too — `raw` keeps the batch
		// id and the count for a caller that wants to know what did go out.
		if (Array.isArray(e.errors) && e.errors.length > 0) {
			const rejected = e.errors.map((r) => JSON.stringify(r)).join("; ")
			return {
				message: `puresms rejected ${e.errors.length} message(s): ${rejected}`,
				code: "partial_batch",
				// The rest went: resending the batch would send them twice.
				partial: true,
			}
		}
		if ("id" in e || "batchId" in e) return undefined
		// Error bodies aren't documented. The platform is ASP.NET, so a rejection arrives as
		// RFC 7807 problem details — { title, detail } — with validation failures keyed by
		// field under `errors`, which is where the reason actually lives.
		const message = [e.detail, e.title, e.message].find((m) => typeof m === "string")
		if (!message) return undefined
		const fields = e.errors && typeof e.errors === "object" ? Object.values(e.errors).flat() : []
		return { message: [message, ...fields].join(" "), code: e.errorCode as string | undefined }
	}

	/**
	 * Cancel a scheduled send while it's still pending, passing the `kind` `send` returned
	 * so a batch id goes to the batch endpoint. Anything already sent surfaces as a normal
	 * `PostboiError`: a single message is refused with a 400, while a batch answers 200 with
	 * a `cancelledCount` that says how many were still pending, so zero is the failure here.
	 */
	async cancel(id: string, kind: "message" | "batch" = "message"): Promise<{ id: string }> {
		const path = kind === "batch" ? "bulk/" : ""
		const data = await this.call(
			{
				url: `${this.#host}/sms/send/${path}${encodeURIComponent(id)}`,
				method: "DELETE",
				headers: this.#headers(false),
			},
			"cancel"
		)
		const d = data as { cancelledCount?: number; reason?: string } | null
		if (kind === "batch" && d?.cancelledCount === 0) {
			throw new PostboiError({
				provider: this.provider,
				channel: this.channel,
				message: d.reason ?? `puresms cancelled nothing in batch ${id}`,
				raw: data,
			})
		}
		return { id }
	}
}
