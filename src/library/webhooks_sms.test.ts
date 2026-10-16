import { afterEach, describe, it, expect } from "vitest"

import {
	receive,
	mock_request,
	webhook,
	dedupe_key,
	WebhookVerificationError,
} from "$library/webhooks/index.js"
import { twilio_signature } from "$library/webhooks/twilio.js"
import { puresms_signature } from "$library/webhooks/puresms.js"
import { vonage_token } from "$library/webhooks/vonage.js"
import { plivo_signature } from "$library/webhooks/plivo.js"
import { sinch_signature } from "$library/webhooks/sinch.js"
import { hex_encode } from "$library/webhooks/crypto.js"

/** A form-encoded Twilio request to `url`, signed with `token` over `signed_url`. */
async function twilio_request(
	params: Array<[string, string]>,
	{ token = "tok", url = "https://example.com/hooks/twilio", signed_url = url } = {}
) {
	return new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-twilio-signature": await twilio_signature(token, signed_url, params),
		},
		body: new URLSearchParams(params).toString(),
	})
}

const INBOUND: Array<[string, string]> = [
	["MessageSid", "SM1"],
	["SmsStatus", "received"],
	["From", "+15557770006"],
	["To", "+15551110001"],
	["NumMedia", "0"],
]

describe("receive — twilio (signed status callbacks and inbound)", () => {
	const saved = { ...process.env }
	afterEach(() => {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
		Object.assign(process.env, saved)
	})

	it("signs the way Twilio's published example does", async () => {
		const signature = await twilio_signature("12345", "https://example.com/myapp.php?foo=1&bar=2", [
			["Digits", "1234"],
			["To", "+18005551212"],
			["From", "+14158675310"],
			["Caller", "+14158675310"],
			["CallSid", "CA1234567890ABCDE"],
		])
		expect(signature).toBe("L/OH5YylLD5NRKLltdqwSvS0BnU=")
	})

	it("maps a status callback, on either channel", async () => {
		const { request, secret } = await mock_request({ provider: "twilio", type: "delivered" })
		expect(await receive(request, { provider: "twilio", secret })).toMatchObject([
			{ type: "delivered", channel: "sms", phone: "+15557770006", message_id: expect.any(String) },
		])

		const failed = await mock_request({
			provider: "twilio",
			type: "failed",
			channel: "whatsapp",
			secret,
		})
		expect(await receive(failed.request, { provider: "twilio", secret })).toMatchObject([
			{
				type: "failed",
				channel: "whatsapp",
				phone: "+15557770006",
				bounce: { category: "unknown", detail: "30006" },
			},
		])
	})

	it("drops the in-flight statuses", async () => {
		for (const status of ["queued", "sending", "accepted", "scheduled"]) {
			const request = await twilio_request([
				["MessageSid", "SM2"],
				["MessageStatus", status],
				["To", "+15557770006"],
			])
			expect(await receive(request, { provider: "twilio", secret: "tok" }), status).toEqual([])
		}
	})

	it("reads inbound texts: keywords from the words, and every other reply as received", async () => {
		const post = async (body: string) => {
			const request = await twilio_request([...INBOUND, ["Body", body]])
			return (await receive(request, { provider: "twilio", secret: "tok" }))[0]
		}
		expect(await post("STOP")).toMatchObject({
			type: "unsubscribed",
			keyword: "stop",
			phone: "+15557770006",
			message_id: "SM1",
		})
		expect(await post("start")).toMatchObject({ type: "resubscribed", keyword: "start" })
		expect(await post("HELP")).toMatchObject({
			type: "received",
			keyword: "help",
			body: { text: "HELP" },
		})
		const reply = await post("See you at 3")
		expect(reply).toMatchObject({ type: "received", body: { text: "See you at 3" } })
		expect(reply.keyword).toBeUndefined()
	})

	it("believes Twilio's Advanced Opt-Out over the words, YES included", async () => {
		const request = await twilio_request([...INBOUND, ["Body", "Yes"], ["OptOutType", "START"]])
		expect(await receive(request, { provider: "twilio", secret: "tok" })).toMatchObject([
			{ type: "resubscribed", keyword: "start" },
		])
	})

	it("names the send a WhatsApp reply answered", async () => {
		const request = await twilio_request([
			["MessageSid", "SM3"],
			["SmsStatus", "received"],
			["From", "whatsapp:+15557770006"],
			["To", "whatsapp:+15551110001"],
			["Body", "Works for me"],
			["OriginalRepliedMessageSid", "SM0"],
		])
		expect(await receive(request, { provider: "twilio", secret: "tok" })).toMatchObject([
			{ type: "received", channel: "whatsapp", phone: "+15557770006", message_id: "SM0" },
		])
	})

	it("refuses a wrong token, a tampered body and a missing signature", async () => {
		const good = await twilio_request([...INBOUND, ["Body", "STOP"]])
		const wrong = await receive(good.clone(), { provider: "twilio", secret: "other" }).catch(
			(e) => e
		)
		expect(wrong).toBeInstanceOf(WebhookVerificationError)
		expect(wrong.code).toBe("invalid_signature")

		const tampered = new Request(good.url, {
			method: "POST",
			headers: good.headers,
			body: new URLSearchParams([...INBOUND, ["Body", "START"]]).toString(),
		})
		await expect(receive(tampered, { provider: "twilio", secret: "tok" })).rejects.toMatchObject({
			code: "invalid_signature",
		})

		const unsigned = new Request(good.url, { method: "POST", body: "MessageSid=SM1" })
		await expect(receive(unsigned, { provider: "twilio", secret: "tok" })).rejects.toMatchObject({
			code: "invalid_signature",
		})
	})

	it("checks the URL Twilio called when a proxy changed the request's own", async () => {
		const request = await twilio_request([...INBOUND, ["Body", "hi"]], {
			url: "http://internal:8080/hooks/twilio",
			signed_url: "https://example.com/hooks/twilio",
		})
		await expect(
			receive(request.clone(), { provider: "twilio", secret: "tok" })
		).rejects.toMatchObject({ code: "invalid_signature" })
		expect(
			await receive(request, {
				provider: "twilio",
				secret: "tok",
				url: "https://example.com/hooks/twilio",
			})
		).toHaveLength(1)
	})

	it("accepts a signature over the URL with its default port typed in", async () => {
		const request = await twilio_request([...INBOUND, ["Body", "hi"]], {
			signed_url: "https://example.com:443/hooks/twilio",
		})
		expect(await receive(request, { provider: "twilio", secret: "tok" })).toHaveLength(1)
	})

	it("verifies a JSON body by its bodySHA256", async () => {
		const body = JSON.stringify({
			MessageSid: "SM4",
			MessageStatus: "delivered",
			To: "+15557770006",
		})
		const hash = hex_encode(
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))
		)
		const url = `https://example.com/hooks/twilio?bodySHA256=${hash}`
		const make = async (payload: string) =>
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-twilio-signature": await twilio_signature("tok", url, []),
				},
				body: payload,
			})
		expect(await receive(await make(body), { provider: "twilio", secret: "tok" })).toMatchObject([
			{ type: "delivered", message_id: "SM4" },
		])
		await expect(
			receive(await make(body.replace("delivered", "failed")), {
				provider: "twilio",
				secret: "tok",
			})
		).rejects.toMatchObject({ code: "invalid_signature" })
	})

	it("answers through webhook() with empty TwiML, which Twilio reads a reply as", async () => {
		const seen: Array<string> = []
		const handle = webhook((event) => void seen.push(event.type), {
			provider: "twilio",
			secret: "tok",
		})
		const response = await handle(await twilio_request([...INBOUND, ["Body", "HELP"]]))
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/xml")
		expect(await response.text()).toContain("<Response></Response>")
		expect(seen).toEqual(["received"])

		// A bad signature is still a 401, not TwiML.
		const forged = await twilio_request([...INBOUND, ["Body", "HELP"]], { token: "other" })
		expect((await handle(forged)).status).toBe(401)
	})

	it("reads the auth token from TWILIO_AUTH_TOKEN when no webhook secret is set", async () => {
		delete process.env.TWILIO_WEBHOOK_SECRET
		process.env.TWILIO_AUTH_TOKEN = "from-env"
		const request = await twilio_request([...INBOUND, ["Body", "hi"]], { token: "from-env" })
		expect(await receive(request, { provider: "twilio" })).toHaveLength(1)
	})
})

