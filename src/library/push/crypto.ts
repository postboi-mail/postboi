/**
 * Web Push cryptography: VAPID signing (RFC 8292) and `aes128gcm` payload encryption
 * (RFC 8291 over RFC 8188).
 *
 * WebCrypto only, so it runs unchanged on Node, Bun, Deno and Workers — which matters
 * because the alternative is a dependency that pulls in `node:crypto` and breaks the edge.
 *
 * Internal: not part of the public surface.
 */
import { PostboiError } from "../errors.js"
import type { WebPushSubscription } from "./types.js"
import { from_base64url, to_base64url, type Bytes } from "../encoding.js"

export { from_base64url, to_base64url }

const encoder = new TextEncoder()

function concat(...parts: Array<Uint8Array>): Bytes {
	const total = parts.reduce((n, p) => n + p.length, 0)
	const out = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}
	return out
}

/**
 * HKDF as RFC 8291 uses it: extract with `salt`, expand with `info` to `length` bytes.
 * WebCrypto does both in one `deriveBits`, which is exactly the shape the spec asks for.
 */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info },
		key,
		length * 8
	)
	return new Uint8Array(bits) as Bytes
}

/** Split an uncompressed P-256 point (0x04 || x || y) into its JWK coordinates. */
function point_to_jwk(point: Bytes): { x: string; y: string } {
	if (point.length !== 65 || point[0] !== 0x04) {
		throw new PostboiError({
			provider: "webpush",
			channel: "push",
			code: "invalid_key",
			message: `Expected an uncompressed P-256 public key (65 bytes starting 0x04), got ${point.length} bytes.`,
		})
	}
	return { x: to_base64url(point.slice(1, 33)), y: to_base64url(point.slice(33, 65)) }
}

/**
 * Sign a VAPID JWT for `endpoint`, and return the `Authorization` header value.
 *
 * The audience is the push service's **origin**, not the full endpoint — getting that wrong
 * is rejected with a 401 that says nothing useful.
 */
export async function vapid_header(
	endpoint: string,
	public_key: string,
	private_key: string,
	subject: string,
	now: number
): Promise<string> {
	const audience = new URL(endpoint).origin
	const header = to_base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))
	const payload = to_base64url(
		encoder.encode(
			JSON.stringify({
				aud: audience,
				// 12 hours. RFC 8292 caps it at 24; push services reject anything longer.
				exp: Math.floor(now / 1000) + 12 * 60 * 60,
				sub: subject,
			})
		)
	)
	const signing_input = `${header}.${payload}`

	const public_bytes = from_base64url(public_key)
	const { x, y } = point_to_jwk(public_bytes)
	const key = await crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", x, y, d: private_key.replace(/=+$/, ""), ext: true },
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"]
	)
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		encoder.encode(signing_input)
	)

	const jwt = `${signing_input}.${to_base64url(new Uint8Array(signature))}`
	return `vapid t=${jwt}, k=${public_key}`
}

/**
 * Encrypt `payload` for `subscription` using `aes128gcm` (RFC 8291).
 *
 * The result is the complete request body: the RFC 8188 header block (salt, record size,
 * our ephemeral public key) followed by one AES-GCM record.
 */
export async function encrypt_payload(
	subscription: WebPushSubscription,
	payload: string,
	salt: Bytes = crypto.getRandomValues(new Uint8Array(16)),
	// Both `salt` and `keys` exist to be pinned by the RFC 8291 §5 test vector. Encryption
	// that type-checks but derives the wrong key fails silently against every real push
	// service, so being able to reproduce the published example is the only way to know
	// this is right. Neither is ever passed in production.
	keys?: CryptoKeyPair
): Promise<Bytes> {
	const client_public = from_base64url(subscription.keys.p256dh)
	const auth_secret = from_base64url(subscription.keys.auth)

	// A fresh ephemeral key pair per message — reusing one would let a push service link
	// messages, and the spec requires it.
	const ephemeral =
		keys ??
		((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
			"deriveBits",
		])) as CryptoKeyPair)
	const server_public = new Uint8Array(
		await crypto.subtle.exportKey("raw", ephemeral.publicKey)
	) as Bytes

	const { x, y } = point_to_jwk(client_public)
	const client_key = await crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", x, y, ext: true },
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[]
	)
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: client_key }, ephemeral.privateKey, 256)
	) as Bytes

	// RFC 8291 §3.3: the auth secret is the salt for the first extraction, and the info
	// binds both public keys so the derived key can't be replayed against another client.
	const key_info = concat(
		encoder.encode("WebPush: info"),
		new Uint8Array([0]),
		client_public,
		server_public
	)
	const ikm = await hkdf(auth_secret, shared, key_info, 32)

	const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16)
	const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12)

	// One record, so the padding delimiter is 0x02 ("last record"). 0x01 would tell the
	// client to expect more and it would wait for a record that never comes.
	const plaintext = concat(encoder.encode(payload), new Uint8Array([2]))

	const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"])
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, plaintext)
	) as Bytes

	// RFC 8188 header: salt(16) || record_size(4, big-endian) || key_id_len(1) || key_id
	const record_size: Bytes = new Uint8Array(4)
	new DataView(record_size.buffer).setUint32(0, 4096, false)
	return concat(
		salt,
		record_size,
		new Uint8Array([server_public.length]),
		server_public,
		ciphertext
	)
}

/** Largest plaintext that fits one 4096-byte record, per RFC 8291 §4. */
export const MAX_PAYLOAD_BYTES = 3993
