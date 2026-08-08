/**
 * Base64 and base64url codecs shared by webhook verification, Web Push crypto and FCM.
 *
 * One implementation on purpose: a padding or alphabet fix applied to a single copy of
 * three would make signature verification and VAPID signing quietly disagree.
 *
 * Internal: not part of the public surface.
 */

/**
 * Byte arrays backed by a plain `ArrayBuffer`.
 *
 * WebCrypto's `BufferSource` excludes `SharedArrayBuffer`, and a bare `Uint8Array` is
 * `Uint8Array<ArrayBufferLike>` — which includes it. Pinning the buffer type here is what
 * lets decoded values be passed to `subtle.*` without a cast at every call.
 */
export type Bytes = Uint8Array<ArrayBuffer>

/** Decode standard base64 into bytes. */
export function base64_decode(value: string): Bytes {
	const binary = atob(value)
	return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** Encode bytes as standard base64. */
export function base64_encode(bytes: Uint8Array): string {
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/** Decode base64url (no padding) into bytes. */
export function from_base64url(value: string): Bytes {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
	return base64_decode(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="))
}

/** Encode bytes as base64url with no padding. */
export function to_base64url(bytes: Uint8Array): string {
	return base64_encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
