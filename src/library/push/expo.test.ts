import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Expo from "./expo.js"
import { PushProvider } from "./provider.js"
import { push } from "./send.js"
import { configure, reset_config } from "../config.js"
import type { PostboiError } from "../errors.js"

const TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"

const respond = (body: unknown, { ok = true, status = 200 } = {}) =>
	({
		ok,
		status,
		url: "",
		headers: new Headers(),
		text: async () => JSON.stringify(body),
	}) as unknown as Response

// One message in, one ticket object out — Expo only answers with an array to an array.
const ok_ticket = { data: { status: "ok", id: "ticket-1" } }

function stub(body: unknown, init?: { ok?: boolean; status?: number }) {
	const fetch = vi.fn().mockResolvedValue(respond(body, init))
	vi.stubGlobal("fetch", fetch)
	return fetch
}

/** The JSON body of the most recent request. */
const sent = (fetch: ReturnType<typeof vi.fn>) =>
	JSON.parse((fetch.mock.calls.at(-1)![1] as RequestInit).body as string)

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.NODE_ENV
	delete process.env.POSTBOI_PUSH_PROVIDER
	delete process.env.EXPO_ACCESS_TOKEN
})
afterEach(() => {
	reset_config()
	delete process.env.EXPO_ACCESS_TOKEN
})

