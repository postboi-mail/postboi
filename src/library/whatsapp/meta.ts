import {
	WhatsappProvider,
	type PreparedWhatsapp,
	type TemplateValues,
	type WhatsappProviderOptions,
} from "./provider.js"
import type { RequestSpec } from "../transport.js"
import type { ProviderError } from "../errors.js"

/** Options for the Meta Cloud API provider constructor. */
type Options = WhatsappProviderOptions & {
	/** A System User access token with `whatsapp_business_messaging` permission. */
	access_token: string
	/** The phone number id of the sending number (not the number itself). */
	phone_number_id: string
	/**
	 * The WhatsApp Business Account id that owns your templates. Not used when sending —
	 * `bunx postboi sync` reads it to list your approved template names and narrow the
	 * `template` type to them.
	 */
	business_account_id?: string
	/** Graph API version. Defaults to a known-good one; override to pin another. */
	api_version?: string
}

type SendResponse = { id: string }

/**
 * Meta's error code for a free-form message sent outside the 24-hour customer service
 * window ("re-engagement message").
 */
const OUTSIDE_WINDOW = 131047

/**
 * WhatsApp via Meta's Cloud API —
 * https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * The direct route: no per-message platform fee on top of Meta's own pricing, at the cost
 * of Meta Business verification and token management. Templates are addressed by the
 * **name** they were approved under, plus a language code that must match an approved
 * translation.
 *
 * @example
 * ```ts
 * import Meta from "postboi/whatsapp-meta"
 *
 * const wa = new Meta({ access_token, phone_number_id })
 * await wa.send({
 *   to: "+447788223344",
 *   template: "order_shipped",
 *   variables: { name: "Ada", tracking: "AB123" },
 * })
 * ```
 */
export default class Meta extends WhatsappProvider<SendResponse> {
	protected readonly provider = "meta"
	// The Cloud API's sender is the phone_number_id in the URL — there is no `from` field.
	protected override requires_from = false
	#access_token: string
	#phone_number_id: string
	#api_version: string

	constructor({
		access_token,
		phone_number_id,
		api_version,
		business_account_id: _business_account_id,
		...options
	}: Options) {
		super(options)
		this.#access_token = access_token
		this.#phone_number_id = phone_number_id
		this.#api_version = api_version || "v23.0"
	}

	protected build_request(message: PreparedWhatsapp): RequestSpec {
		const payload: Record<string, unknown> = {
			messaging_product: "whatsapp",
			recipient_type: "individual",
			to: message.to,
		}
		if (message.template) {
			const parts = components(message)
			payload.type = "template"
			payload.template = {
				name: message.template,
				language: { code: message.language },
				...(parts.length > 0 ? { components: parts } : {}),
			}
		} else {
			payload.type = "text"
			payload.text = { body: message.message ?? "" }
		}

		return {
			url: `https://graph.facebook.com/${this.#api_version}/${encodeURIComponent(this.#phone_number_id)}/messages`,
			headers: {
				Authorization: `Bearer ${this.#access_token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const d = data as { messages?: Array<{ id?: string }> } | null
		return { id: d?.messages?.[0]?.id ?? "" }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = (data as { error?: { message?: string; code?: number; error_subcode?: number } })
			.error
		if (!e || typeof e.message !== "string") return undefined
		if (e.code === OUTSIDE_WINDOW) {
			return {
				message:
					"Outside the 24-hour customer service window, so free-form text can't be delivered. Send a pre-approved template instead. Check with whatsapp.closed(error).",
				code: "outside_window",
			}
		}
		return { message: e.message, code: e.code }
	}
}

/**
 * One component's parameters. Numeric keys mean a positional template (`{{1}}`), sent in
 * order; anything else means named parameters (`{{name}}`), which need `parameter_name`
 * on each entry. The same rule for every component, so the caller's key shape decides
 * once rather than per placement.
 */
function parameters(values: TemplateValues): Array<Record<string, unknown>> {
	// A bare string is the single value of a one-slot component (a header, a URL button) on
	// a positional template, where the parameter carries no name to give it.
	if (typeof values === "string") return [{ type: "text", text: values }]
	const entries = Object.entries(values)
	const positional = entries.every(([key]) => /^\d+$/.test(key))
	return positional
		? entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, text]) => ({ type: "text", text }))
		: entries.map(([parameter_name, text]) => ({ type: "text", parameter_name, text }))
}

/**
 * The Cloud API's `components` array. A template's placeholders aren't all in its body:
 * the header can hold one, and each dynamic button carries its own — sending only the
 * body silently drops those, and Meta rejects the whole send for the missing parameter.
 */
function components(message: PreparedWhatsapp): Array<Record<string, unknown>> {
	const parts: Array<Record<string, unknown>> = []
	// An empty string or map is "no values here", not "a component with no parameters" — the
	// latter is what Meta counts against the template's declared parameters and rejects.
	const filled = (values?: TemplateValues) =>
		typeof values === "string"
			? values || undefined
			: values && Object.keys(values).length > 0
				? values
				: undefined

	const header = filled(message.header)
	const body = filled(message.variables)
	if (header) parts.push({ type: "header", parameters: parameters(header) })
	if (body) parts.push({ type: "body", parameters: parameters(body) })
	message.buttons?.forEach((values, index) => {
		if (!filled(values)) return
		// ponytail: url sub_type — the only button kind whose parameter is a value you fill
		// in at send time. Quick-reply and copy-code buttons need their own sub_type if
		// they ever come up.
		parts.push({
			type: "button",
			sub_type: "url",
			index: String(index),
			parameters: parameters(values),
		})
	})
	return parts
}
