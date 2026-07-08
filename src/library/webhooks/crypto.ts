/**
 * WebCrypto-only primitives for webhook signature verification. `crypto.subtle` is used
 * (never `node:crypto`) so verification runs anywhere postboi does — Node, Bun, Deno,
 * Cloudflare Workers and other edge runtimes.
 */

const encoder = new TextEncoder()

/** Decode standard base64 into bytes. */
export function base64_decode(value: string): Uint8Array {
	const bin = atob(value)
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
	return bytes
}

/** Encode bytes as standard base64. */
export function base64_encode(bytes: Uint8Array): string {
	let bin = ""
	for (const byte of bytes) bin += String.fromCharCode(byte)
	return btoa(bin)
}

/** Encode bytes as lowercase hex. */
export function hex_encode(bytes: Uint8Array): string {
	let out = ""
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
	return out
}

/**
 * Constant-time string comparison. Always walks the full longest length so a mismatch
 * position can't be inferred from timing.
 */
export function timing_safe_equal(a: string, b: string): boolean {
	const length = Math.max(a.length, b.length)
	let diff = a.length === b.length ? 0 : 1
	for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
	return diff === 0
}

async function hmac(hash: "SHA-1" | "SHA-256", key: Uint8Array, data: string): Promise<Uint8Array> {
	const imported = await crypto.subtle.importKey(
		"raw",
		key as BufferSource,
		{ name: "HMAC", hash },
		false,
		["sign"]
	)
	return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(data)))
}

/** HMAC-SHA256 of `data`. A string key is used as its UTF-8 bytes. */
export function hmac_sha256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
	return hmac("SHA-256", typeof key === "string" ? encoder.encode(key) : key, data)
}

/** HMAC-SHA1 of `data` (Mandrill's scheme). A string key is used as its UTF-8 bytes. */
export function hmac_sha1(key: Uint8Array | string, data: string): Promise<Uint8Array> {
	return hmac("SHA-1", typeof key === "string" ? encoder.encode(key) : key, data)
}

/** The outcome of a {@link svix_verify} check. */
export type SvixVerdict = "ok" | "stale_timestamp" | "invalid_signature"

/**
 * Verify a Svix / standard-webhooks signature (Resend, and the Postboi provider's own
 * compatible scheme): HMAC-SHA256 of `id.timestamp.body` with the base64 key inside the
 * `whsec_` secret, matched (timing-safe) against any `v1,<base64>` entry in the
 * space-joined signature header, with timestamp tolerance for replay protection.
 */
export async function svix_verify(options: {
	secret: string
	id: string
	timestamp: string
	body: string
	/** The raw signature header value — space-joined `v1,<base64>` entries. */
	signatures: string
	/** Allowed clock skew in seconds. Defaults to 300 (5 minutes). */
	tolerance_s?: number
	/** Current unix time in seconds — injectable for tests. */
	now_s?: number
}): Promise<SvixVerdict> {
	const tolerance = options.tolerance_s ?? 300
	const timestamp = Number(options.timestamp)
	const now = options.now_s ?? Math.floor(Date.now() / 1000)
	if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > tolerance) {
		return "stale_timestamp"
	}

	const key = base64_decode(options.secret.replace(/^whsec_/, ""))
	const signed = `${options.id}.${options.timestamp}.${options.body}`
	const expected = base64_encode(await hmac_sha256(key, signed))

	for (const entry of options.signatures.split(" ")) {
		const [version, signature] = entry.split(",")
		if (version === "v1" && signature && timing_safe_equal(signature, expected)) return "ok"
	}
	return "invalid_signature"
}

/**
 * Verify an ECDSA P-256 / SHA-256 signature (SendGrid's signed event webhook).
 * `public_key` is the base64 SPKI key from the SendGrid dashboard; `signature` is the
 * base64 DER signature header. WebCrypto expects raw r||s, so the DER is converted.
 */
export async function verify_ecdsa_p256_sha256(options: {
	public_key: string
	signature: string
	data: string
}): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		"spki",
		base64_decode(options.public_key) as BufferSource,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"]
	)
	return crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		der_to_p1363(base64_decode(options.signature)) as BufferSource,
		encoder.encode(options.data)
	)
}

/** Convert a DER ECDSA signature (SEQUENCE of two INTEGERs) to raw 64-byte r||s. */
function der_to_p1363(der: Uint8Array): Uint8Array {
	let offset = 1 // skip SEQUENCE tag
	// Skip the (possibly long-form) sequence length.
	offset += der[offset] & 0x80 ? (der[offset] & 0x7f) + 1 : 1

	const read_integer = (): Uint8Array => {
		offset++ // 0x02 INTEGER tag
		let length = der[offset++]
		if (length & 0x80) {
			const bytes = length & 0x7f
			length = 0
			for (let i = 0; i < bytes; i++) length = (length << 8) | der[offset++]
		}
		let value = der.slice(offset, offset + length)
		offset += length
		while (value.length > 32 && value[0] === 0) value = value.slice(1)
		const out = new Uint8Array(32)
		out.set(value, 32 - value.length)
		return out
	}

	const r = read_integer()
	const s = read_integer()
	const signature = new Uint8Array(64)
	signature.set(r, 0)
	signature.set(s, 32)
	return signature
}

/**
 * Verify an Ed25519 signature over the raw body (MailPace's scheme). Throws where the
 * runtime's WebCrypto lacks Ed25519 — callers surface that as `unsupported_runtime`.
 */
export async function verify_ed25519(options: {
	public_key: string
	signature: string
	data: string
}): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		"raw",
		base64_decode(options.public_key) as BufferSource,
		{ name: "Ed25519" },
		false,
		["verify"]
	)
	return crypto.subtle.verify(
		"Ed25519",
		key,
		base64_decode(options.signature) as BufferSource,
		encoder.encode(options.data)
	)
}

/** A random `whsec_` secret in the Svix format — used by the mock webhook builder. */
export function generate_svix_secret(): string {
	const bytes = new Uint8Array(24)
	crypto.getRandomValues(bytes)
	return `whsec_${base64_encode(bytes)}`
}

/** A random hex token — used by the mock builder for shared-secret providers. */
export function generate_token(): string {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	return hex_encode(bytes)
}
