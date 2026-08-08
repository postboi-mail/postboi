import { PushProvider, type PreparedPush, type PushProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"
import { base64_decode, to_base64url } from "../encoding.js"

/** Options for the FCM provider constructor. */
type Options = PushProviderOptions & {
	/** Firebase project id. */
	project_id: string
	/** Service-account email (`client_email` in the downloaded JSON). */
	client_email: string
	/** Service-account private key (`private_key`), PEM. */
	private_key: string
}

type SendResponse = { name: string }

const encoder = new TextEncoder()

/**
 * OAuth tokens per service account, shared across instances. Module-level on purpose: the
 * zero-config push() constructs a fresh provider per call (as mail() and sms() do), and an
 * instance-level cache would silently turn every notification into two HTTPS requests.
 * Storing the in-flight promise also means concurrent cold sends share one exchange
 * instead of stampeding the token endpoint.
 */
const token_cache = new Map<string, Promise<{ value: string; expires_at: number }>>()

/** Strip the PEM armour and decode the base64 body into DER bytes. */
function pem_to_der(pem: string): Uint8Array<ArrayBuffer> {
	const body = pem
		.replace(/-----BEGIN [^-]+-----/, "")
		.replace(/-----END [^-]+-----/, "")
		// Service-account JSON stores the key with literal "\n" sequences.
		.replace(/\\n/g, "")
		.replace(/\s/g, "")
	return base64_decode(body)
}

/**
 * Firebase Cloud Messaging (HTTP v1) —
 * https://firebase.google.com/docs/cloud-messaging/send-message
 *
 * Unlike every other provider here, the credential isn't the token we send: a service
 * account JWT is exchanged for a short-lived OAuth2 access token first. That exchange is
 * far too slow to do per message, so the token is cached until just before it expires.
 *
 * @example
 * ```ts
 * import FCM from "postboi/fcm"
 *
 * const notify = new FCM({
 *   project_id: "my-app",
 *   client_email: process.env.FCM_CLIENT_EMAIL,
 *   private_key: process.env.FCM_PRIVATE_KEY,
 * })
 * await notify.send({ to: device_token, title: "Order shipped", message: "On its way" })
 * ```
 */
export default class FCM extends PushProvider<SendResponse> {
	protected readonly provider = "fcm"
	#project_id: string
	#client_email: string
	#private_key: string

	constructor({ project_id, client_email, private_key, ...options }: Options) {
		super(options)
		this.#project_id = project_id
		this.#client_email = client_email
		this.#private_key = private_key
	}

	/**
	 * Mint (or reuse) an OAuth2 access token. Cached with a minute of headroom so a token
	 * can't expire between the check and the request that uses it, and keyed by service
	 * account so separate FCM instances (and the per-call zero-config path) share it.
	 */
	async #access_token(): Promise<string> {
		const now = Date.now()
		const cached = token_cache.get(this.#client_email)
		if (cached) {
			try {
				const token = await cached
				if (token.expires_at > now + 60_000) return token.value
			} catch {
				// A failed exchange must not poison the cache — fall through and retry.
			}
		}
		const pending = this.#exchange(now)
		token_cache.set(this.#client_email, pending)
		try {
			return (await pending).value
		} catch (error) {
			token_cache.delete(this.#client_email)
			throw error
		}
	}

	/** The actual JWT sign + token exchange. Only reached on a cold or expiring cache. */
	async #exchange(now: number): Promise<{ value: string; expires_at: number }> {
		const claims = {
			iss: this.#client_email,
			scope: "https://www.googleapis.com/auth/firebase.messaging",
			aud: "https://oauth2.googleapis.com/token",
			exp: Math.floor(now / 1000) + 3600,
			iat: Math.floor(now / 1000),
		}
		const header = to_base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
		const payload = to_base64url(encoder.encode(JSON.stringify(claims)))
		const signing_input = `${header}.${payload}`

		const key = await crypto.subtle.importKey(
			"pkcs8",
			pem_to_der(this.#private_key),
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["sign"]
		)
		const signature = await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			key,
			encoder.encode(signing_input)
		)
		const assertion = `${signing_input}.${to_base64url(new Uint8Array(signature))}`

		const response = await this.request({
			url: "https://oauth2.googleapis.com/token",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion,
			}).toString(),
		})
		const data = (await this.read_json(response)) as {
			access_token?: string
			expires_in?: number
			error_description?: string
		} | null
		if (!response.ok || !data?.access_token) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				status: response.status,
				code: "oauth_failed",
				message: `FCM token exchange failed: ${data?.error_description ?? response.status}`,
				raw: data,
			})
		}
		return {
			value: data.access_token,
			expires_at: now + (data.expires_in ?? 3600) * 1000,
		}
	}

	protected async build_request(message: PreparedPush): Promise<RequestSpec> {
		if (typeof message.to !== "string") {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "invalid_target",
				message:
					"FCM needs a device registration token, not a Web Push subscription object. A subscription belongs to postboi/webpush.",
			})
		}

		const token = await this.#access_token()
		return {
			url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.#project_id)}/messages:send`,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				message: {
					token: message.to,
					notification: { title: message.title, body: message.message },
					// FCM data values must all be strings, so anything structured is stringified
					// rather than silently dropped.
					data: {
						...(message.url ? { url: message.url } : {}),
						...Object.fromEntries(
							Object.entries(message.data ?? {}).map(([k, v]) => [
								k,
								typeof v === "string" ? v : JSON.stringify(v),
							])
						),
					},
					android: {
						ttl: `${message.ttl}s`,
						priority: message.urgency === "high" ? "high" : "normal",
					},
				},
			}),
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return { name: (data as { name?: string } | null)?.name ?? "" }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		const error = (data as { error?: { message?: string; status?: string } } | null)?.error
		if (error?.message) return { message: error.message, code: error.status }
		return undefined
	}
}