describe("receive — puresms (signed delivery receipts and inbound)", () => {
	const secret = "puresms-secret"

	/** A PureSMS request for `body`, signed now unless told otherwise. */
	async function request(
		body: string,
		{ sign_with = secret, timestamp = String(Math.floor(Date.now() / 1000)) } = {}
	) {
		return new Request("https://example.com/hooks/puresms", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-webhook-timestamp": timestamp,
				"x-webhook-signature": await puresms_signature(sign_with, timestamp, body),
			},
			body,
		})
	}

	const receipt = (data: string) =>
		`{"id":"evt-1","timestamp":"2026-09-13T15:43:54.2773048Z","workspace_id":"1","event_type":1,"data":${data}}`

	it("maps the documented example, keeping all 64 bits of the id", async () => {
		const body = receipt(
			`{"MessageId":357551956102758401,"ClientReference":"order-confirmation-456","DeliveryStatus":7,"DeliveryStatusStr":"Delivered","ErrorCode":null,"ProcessedAt":"2026-09-13T15:43:49.607Z","DeliveredAt":"2026-09-13T15:43:54.2756245Z","SmsParts":1,"CostEur":0.031,"CostGbp":0.028}`
		)
		const [event] = await receive(await request(body), { provider: "puresms", secret })
		expect(event).toMatchObject({
			type: "delivered",
			provider: "puresms",
			channel: "sms",
			message_id: "357551956102758401",
			tags: ["order-confirmation-456"],
		})
		expect(event.timestamp?.toISOString()).toBe("2026-09-13T15:43:54.275Z")
		expect(event.phone).toBeUndefined()
	})

	it("maps the statuses worth an event and drops the rest", async () => {
		const type = async (status: number) => {
			const body = receipt(`{"MessageId":1,"DeliveryStatus":${status},"ErrorCode":"E1"}`)
			return (await receive(await request(body), { provider: "puresms", secret }))[0]?.type
		}
		expect(await type(2)).toBe("sent")
		for (const status of [3, 5, 8, 9]) expect(await type(status), String(status)).toBe("failed")
		for (const status of [1, 4, 6, 10]) expect(await type(status), String(status)).toBeUndefined()
	})

	it("reads an inbound text through the keyword rules", async () => {
		const { request: stop } = await mock_request({
			provider: "puresms",
			type: "unsubscribed",
			secret,
		})
		expect(await receive(stop, { provider: "puresms", secret })).toMatchObject([
			{ type: "unsubscribed", keyword: "stop", phone: "+447700900123" },
		])
		const { request: reply } = await mock_request({ provider: "puresms", type: "received", secret })
		expect(await receive(reply, { provider: "puresms", secret })).toMatchObject([
			{
				type: "received",
				phone: "+447700900123",
				message_id: "357552103948288001",
				body: { text: "Yes, please confirm my appointment" },
			},
		])
	})

	it("refuses a wrong secret, a tampered body, and a missing secret", async () => {
		const body = receipt(`{"MessageId":1,"DeliveryStatus":7}`)
		await expect(
			receive(await request(body, { sign_with: "other" }), { provider: "puresms", secret })
		).rejects.toMatchObject({ code: "invalid_signature" })

		const good = await request(body)
		const tampered = new Request(good.url, {
			method: "POST",
			headers: good.headers,
			body: body.replace('"DeliveryStatus":7', '"DeliveryStatus":8'),
		})
		await expect(receive(tampered, { provider: "puresms", secret })).rejects.toMatchObject({
			code: "invalid_signature",
		})

		delete process.env.PURESMS_WEBHOOK_SECRET
		await expect(receive(await request(body), { provider: "puresms" })).rejects.toMatchObject({
			code: "missing_secret",
		})
	})

	it("signs the timestamp, so a moved one fails even though its age is not checked", async () => {
		const body = receipt(`{"MessageId":1,"DeliveryStatus":7}`)
		const good = await request(body, { timestamp: "1700000000" })
		// An old timestamp still verifies: PureSMS retries for hours. See the adapter.
		expect(await receive(good.clone(), { provider: "puresms", secret })).toHaveLength(1)
		const moved = new Request(good.url, {
			method: "POST",
			headers: { ...Object.fromEntries(good.headers), "x-webhook-timestamp": "1800000000" },
			body,
		})
		await expect(receive(moved, { provider: "puresms", secret })).rejects.toMatchObject({
			code: "invalid_signature",
		})
	})
})

