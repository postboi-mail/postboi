import type { PreparedMessage, CommonProviderOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"
import { read_env, env_defaults } from "./env.js"

// Pull the generated-types placeholder into the compile graph: its `.d.ts` is what
// `bunx postboi sync` overwrites in node_modules to narrow `from` (a no-op at runtime).
import "./register.js"
// Re-export the core so `import { PostboiError, SkipSendError, ... } from "postboi"` keeps working
// from the package root.
export * from "./index.js"
// The zero-config `mail()` and provider dispatch are general (not Cloud-specific) but belong
// on the package root, so re-export them here.
export { mail } from "./mail.js"

/** Options for the Postboi Cloud provider. */
export type CloudOptions = CommonProviderOptions & {
	/** Postboi Cloud token. Defaults to the `POSTBOI_TOKEN` environment variable. */
	token?: string
	/** Override the API base URL. Defaults to `POSTBOI_API_URL` or `https://postboi.email`. */
	base_url?: string
}

interface EmailName {
	email: string
	name?: string
}

interface Attachment {
	content: string
	filename: string
	type: string
}

export interface SendParams {
	/** Omitted = the API uses the account's sending address. */
	from?: EmailName
	to: Array<EmailName>
	cc?: Array<EmailName>
	bcc?: Array<EmailName>
	reply_to?: EmailName
	subject: string
	html?: string
	text?: string
	headers?: Record<string, string>
	tags?: Array<string>
	attachments?: Array<Attachment>
	scheduled_at?: string
	/** Managed-captcha Turnstile token from the form, verified server-side by the API. */
	captcha_token?: string
	/** True when the send originated from a form submission — the only sends captcha gates. */
	form?: boolean
}

type SendResponse = { id: string }

/**
 * Postboi Cloud — the zero-config provider, and the package's default export.
 *
 * Run `bunx postboi init` to authenticate and write `POSTBOI_TOKEN` to your environment,
 * then just construct it with no arguments:
 *
 * @example
 * ```ts
 * import Postboi from "postboi"
 *
 * const mail = new Postboi() // reads POSTBOI_TOKEN
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hi</p>" })
 * ```
 *
 * The token can still be passed explicitly (`new Postboi({ token })`), which is required
 * in runtimes that don't expose ambient env vars (e.g. Cloudflare Workers).
 */
export default class Postboi extends ProviderBase<SendResponse> {
	protected readonly provider = "postboi"
	// The API defaults `from` to the account's sending address, so none is required here.
	protected override readonly requires_from = false
	// Turnstile tokens are verified by the API against the account's managed widget —
	// FormData sends need no local secret key.
	protected override readonly managed_captcha = true
	#token: string | undefined
	#url: string

	constructor({ token, base_url, ...options }: CloudOptions = {}) {
		// Defaults can come from the environment (POSTBOI_FROM, …); anything passed
		// explicitly via `default` wins.
		super({ ...options, default: { ...env_defaults(), ...options.default } })
		this.#token = token ?? read_env("POSTBOI_TOKEN")
		const host = base_url ?? read_env("POSTBOI_API_URL") ?? "https://postboi.email"
		this.#url = `${host.replace(/\/$/, "")}/v1/send`
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		if (!this.#token) {
			throw new PostboiError({
				provider: this.provider,
				message:
					"No Postboi token found. Run `bunx postboi init`, set POSTBOI_TOKEN, or pass { token }.",
				code: "no_token",
			})
		}

		const params: SendParams = {
			from: message.from ? this.email_name(this.parse_email_address(message.from)) : undefined,
			to: this.email_name_list(message.to),
			cc: message.cc ? this.email_name_list(message.cc) : undefined,
			bcc: message.bcc ? this.email_name_list(message.bcc) : undefined,
			reply_to: message.reply_to ? this.email_name_list(message.reply_to)[0] : undefined,
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: message.headers,
			tags: message.tags,
			attachments: message.attachments
				? (await this.parse_attachments(message.attachments)).map((a) => ({
						content: a.content,
						filename: a.name,
						type: a.mime_type,
					}))
				: undefined,
			scheduled_at: message.scheduled_at?.toISOString(),
			captcha_token: message.captcha?.token,
			form: message.captcha ? true : undefined,
		}

		return {
			url: this.#url,
			headers: {
				Authorization: `Bearer ${this.#token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		if (typeof e.message === "string" && !("id" in e)) {
			return { message: e.message, code: typeof e.code === "string" ? e.code : undefined }
		}
		return undefined
	}
}
