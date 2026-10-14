import type { PreparedMessage, ApiKeyOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"

/** Options for the Klaviyo provider constructor. */
type Options = ApiKeyOptions & {
	/**
	 * The metric the event is filed under — the thing a flow in Klaviyo is triggered by.
	 * One metric per kind of mail ("Password reset", "Order shipped"), each with its own
	 * flow. Defaults to `"Postboi Email"`.
	 */
	metric?: string
	/**
	 * The API revision to pin, `YYYY-MM-DD`. Klaviyo versions its API by date and requires
	 * the header on every request; the default is the revision this provider was written
	 * against.
	 */
	revision?: string
	/** Event properties merged into every send, under the message's own. */
	properties?: Record<string, unknown>
}

export interface SendParams {
	data: {
		type: "event"
		attributes: {
			properties: Record<string, unknown>
			metric: { data: { type: "metric"; attributes: { name: string } } }
			profile: { data: { type: "profile"; attributes: { email: string } } }
			unique_id?: string
		}
	}
}

type SendResponse = { accepted: boolean }

/** The revision this provider's payload was written against. */
const REVISION = "2026-07-15"

/**
 * Klaviyo provider — https://developers.klaviyo.com/en/reference/create_event
 *
 * Klaviyo has no transactional send endpoint. What it has is **events**: you file one
 * against a profile, a flow in Klaviyo is triggered by it, and the flow's email is what
 * goes out. So this provider posts the send as an event — `subject`, `html`, `text`,
 * `from` and the recipient's `name` arrive as event properties for the flow's template to
 * place, and a [batch](https://docs.postboi.app/bulk) with `data` fills `{placeholders}`
 * before they go.
 *
 * Two things follow from that, and neither is hidden: **a flow has to exist** for the
 * metric (nothing is sent until one does, and Klaviyo answers 202 either way), and the
 * mail is composed in Klaviyo, so `cc`, `bcc`, attachments, `headers`, `tags`,
 * `scheduled_at` and `tracking` have no equivalent and are dropped. One recipient per
 * event; `idempotency_key` is forwarded as the event's `unique_id`, which is what makes a
 * retry file the same event rather than a second one.
 *
 * The key is a **private** key (`pk_…`) — a public site id can't create events.
 *
 * @example
 * ```ts
 * import Klaviyo from "postboi/klaviyo"
 *
 * const mail = new Klaviyo({ api_key: KLAVIYO_API_KEY, metric: "Password reset" })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class Klaviyo extends ProviderBase<SendResponse> {
	protected readonly provider = "klaviyo"
	// The flow's email names the sender; a send without `from` is fine.
	protected readonly requires_from = false
	#api_key: string
	#metric: string
	#revision: string
	#properties?: Record<string, unknown>

	constructor({ api_key, metric, revision, properties, ...options }: Options) {
		super(options)
		this.#api_key = api_key
		this.#metric = metric || "Postboi Email"
		this.#revision = revision || REVISION
		this.#properties = properties
	}

	protected build_request(message: PreparedMessage): RequestSpec {
		const to = this.single_recipient(
			message,
			"Klaviyo files one event per profile, and has no cc or bcc.",
			[message.cc, message.bcc]
		)

		const params: SendParams = {
			data: {
				type: "event",
				attributes: {
					properties: { ...this.#properties, ...this.template_fields(message, to) },
					metric: { data: { type: "metric", attributes: { name: this.#metric } } },
					profile: { data: { type: "profile", attributes: { email: to.address } } },
					unique_id: message.idempotency_key,
				},
			},
		}

		return {
			url: "https://a.klaviyo.com/api/events",
			headers: {
				Authorization: `Klaviyo-API-Key ${this.#api_key}`,
				revision: this.#revision,
				"Content-Type": "application/vnd.api+json",
				Accept: "application/vnd.api+json",
			},
			body: JSON.stringify(params),
			idempotent: Boolean(message.idempotency_key),
		}
	}

	// A created event is a 202 with no body: there is nothing to read but the acceptance.
	protected parse_response(_response: Response, data: unknown): SendResponse {
		return (data ?? { accepted: true }) as SendResponse
	}

	// Refusals are JSON:API — `{ errors: [{ code, title, detail, source: { pointer } }] }`.
	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const errors = (data as Record<string, unknown>).errors
		if (!Array.isArray(errors) || errors.length === 0) return undefined
		const first = errors[0] as Record<string, unknown>
		const source = first.source as Record<string, unknown> | undefined
		const detail = typeof first.detail === "string" ? first.detail : undefined
		const title = typeof first.title === "string" ? first.title : undefined
		const pointer = typeof source?.pointer === "string" ? source.pointer : undefined
		const message = detail ?? title ?? "klaviyo rejected the event"
		return {
			message: pointer ? `${message} (${pointer})` : message,
			code: typeof first.code === "string" ? first.code : undefined,
		}
	}
}
