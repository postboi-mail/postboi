/**
 * AWS Signature Version 4 request signing, shared by every AWS-backed provider.
 *
 * AWS is the only vendor we talk to that doesn't authenticate with a bearer token, so each
 * request is signed inline rather than pulling in the AWS SDK. Parameterised by service
 * (`ses`, `sns`, …) because the service name is baked into both the credential scope and
 * the signing key derivation.
 *
 * Internal: not part of the public surface.
 */
import { PostboiError } from "./errors.js"

/** The credentials and target an AWS request is signed against. */
export type AwsSigningOptions = {
	/** AWS service name, e.g. "ses" or "sns" — part of the credential scope. */
	service: string
	/** AWS region, e.g. "eu-west-1". */
	region: string
	/** Host header the request goes to, e.g. "email.eu-west-1.amazonaws.com". */
	host: string
	/** Request path, e.g. "/v2/email/outbound-emails". */
	path: string
	access_key_id: string
	secret_access_key: string
	/** Optional STS session token, for temporary credentials. */
	session_token?: string
}

// Loaded lazily (same pattern as env.ts) so bundlers targeting non-node platforms —
// Convex, workers without nodejs_compat — can bundle the zero-config mail() without
// resolving node:crypto. esbuild demotes an unresolvable dynamic import to a warning
// only when it sits in a try block, so the try is load-bearing.
let node_crypto: typeof import("node:crypto") | undefined

/**
 * Load `node:crypto`, throwing a provider-attributed {@link PostboiError} where it isn't
 * available. `provider` is passed through so the message names the provider the caller was
 * actually using rather than this helper.
 */
export async function load_crypto(provider: string): Promise<typeof import("node:crypto")> {
	if (node_crypto) return node_crypto
	try {
		return (node_crypto = await import("node:crypto"))
	} catch {
		throw new PostboiError({
			provider,
			message: `The ${provider} provider needs a Node.js runtime — node:crypto is unavailable here.`,
			code: "node_required",
		})
	}
}

/**
 * Build SigV4-signed headers for a POST of `body`. Returns the full header set, including
 * `Content-Type: application/json` and the `Authorization` signature.
 */
export async function sign_aws_request(
	body: string,
	options: AwsSigningOptions,
	provider: string
): Promise<Record<string, string>> {
	const { createHash, createHmac } = await load_crypto(provider)
	const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex")
	const hmac = (key: string | Buffer, data: string) =>
		createHmac("sha256", key).update(data, "utf8").digest()
	// e.g. 20260629T120000Z / 20260629
	const amz_date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
	const date = amz_date.slice(0, 8)
	const payload_hash = sha256(body)

	const signed_headers = options.session_token
		? "host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
		: "host;x-amz-content-sha256;x-amz-date"
	const canonical_headers =
		`host:${options.host}\n` +
		`x-amz-content-sha256:${payload_hash}\n` +
		`x-amz-date:${amz_date}\n` +
		(options.session_token ? `x-amz-security-token:${options.session_token}\n` : "")

	const canonical_request = [
		"POST",
		options.path,
		"",
		canonical_headers,
		signed_headers,
		payload_hash,
	].join("\n")

	const scope = `${date}/${options.region}/${options.service}/aws4_request`
	const string_to_sign = ["AWS4-HMAC-SHA256", amz_date, scope, sha256(canonical_request)].join("\n")

	const k_date = hmac(`AWS4${options.secret_access_key}`, date)
	const k_region = hmac(k_date, options.region)
	const k_service = hmac(k_region, options.service)
	const k_signing = hmac(k_service, "aws4_request")
	const signature = createHmac("sha256", k_signing).update(string_to_sign, "utf8").digest("hex")

	return {
		"Content-Type": "application/json",
		"X-Amz-Date": amz_date,
		"X-Amz-Content-Sha256": payload_hash,
		...(options.session_token ? { "X-Amz-Security-Token": options.session_token } : {}),
		Authorization: `AWS4-HMAC-SHA256 Credential=${options.access_key_id}/${scope}, SignedHeaders=${signed_headers}, Signature=${signature}`,
	}
}
