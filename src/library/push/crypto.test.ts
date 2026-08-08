import { describe, it, expect } from "vitest"
import { encrypt_payload, vapid_header, from_base64url, to_base64url } from "./crypto.js"

/**
 * The worked example from RFC 8291 §5.
 *
 * This is the test that matters. Web Push encryption fails *silently* when the key
 * derivation is wrong — the push service accepts the request and the client's service
 * worker simply never fires — so reproducing the published bytes is the only real proof
 * the implementation is correct.
 */
const RFC8291 = {
	plaintext: "When I grow up, I want to be a watermelon",
	ua_public:
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	auth_secret: "BTBZMqHH6r4Tts7J_aSIgg",
	as_public:
		"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	as_private: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	// The first three lines of the expected body. Enough to cover the header block and most
	// of the ciphertext — if these bytes match, every derived key matched.
	expected_prefix:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
}

/** Rebuild a P-256 key pair from the raw public point and private scalar. */
async function key_pair(public_key: string, private_key: string): Promise<CryptoKeyPair> {
	const point = from_base64url(public_key)
	const jwk = {
		kty: "EC",
		crv: "P-256",
		x: to_base64url(point.slice(1, 33)),
		y: to_base64url(point.slice(33, 65)),
		ext: true,
	}
	return {
		publicKey: await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "ECDH", namedCurve: "P-256" },
			true,
			[]
		),
		privateKey: await crypto.subtle.importKey(
			"jwk",
			{ ...jwk, d: private_key },
			{ name: "ECDH", namedCurve: "P-256" },
			true,
			["deriveBits"]
		),
	}
}

describe("aes128gcm encryption", () => {
	it("reproduces the RFC 8291 §5 worked example byte for byte", async () => {
		const keys = await key_pair(RFC8291.as_public, RFC8291.as_private)
		const body = await encrypt_payload(
			{
				endpoint: "https://push.example.net/x",
				keys: { p256dh: RFC8291.ua_public, auth: RFC8291.auth_secret },
			},
			RFC8291.plaintext,
			from_base64url(RFC8291.salt),
			keys
		)

		expect(to_base64url(body).startsWith(RFC8291.expected_prefix)).toBe(true)
	})

	it("frames the record the way RFC 8188 requires", async () => {
		const keys = await key_pair(RFC8291.as_public, RFC8291.as_private)
		const body = await encrypt_payload(
			{
				endpoint: "https://push.example.net/x",
				keys: { p256dh: RFC8291.ua_public, auth: RFC8291.auth_secret },
			},
			"hi",
			from_base64url(RFC8291.salt),
			keys
		)

		// salt(16) || record_size(4) || key_id_len(1) || key_id(65) || ciphertext
		expect(body.slice(0, 16)).toEqual(from_base64url(RFC8291.salt))
		expect(new DataView(body.buffer).getUint32(16, false)).toBe(4096)
		expect(body[20]).toBe(65)
		expect(body[21]).toBe(0x04) // uncompressed point marker
		expect(body.slice(21, 86)).toEqual(from_base64url(RFC8291.as_public))
	})

	it("uses a different ephemeral key each time, so messages can't be linked", async () => {
		const subscription = {
			endpoint: "https://push.example.net/x",
			keys: { p256dh: RFC8291.ua_public, auth: RFC8291.auth_secret },
		}
		const a = await encrypt_payload(subscription, "hi")
		const b = await encrypt_payload(subscription, "hi")
		expect(a.slice(21, 86)).not.toEqual(b.slice(21, 86))
	})
})

describe("vapid", () => {
	const PUBLIC = RFC8291.as_public
	const PRIVATE = RFC8291.as_private

	it("signs a JWT the push service can verify with the advertised key", async () => {
		const header = await vapid_header(
			"https://fcm.googleapis.com/fcm/send/abc123",
			PUBLIC,
			PRIVATE,
			"mailto:you@example.com",
			Date.UTC(2026, 0, 1)
		)

		const [, jwt] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!
		const [head, payload, signature] = jwt.split(".")

		expect(JSON.parse(new TextDecoder().decode(from_base64url(head)))).toEqual({
			typ: "JWT",
			alg: "ES256",
		})
		const claims = JSON.parse(new TextDecoder().decode(from_base64url(payload)))
		// The audience is the push service's *origin*, not the endpoint — the single easiest
		// thing to get wrong, and it fails with an unexplained 401.
		expect(claims.aud).toBe("https://fcm.googleapis.com")
		expect(claims.sub).toBe("mailto:you@example.com")
		expect(claims.exp).toBe(Math.floor(Date.UTC(2026, 0, 1) / 1000) + 12 * 60 * 60)

		// Verify for real: a signature nothing can check is no better than no signature.
		const point = from_base64url(PUBLIC)
		const key = await crypto.subtle.importKey(
			"jwk",
			{
				kty: "EC",
				crv: "P-256",
				x: to_base64url(point.slice(1, 33)),
				y: to_base64url(point.slice(33, 65)),
				ext: true,
			},
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"]
		)
		const valid = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			from_base64url(signature),
			new TextEncoder().encode(`${head}.${payload}`)
		)
		expect(valid).toBe(true)
	})

	it("advertises the same public key it signed with", async () => {
		const header = await vapid_header(
			"https://push.example.net/x",
			PUBLIC,
			PRIVATE,
			"mailto:a@b.c",
			Date.now()
		)
		expect(header.endsWith(`k=${PUBLIC}`)).toBe(true)
	})
})

describe("base64url", () => {
	it("round-trips without padding", () => {
		const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
		const encoded = to_base64url(bytes)
		expect(encoded).not.toContain("=")
		expect(encoded).not.toContain("+")
		expect(encoded).not.toContain("/")
		expect(from_base64url(encoded)).toEqual(bytes)
	})
})