describe("expo", () => {
	it("posts the message Expo's push service expects, with no credential by default", async () => {
		const fetch = stub(ok_ticket)
		const notify = new Expo()

		const result = await notify.send({
			to: TOKEN,
			title: "Order shipped",
			message: "On its way",
			url: "/orders/1",
			data: { order: 1 },
			urgency: "high",
			ttl: 60,
		})

		const [url, init] = fetch.mock.calls[0]
		expect(url).toBe("https://exp.host/--/api/v2/push/send")
		expect(init.headers.Authorization).toBeUndefined()
		expect(init.headers["Content-Type"]).toBe("application/json")
		expect(sent(fetch)).toEqual({
			to: TOKEN,
			title: "Order shipped",
			body: "On its way",
			data: { order: 1, url: "/orders/1" },
			ttl: 60,
			priority: "high",
			sound: "default",
		})
		expect(result).toEqual({ id: "ticket-1" })
	})

	it("carries the access token as a bearer once given, and treats an empty one as none", async () => {
		const fetch = stub(ok_ticket)
		await new Expo({ access_token: "expo-secret" }).send({ to: TOKEN, message: "hi" })
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer expo-secret")

		// The registry hands the optional field through as "" — that's not a token.
		await new Expo({ access_token: "" }).send({ to: TOKEN, message: "hi" })
		expect(fetch.mock.calls[1][1].headers.Authorization).toBeUndefined()
	})

	it("leaves priority to each platform's default unless the send said high", async () => {
		const fetch = stub(ok_ticket)
		await new Expo().send({ to: TOKEN, message: "hi" })
		expect(sent(fetch).priority).toBeUndefined()
		await new Expo().send({ to: TOKEN, message: "hi", urgency: "low" })
		expect(sent(fetch).priority).toBeUndefined()
	})

	it("reads the ticket in a batch-shaped answer too, and a 200 without one as not Expo's", async () => {
		stub({ data: [{ status: "ok", id: "ticket-2" }] })
		expect(await new Expo().send({ to: TOKEN, message: "hi" })).toEqual({ id: "ticket-2" })
		stub({ hello: "world" })
		await expect(new Expo().send({ to: TOKEN, message: "hi" })).rejects.toThrow(/no ticket/)
	})

	it("reads a 200 with an error ticket as the failure it is", async () => {
		stub({
			data: [{ status: "error", message: "Message too big", details: { error: "MessageTooBig" } }],
		})
		const error = (await new Expo()
			.send({ to: TOKEN, message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error.code).toBe("MessageTooBig")
		expect(error.message).toContain("Message too big")
		expect(PushProvider.is_expired(error)).toBe(false)
	})

	it("normalizes DeviceNotRegistered to the expiry every caller already handles", async () => {
		stub({
			data: {
				status: "error",
				message: `"${TOKEN}" is not a registered push notification recipient`,
				details: { error: "DeviceNotRegistered" },
			},
		})
		const error = await new Expo().send({ to: TOKEN, message: "hi" }).catch((e) => e)
		expect(PushProvider.is_expired(error)).toBe(true)
		expect(push.expired(error)).toBe(true)
		expect(String(error)).toContain("Delete your stored copy")
	})

	it("surfaces a request-level refusal by its code", async () => {
		stub(
			{ errors: [{ code: "PUSH_TOO_MANY_NOTIFICATIONS", message: "More than 100 messages." }] },
			{ ok: false, status: 400 }
		)
		const error = (await new Expo()
			.send({ to: TOKEN, message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error.code).toBe("PUSH_TOO_MANY_NOTIFICATIONS")
		expect(error.status).toBe(400)
	})

	it("refuses a token that isn't Expo's, naming where it belongs", async () => {
		stub(ok_ticket)
		await expect(new Expo().send({ to: "a".repeat(64), message: "hi" })).rejects.toMatchObject({
			code: "invalid_target",
		})
		await expect(new Expo().send({ to: "a".repeat(64), message: "hi" })).rejects.toThrow(
			/postboi\/fcm or postboi\/apns/
		)
		await expect(
			new Expo().send({
				to: { endpoint: "https://push.example/x", keys: { p256dh: "a", auth: "b" } },
				message: "hi",
			})
		).rejects.toThrow(/postboi\/webpush/)
		// Both spellings Expo has used are tokens.
		await new Expo().send({ to: "ExpoPushToken[abc]", message: "hi" })
	})

	it("says how big the payload is rather than letting Expo answer with a bare error", async () => {
		stub(ok_ticket)
		const error = (await new Expo()
			.send({ to: TOKEN, message: "x".repeat(5000) })
			.catch((e) => e)) as PostboiError
		expect(error.code).toBe("payload_too_large")
		expect(error.message).toMatch(/\d+ bytes; Expo accepts 4096/)
	})

	it("fetches receipts and hands each back as a send would have ended", async () => {
		const fetch = stub({
			data: {
				"ticket-1": { status: "ok" },
				"ticket-2": {
					status: "error",
					message: "The recipient device is not registered",
					details: { error: "DeviceNotRegistered" },
				},
			},
		})
		const receipts = await new Expo({ access_token: "t" }).receipts([
			"ticket-1",
			"ticket-2",
			"ticket-3",
		])

		expect(fetch.mock.calls[0][0]).toBe("https://exp.host/--/api/v2/push/getReceipts")
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer t")
		expect(sent(fetch)).toEqual({ ids: ["ticket-1", "ticket-2", "ticket-3"] })
		expect(receipts["ticket-1"]).toEqual({ ok: true })
		const gone = receipts["ticket-2"]
		expect(gone.ok).toBe(false)
		if (!gone.ok) expect(push.expired(gone.error)).toBe(true)
		// Expo hasn't heard back about the third: absent, not invented.
		expect(receipts["ticket-3"]).toBeUndefined()
	})

	it("asks for receipts a thousand at a time", async () => {
		const fetch = stub({ data: {} })
		await new Expo().receipts(Array.from({ length: 1001 }, (_, i) => `t-${i}`))
		expect(fetch).toHaveBeenCalledTimes(2)
		expect(JSON.parse(fetch.mock.calls[1][1].body).ids).toEqual(["t-1000"])
	})

	it("throws when the receipts request itself is refused", async () => {
		stub(
			{ errors: [{ code: "PUSH_TOO_MANY_RECEIPTS", message: "too many" }] },
			{ ok: false, status: 400 }
		)
		await expect(new Expo().receipts(["t"])).rejects.toMatchObject({
			code: "PUSH_TOO_MANY_RECEIPTS",
			channel: "push",
		})
	})
})

describe("zero-config push() with Expo", () => {
	it("resolves expo when named, with no credential in the environment", async () => {
		process.env.POSTBOI_PUSH_PROVIDER = "expo"
		const fetch = stub(ok_ticket)
		await push({ to: TOKEN, message: "hi" })
		expect(fetch.mock.calls[0][0]).toBe("https://exp.host/--/api/v2/push/send")
		expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined()
	})

	it("is never inferred — not from the access token, and not from needing nothing", async () => {
		// Every Expo field is optional, so unmarked it would count as configured on every
		// machine and the VAPID trio could never infer Web Push again; and the token's name
		// is the one expo-server-sdk's README reads, so it's set by people sending Expo push
		// their own way. Naming the provider is the answer, and `init` writes it anyway.
		await expect(push({ to: TOKEN, message: "hi" })).rejects.toMatchObject({
			code: "no_push_provider",
		})
		process.env.EXPO_ACCESS_TOKEN = "expo-secret"
		await expect(push({ to: TOKEN, message: "hi" })).rejects.toMatchObject({
			code: "no_push_provider",
		})
	})

	it("passes the access token through once the provider is named", async () => {
		process.env.POSTBOI_PUSH_PROVIDER = "expo"
		process.env.EXPO_ACCESS_TOKEN = "expo-secret"
		const fetch = stub(ok_ticket)
		await push({ to: TOKEN, message: "hi" })
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer expo-secret")
	})

	it("honours the config file naming it", async () => {
		configure({ push: { provider: "expo" } })
		const fetch = stub(ok_ticket)
		await push({ to: TOKEN, message: "hi" })
		expect(fetch.mock.calls[0][0]).toBe("https://exp.host/--/api/v2/push/send")
	})
})
