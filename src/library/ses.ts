import type { PreparedMessage, CommonProviderOptions, ProviderError, RequestSpec } from "./index.js"
import { ProviderBase } from "./index.js"
// SigV4 signing lives in aws.ts so SNS (SMS) can reuse it — the service name is the only
// thing that differs, and it's baked into both the scope and the key derivation.
import { sign_aws_request } from "./aws.js"

/** Options for the Amazon SES (v2) provider constructor. */
type Options = CommonProviderOptions & {
	/** AWS access key ID. */
	access_key_id: string
	/** AWS secret access key. */
	secret_access_key: string
	/** AWS region, e.g. "us-east-1". */
	region: string
	/** Optional STS session token, for temporary credentials. */
	session_token?: string
}

interface Attachment {
	RawContent: string
	FileName: string
	ContentType: string
	ContentDisposition: "ATTACHMENT"
}

export interface SendParams {
	FromEmailAddress: string
	Destination: {
		ToAddresses: Array<string>
		CcAddresses?: Array<string>
		BccAddresses?: Array<string>
	}
	ReplyToAddresses?: Array<string>
	Content: {
		Simple: {
			Subject: { Data: string }
			Body: { Html?: { Data: string }; Text?: { Data: string } }
			Headers?: Array<{ Name: string; Value: string }>
			Attachments?: Array<Attachment>
		}
	}
	EmailTags?: Array<{ Name: string; Value: string }>
}

type SendResponse = { MessageId: string }

/**
 * Amazon SES v2 SendEmail provider — https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
 *
 * SES is the only provider that authenticates with AWS Signature Version 4 rather than a
 * bearer token, so each request is signed inline (no AWS SDK dependency).
 *
 * @example
 * ```ts
 * import SES from "postboi/ses"
 *
 * const mail = new SES({
 *   access_key_id: AWS_ACCESS_KEY_ID,
 *   secret_access_key: AWS_SECRET_ACCESS_KEY,
 *   region: "us-east-1",
 *   default: { from: "no-reply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hello world</p>" })
 * ```
 */
export default class SES extends ProviderBase<SendResponse> {
	protected readonly provider = "ses"
	#access_key_id: string
	#secret_access_key: string
	#session_token?: string
	#region: string
	#host: string
	#path = "/v2/email/outbound-emails"

	constructor({ access_key_id, secret_access_key, region, session_token, ...options }: Options) {
		super(options)
		this.#access_key_id = access_key_id
		this.#secret_access_key = secret_access_key
		this.#session_token = session_token
		this.#region = region
		this.#host = `email.${region}.amazonaws.com`
	}

	protected async build_request(message: PreparedMessage): Promise<RequestSpec> {
		const params: SendParams = {
			FromEmailAddress: this.stringify_address(this.parse_email_address(message.from)),
			Destination: {
				ToAddresses: this.parse_addresses(message.to).map((a) => this.stringify_address(a)),
				CcAddresses: message.cc
					? this.parse_addresses(message.cc).map((a) => this.stringify_address(a))
					: undefined,
				BccAddresses: message.bcc
					? this.parse_addresses(message.bcc).map((a) => this.stringify_address(a))
					: undefined,
			},
			ReplyToAddresses: message.reply_to
				? this.parse_addresses(message.reply_to).map((a) => this.stringify_address(a))
				: undefined,
			Content: {
				Simple: {
					Subject: { Data: message.subject },
					Body: {
						Html: message.html ? { Data: message.html } : undefined,
						Text: message.text ? { Data: message.text } : undefined,
					},
					Headers: message.headers
						? Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value }))
						: undefined,
					Attachments: message.attachments
						? (await this.parse_attachments(message.attachments)).map((a) => ({
								RawContent: a.content,
								FileName: a.name,
								ContentType: a.mime_type,
								ContentDisposition: "ATTACHMENT" as const,
							}))
						: undefined,
				},
			},
			EmailTags: message.tags?.map((t, i) => ({ Name: `tag${i}`, Value: t })),
		}

		const body = JSON.stringify(params)
		return {
			url: `https://${this.#host}${this.#path}`,
			headers: await this.#sign(body),
			body,
		}
	}

	/** Build SigV4-signed headers for a POST of `body` to the SES endpoint. */
	async #sign(body: string): Promise<Record<string, string>> {
		return sign_aws_request(
			body,
			{
				service: "ses",
				region: this.#region,
				host: this.#host,
				path: this.#path,
				access_key_id: this.#access_key_id,
				secret_access_key: this.#secret_access_key,
				session_token: this.#session_token,
			},
			this.provider
		)
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return data as SendResponse
	}

	protected parse_error(response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		const e = data as Record<string, unknown>
		// SES errors come back as { message } (sometimes { Message }) with the type in a header.
		const message = (e.message ?? e.Message) as string | undefined
		if (typeof message !== "string" || "MessageId" in e) return undefined
		const type = response.headers.get("x-amzn-errortype") ?? undefined
		// Header form is "BadRequestException:" or "BadRequestException:http://..." — keep the name.
		return { message, code: type?.split(/[:;]/)[0] || undefined }
	}
}