describe("receive — meta (WhatsApp keywords)", () => {
	it("reads START as a resubscribe, through the same rules as a text", async () => {
		const { request, secret } = await mock_request({ provider: "meta", type: "resubscribed" })
		expect(await receive(request, { provider: "meta", secret })).toMatchObject([
			{ type: "resubscribed", keyword: "start", channel: "whatsapp", phone: "+15557770006" },
		])
	})
})

describe("receive — telnyx (Ed25519-signed events)", () => {
	it("maps delivery events and inbound texts", async () => {
		const delivered = await mock_request({ provider: "telnyx", type: "delivered" })
		expect(
			await receive(delivered.request, { provider: "telnyx", secret: delivered.secret })
		).toMatchObject([
			{
				type: "delivered",
				channel: "sms",
				phone: "+15557770006",
				message_id: "40385f64-5717-4562-b3fc-2c963f66afa6",
			},
		])
		const failed = await mock_request({ provider: "telnyx", type: "failed" })
		expect(
			await receive(failed.request, { provider: "telnyx", secret: failed.secret })
		).toMatchObject([
			{ type: "failed", bounce: { category: "unknown", detail: "40008 Undeliverable" } },
		])
		const sent = await mock_request({ provider: "telnyx", type: "sent" })
		expect((await receive(sent.request, { provider: "telnyx", secret: sent.secret }))[0].type).toBe(
			"sent"
		)
		const stop = await mock_request({ provider: "telnyx", type: "unsubscribed" })
		expect(await receive(stop.request, { provider: "telnyx", secret: stop.secret })).toMatchObject([
			{ type: "unsubscribed", keyword: "stop", phone: "+15557770006" },
		])
	})

	it("refuses a tampered body, a stale timestamp and another key", async () => {
		const { request, secret } = await mock_request({ provider: "telnyx", type: "delivered" })
		const body = await request.clone().text()
		const tampered = new Request(request.url, {
			method: "POST",
			headers: request.headers,
			body: body.replace("delivered", "expired"),
		})
		await expect(receive(tampered, { provider: "telnyx", secret })).rejects.toMatchObject({
			code: "invalid_signature",
		})
		const stale = new Request(request.url, {
			method: "POST",
			headers: { ...Object.fromEntries(request.headers), "telnyx-timestamp": "1700000000" },
			body,
		})
		await expect(receive(stale, { provider: "telnyx", secret })).rejects.toMatchObject({
			code: "stale_timestamp",
		})
		const other = await mock_request({ provider: "telnyx", type: "delivered" })
		await expect(
			receive(request, { provider: "telnyx", secret: other.secret })
		).rejects.toMatchObject({
			code: "invalid_signature",
		})
	})

	it("drops a delivery Telnyx couldn't confirm either way", async () => {
		const { request, secret } = await mock_request({ provider: "telnyx", type: "delivered" })
		const adapter = (await import("$library/webhooks/telnyx.js")).default
		const body = (await request.text()).replace(
			'"status":"delivered"',
			'"status":"delivery_unconfirmed"'
		)
		expect(
			await adapter.normalize(body, { headers: new Headers(), url: new URL("https://x") })
		).toEqual([])
		expect(secret).toBeTruthy()
	})
})

