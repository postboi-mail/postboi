import { SmsProvider, type PreparedSms, type SmsProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"
import { sign_aws_request } from "../aws.js"

/** Options for the Amazon SNS provider constructor. */
type Options = SmsProviderOptions & {
	/** AWS access key ID. */
	access_key_id: string
	/** AWS secret access key. */
	secret_access_key: string
	/** AWS region, e.g. "eu-west-1". */
	region: string
	/** Optional STS session token, for temporary credentials. */
	session_token?: string
	/**
	 * SMS type. `Transactional` optimises for reliability (OTPs, alerts) and costs more;
	 * `Promotional` optimises for cost. Defaults to `Transactional`, because getting a
	 * one-time code delivered is the common case and the expensive failure.
	 */
	sms_type?: "Transactional" | "Promotional"
}

type SendResponse = { message_id: string }

/**
 * Amazon SNS `Publish` — https://docs.aws.amazon.com/sns/latest/api/API_Publish.html
 *
 * Nearly free to add given the SigV4 signer already exists for SES, and the cheapest
 * option if you're on AWS. The trade-off is sender identity: most regions don't let you
 * set a per-message sender ID, so `from` is treated as a sender ID **only where AWS
 * supports it** and ignored otherwise — which is why `requires_from` is false here.
 *
 * @example
 * ```ts
 * import SNS from "postboi/sns"
 *
 * const text = new SNS({
 *   access_key_id: AWS_ACCESS_KEY_ID,
 *   secret_access_key: AWS_SECRET_ACCESS_KEY,
 *   region: "eu-west-1",
 * })
 * await text.send({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export default class SNS extends SmsProvider<SendResponse> {
	protected readonly provider = "sns"
	// AWS attaches the sender identity account-side in most regions.
	protected override readonly requires_from = false
	#access_key_id: string
	#secret_access_key: string
	#session_token?: string
	#region: string
	#host: string
	#sms_type: "Transactional" | "Promotional"

	constructor({
		access_key_id,
		secret_access_key,
		region,
		session_token,
		sms_type,
		...options
	}: Options) {
		super(options)
		this.#access_key_id = access_key_id
		this.#secret_access_key = secret_access_key
		this.#session_token = session_token
		this.#region = region
		this.#host = `sns.${region}.amazonaws.com`
		this.#sms_type = sms_type ?? "Transactional"
	}

	protected async build_request(message: PreparedSms): Promise<RequestSpec> {
		if (message.to.length !== 1) {
			throw new PostboiError({
				provider: this.provider,
				channel: "sms",
				code: "single_recipient_only",
				message:
					"SNS publishes to one number per request — pass an array of sends instead of an array of recipients.",
			})
		}

		// Query-protocol form encoding, the same shape SES uses.
		const params = new URLSearchParams({
			Action: "Publish",
			Version: "2010-03-31",
			PhoneNumber: message.to[0],
			Message: message.message,
			"MessageAttributes.entry.1.Name": "AWS.SNS.SMS.SMSType",
			"MessageAttributes.entry.1.Value.DataType": "String",
			"MessageAttributes.entry.1.Value.StringValue": this.#sms_type,
		})
		if (message.from) {
			params.set("MessageAttributes.entry.2.Name", "AWS.SNS.SMS.SenderID")
			params.set("MessageAttributes.entry.2.Value.DataType", "String")
			params.set("MessageAttributes.entry.2.Value.StringValue", message.from)
		}

		const body = params.toString()
		const headers = await sign_aws_request(
			body,
			{
				service: "sns",
				region: this.#region,
				host: this.#host,
				path: "/",
				access_key_id: this.#access_key_id,
				secret_access_key: this.#secret_access_key,
				session_token: this.#session_token,
			},
			this.provider
		)
		return {
			url: `https://${this.#host}/`,
			// The signer defaults to JSON; the query protocol needs form encoding.
			headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
			body,
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		// SNS answers in XML, which read_json hands back as a string.
		const text = typeof data === "string" ? data : ""
		return { message_id: text.match(/<MessageId>([^<]+)<\/MessageId>/)?.[1] ?? "" }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		const text = typeof data === "string" ? data : ""
		if (!text.includes("<Error>")) return undefined
		return {
			message: text.match(/<Message>([^<]+)<\/Message>/)?.[1] ?? "SNS publish failed",
			code: text.match(/<Code>([^<]+)<\/Code>/)?.[1],
		}
	}
}