describe("receive — vonage (HS256 JWT)", () => {
	const secret = "vonage-signature-secret"

	it("maps statuses and inbound texts, putting the + back", async () => {
		const failed = await mock_request({ provider: "vonage", type: "failed", secret })
		expect(await receive(failed.request, { provider: "vonage", secret })).toMatchObject([
			{
				type: "failed",
				phone: "+447700900123",
				tags: ["otp"],
				bounce: { category: "unknown", detail: "1170 Invalid recipient" },
			},
		])
		const sent = await mock_request({ provider: "vonage", type: "sent", secret })
		expect((await receive(sent.request, { provider: "vonage", secret }))[0].type).toBe("sent")
		const reply = await mock_request({ provider: "vonage", type: "received", secret })
		expect(await receive(reply.request, { provider: "vonage", secret })).toMatchObject([
			{ type: "received", phone: "+447700900123", body: { text: "Thanks, see you then" } },
		])
	})

	it("refuses another secret, a body its payload_hash doesn't match, and another algorithm", async () => {
		const { request } = await mock_request({ provider: "vonage", type: "delivered", secret })
		await expect(
			receive(request.clone(), { provider: "vonage", secret: "other" })
		).rejects.toMatchObject({ code: "invalid_signature" })

		const body = await request.clone().text()
		const tampered = new Request(request.url, {
			method: "POST",
			headers: request.headers,
			body: body.replace("delivered", "rejected"),
		})
		await expect(receive(tampered, { provider: "vonage", secret })).rejects.toMatchObject({
			code: "invalid_signature",
		})

		const token = request.headers.get("authorization")!.replace("Bearer ", "")
		const [, payload, signature] = token.split(".")
		const none = btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "")
		const forged = new Request(request.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${none}.${payload}.${signature}`,
			},
			body,
		})
		await expect(receive(forged, { provider: "vonage", secret })).rejects.toMatchObject({
			code: "invalid_signature",
		})
	})

	it("refuses a token that names no payload_hash", async () => {
		const body = JSON.stringify({ message_uuid: "u", status: "delivered", to: "447700900123" })
		const token = await vonage_token(secret, { iat: Math.floor(Date.now() / 1000) })
		const request = new Request("https://example.com/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body,
		})
		await expect(receive(request, { provider: "vonage", secret })).rejects.toMatchObject({
			code: "invalid_signature",
		})
	})

	it("signs the way it verifies", async () => {
		const token = await vonage_token(secret, { iat: 1 })
		expect(token.split(".")).toHaveLength(3)
	})
})

describe("receive — plivo (V2-signed status and inbound)", () => {
	it("maps a status and an inbound reply, and gives numbers back their +", async () => {
		const delivered = await mock_request({ provider: "plivo", type: "delivered", secret: "tok" })
		expect(await receive(delivered.request, { provider: "plivo", secret: "tok" })).toMatchObject([
			{ type: "delivered", channel: "sms", phone: "+15557770006", message_id: expect.any(String) },
		])
		const failed = await mock_request({ provider: "plivo", type: "failed", secret: "tok" })
		expect(await receive(failed.request, { provider: "plivo", secret: "tok" })).toMatchObject([
			{ type: "failed", bounce: { category: "unknown", detail: "200" } },
		])
		const stop = await mock_request({ provider: "plivo", type: "unsubscribed", secret: "tok" })
		expect(await receive(stop.request, { provider: "plivo", secret: "tok" })).toMatchObject([
			{ type: "unsubscribed", phone: "+15557770006", keyword: "stop" },
		])
	})

	it("signs the URL without its query string, plus the nonce", async () => {
		const signature = await plivo_signature("tok", "https://example.com/hooks/plivo?a=1", "n1")
		expect(signature).toBe(await plivo_signature("tok", "https://example.com/hooks/plivo", "n1"))
		expect(signature).not.toBe(await plivo_signature("tok", "https://example.com/other", "n1"))
	})

	it("reads the auth token from PLIVO_AUTH_TOKEN, and refuses another token or URL", async () => {
		const saved = process.env.PLIVO_AUTH_TOKEN
		process.env.PLIVO_AUTH_TOKEN = "tok"
		try {
			const { request } = await mock_request({ provider: "plivo", type: "sent", secret: "tok" })
			expect((await receive(request, { provider: "plivo" }))[0].type).toBe("sent")
		} finally {
			if (saved === undefined) delete process.env.PLIVO_AUTH_TOKEN
			else process.env.PLIVO_AUTH_TOKEN = saved
		}
		const other = await mock_request({ provider: "plivo", type: "sent", secret: "other" })
		await expect(
			receive(other.request, { provider: "plivo", secret: "tok" })
		).rejects.toBeInstanceOf(WebhookVerificationError)
		const moved = await mock_request({
			provider: "plivo",
			type: "sent",
			secret: "tok",
			url: "https://example.com/elsewhere",
		})
		await expect(
			receive(new Request("https://example.com/hooks/plivo", moved.request), {
				provider: "plivo",
				secret: "tok",
			})
		).rejects.toMatchObject({ code: "invalid_signature" })
	})
})

describe("receive — sinch (Basic credentials on the callback URL)", () => {
	it("maps a per-recipient report, a batch report and an inbound text", async () => {
		const delivered = await mock_request({ provider: "sinch", type: "delivered", secret: "u:p" })
		expect(await receive(delivered.request, { provider: "sinch", secret: "u:p" })).toMatchObject([
			{ type: "delivered", phone: "+15557770006", message_id: expect.any(String), tags: ["otp"] },
		])
		const stop = await mock_request({ provider: "sinch", type: "unsubscribed", secret: "u:p" })
		expect(await receive(stop.request, { provider: "sinch", secret: "u:p" })).toMatchObject([
			{ type: "unsubscribed", phone: "+15557770006" },
		])
		const batch = new Request("https://example.com/hooks/sinch", {
			method: "POST",
			headers: { authorization: `Basic ${btoa("u:p")}` },
			body: JSON.stringify({
				type: "delivery_report_sms",
				batch_id: "b1",
				statuses: [
					{ code: 0, status: "Delivered", recipients: ["447700900001"] },
					{ code: 402, status: "Failed", recipients: ["447700900002"] },
					{ code: 0, status: "Queued", recipients: ["447700900003"] },
				],
			}),
		})
		expect(await receive(batch, { provider: "sinch", secret: "u:p" })).toMatchObject([
			{ type: "delivered", message_id: "b1", phone: "+447700900001" },
			{
				type: "failed",
				message_id: "b1",
				phone: "+447700900002",
				bounce: { detail: "Failed 402" },
			},
		])
	})

	it("takes the password alone, and refuses other credentials or none", async () => {
		const { request } = await mock_request({ provider: "sinch", type: "sent", secret: "u:p" })
		expect((await receive(request, { provider: "sinch", secret: "p" }))[0].type).toBe("sent")
		const wrong = await mock_request({ provider: "sinch", type: "sent", secret: "u:x" })
		await expect(
			receive(wrong.request, { provider: "sinch", secret: "u:p" })
		).rejects.toMatchObject({
			code: "invalid_signature",
		})
		const bare = new Request("https://example.com/hooks/sinch", { method: "POST", body: "{}" })
		await expect(receive(bare, { provider: "sinch", secret: "u:p" })).rejects.toBeInstanceOf(
			WebhookVerificationError
		)
	})
})

describe("receive — sinch (HMAC-signed callbacks)", () => {
	/** A Sinch callback signed with `secret`, at `timestamp` (seconds), as Sinch sends one. */
	async function signed(
		body: string,
		{ secret = "shh", nonce = "n1", timestamp = String(Math.floor(Date.now() / 1000)) } = {},
		headers: Record<string, string> = {}
	) {
		return new Request("https://example.com/hooks/sinch", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-sinch-webhook-signature-algorithm": "HmacSHA256",
				"x-sinch-webhook-signature-nonce": nonce,
				"x-sinch-webhook-signature-timestamp": timestamp,
				"x-sinch-webhook-signature": await sinch_signature(secret, body, nonce, timestamp),
				...headers,
			},
			body,
		})
	}
	const report = JSON.stringify({
		type: "recipient_delivery_report_sms",
		batch_id: "b1",
		recipient: "447700900001",
		code: 0,
		status: "Delivered",
	})

	it("signs the body, the nonce and the timestamp, joined by dots", async () => {
		// Worked independently: base64(HMAC-SHA256("shh", '{"type":"x"}.n1.1700000000')).
		expect(await sinch_signature("shh", '{"type":"x"}', "n1", "1700000000")).toBe(
			"fqDt43bYQRu/aifM7LkfGlrDsyKRomAbFU+asfjXxHE="
		)
	})

	it("takes a signed callback, and the mock signs one with an hmac: secret", async () => {
		expect(await receive(await signed(report), { provider: "sinch", secret: "shh" })).toMatchObject(
			[{ type: "delivered", message_id: "b1", phone: "+447700900001" }]
		)
		const mocked = await mock_request({ provider: "sinch", type: "delivered", secret: "hmac:shh" })
		expect(mocked.request.headers.get("authorization")).toBeNull()
		expect(await receive(mocked.request, { provider: "sinch", secret: "shh" })).toMatchObject([
			{ type: "delivered" },
		])
	})

	it("refuses another secret, a changed body, a stale timestamp and a missing nonce", async () => {
		const refused = async (request: Request, code = "invalid_signature") =>
			expect(receive(request, { provider: "sinch", secret: "shh" })).rejects.toMatchObject({
				code,
			})
		await refused(await signed(report, { secret: "other" }))
		const tampered = await signed(report)
		await refused(
			new Request(tampered.url, {
				method: "POST",
				headers: tampered.headers,
				body: report.replace("Delivered", "Failed"),
			})
		)
		const old = String(Math.floor(Date.now() / 1000) - 3600)
		await refused(await signed(report, { timestamp: old }), "stale_timestamp")
		await refused(
			await signed(report, {}, { "x-sinch-webhook-signature-nonce": "" }),
			"invalid_signature"
		)
		await refused(
			await signed(report, {}, { "x-sinch-webhook-signature-algorithm": "HmacSHA1" }),
			"invalid_signature"
		)
		await expect(receive(await signed(report), { provider: "sinch" })).rejects.toMatchObject({
			code: "missing_secret",
		})
	})

	it("doesn't fall back to Basic credentials when a signature is there and wrong", async () => {
		const request = await signed(
			report,
			{ secret: "other" },
			{ authorization: `Basic ${btoa("u:shh")}` }
		)
		await expect(receive(request, { provider: "sinch", secret: "shh" })).rejects.toBeInstanceOf(
			WebhookVerificationError
		)
	})
})

describe("receive — bandwidth (Basic credentials on the application)", () => {
	it("maps delivered, failed and an inbound text, with the send's tag", async () => {
		const delivered = await mock_request({
			provider: "bandwidth",
			type: "delivered",
			secret: "u:p",
		})
		expect(
			await receive(delivered.request, { provider: "bandwidth", secret: "u:p" })
		).toMatchObject([
			{ type: "delivered", phone: "+15557770006", message_id: expect.any(String), tags: ["otp"] },
		])
		const failed = await mock_request({ provider: "bandwidth", type: "failed", secret: "u:p" })
		expect(await receive(failed.request, { provider: "bandwidth", secret: "u:p" })).toMatchObject([
			{ type: "failed", bounce: { detail: "9902 rejected-unallocated-from-number" } },
		])
		const reply = await mock_request({ provider: "bandwidth", type: "received", secret: "u:p" })
		expect(await receive(reply.request, { provider: "bandwidth", secret: "u:p" })).toMatchObject([
			{ type: "received", phone: "+15557770006", body: { text: "Thanks, see you then" } },
		])
	})

	it("drops message-sending, and refuses other credentials", async () => {
		const sending = new Request("https://example.com/hooks/bandwidth", {
			method: "POST",
			headers: { authorization: `Basic ${btoa("u:p")}` },
			body: JSON.stringify([{ type: "message-sending", message: { id: "m1" } }]),
		})
		expect(await receive(sending, { provider: "bandwidth", secret: "u:p" })).toEqual([])
		const wrong = await mock_request({ provider: "bandwidth", type: "delivered", secret: "u:x" })
		await expect(
			receive(wrong.request, { provider: "bandwidth", secret: "u:p" })
		).rejects.toBeInstanceOf(WebhookVerificationError)
	})
})

describe("dedupe_key and filtered texts", () => {
	const post = (body: string, type = "application/json") =>
		new Request("https://example.com/hooks", {
			method: "POST",
			headers: { "content-type": type },
			body,
		})

	it("gives a redelivery the same key, and a different event a different one", async () => {
		const a = await mock_request({ provider: "plivo", type: "delivered", secret: "tok" })
		const b = await mock_request({ provider: "plivo", type: "delivered", secret: "tok" })
		const c = await mock_request({ provider: "plivo", type: "sent", secret: "tok" })
		const [first] = await receive(a.request, { provider: "plivo", secret: "tok" })
		const [again] = await receive(b.request, { provider: "plivo", secret: "tok" })
		const [other] = await receive(c.request, { provider: "plivo", secret: "tok" })
		expect(first.dedupe_key).toBe(
			"plivo:db3ce55a-7f1d-11e1-8ea7-1231380bc196:delivered:+15557770006"
		)
		expect(again.dedupe_key).toBe(first.dedupe_key)
		expect(other.dedupe_key).not.toBe(first.dedupe_key)
	})

	it("tells one delay of a message from the next", () => {
		const delay = (at: string) =>
			dedupe_key({
				type: "delayed",
				provider: "smsworks",
				channel: "sms",
				phone: "+447700900123",
				message_id: "m1",
				timestamp: new Date(at),
				raw: {},
			})
		expect(delay("2026-10-01T10:00:00Z")).not.toBe(delay("2026-10-01T11:00:00Z"))
		expect(delay("2026-10-01T10:00:00Z")).toBe(delay("2026-10-01T10:00:00Z"))
	})

	it("tells one recipient of a batch from another", async () => {
		const batch = post(
			JSON.stringify({
				type: "delivery_report_sms",
				batch_id: "b1",
				statuses: [{ code: 0, status: "Delivered", recipients: ["447700900001", "447700900002"] }],
			})
		)
		const events = await receive(batch, { provider: "sinch", verify: false })
		expect(new Set(events.map((e) => e.dedupe_key)).size).toBe(2)
	})

	it("calls a spam block filtered, on Twilio, Telnyx, Vonage, Sinch, Plivo and Bandwidth", async () => {
		const twilio = post(
			new URLSearchParams({
				MessageSid: "SM1",
				MessageStatus: "undelivered",
				ErrorCode: "30007",
				To: "+15557770006",
			}).toString(),
			"application/x-www-form-urlencoded"
		)
		expect((await receive(twilio, { provider: "twilio", verify: false }))[0].bounce).toEqual({
			category: "filtered",
			detail: "30007",
		})
		const telnyx = post(
			JSON.stringify({
				data: {
					event_type: "message.finalized",
					payload: {
						id: "m1",
						to: [{ phone_number: "+15557770006", status: "delivery_failed" }],
						errors: [{ code: "40002", title: "Blocked as spam (temporary)" }],
					},
				},
			})
		)
		expect((await receive(telnyx, { provider: "telnyx", verify: false }))[0].bounce).toMatchObject({
			category: "filtered",
		})
		const vonage = post(
			JSON.stringify({
				message_uuid: "u1",
				to: "447700900123",
				status: "rejected",
				error: { type: "https://developer.vonage.com/api-errors/messages#1210", title: 1210 },
			})
		)
		expect((await receive(vonage, { provider: "vonage", verify: false }))[0].bounce).toMatchObject({
			category: "filtered",
		})
		const sinch = (code: number) =>
			post(
				JSON.stringify({
					type: "recipient_delivery_report_sms",
					batch_id: "b1",
					recipient: "447700900123",
					code,
					status: "Rejected",
				})
			)
		for (const code of [15, 62]) {
			expect((await receive(sinch(code), { provider: "sinch", verify: false }))[0].bounce).toEqual({
				category: "filtered",
				detail: `Rejected ${code}`,
			})
		}
		expect(
			(await receive(sinch(255), { provider: "sinch", verify: false }))[0].bounce?.category
		).toBe("unknown")
		const plivo = (code: string) =>
			post(
				new URLSearchParams({
					MessageUUID: "u1",
					Status: "failed",
					ErrorCode: code,
					To: "15557770006",
				}).toString(),
				"application/x-www-form-urlencoded"
			)
		expect((await receive(plivo("30"), { provider: "plivo", verify: false }))[0].bounce).toEqual({
			category: "filtered",
			detail: "30",
		})
		expect(
			(await receive(plivo("960"), { provider: "plivo", verify: false }))[0].bounce?.category
		).toBe("unknown")
		const bandwidth = (code: number, description: string) =>
			post(
				JSON.stringify([
					{
						type: "message-failed",
						to: "+15557770006",
						errorCode: code,
						description,
						message: { id: "m1" },
					},
				])
			)
		for (const [code, description] of [
			[4470, "rejected-spam-detected"],
			[4770, "destination-spam-detected"],
		] as const) {
			expect(
				(await receive(bandwidth(code, description), { provider: "bandwidth", verify: false }))[0]
					.bounce
			).toEqual({ category: "filtered", detail: `${code} ${description}` })
		}
		// Any other failure is still unknown.
		const other = await mock_request({ provider: "vonage", type: "failed", secret: "s" })
		expect(
			(await receive(other.request, { provider: "vonage", secret: "s" }))[0].bounce
		).toMatchObject({
			category: "unknown",
		})
	})
})
