import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import MockPush from "./mock.js"
import WebPush, { clear_vapid_cache } from "./webpush.js"
import { PushProvider } from "./provider.js"
import { push } from "./send.js"
import { configure, reset_config } from "../config.js"
import type { Channel, PostboiError } from "../errors.js"

const SUBSCRIPTION = {
	endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
	keys: {
		p256dh:
			"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		auth: "BTBZMqHH6r4Tts7J_aSIgg",
	},
}
const VAPID = {
	public_key:
		"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	private_key: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	subject: "mailto:you@example.com",
}

const respond = ({ ok = true, status = 201, body = "" } = {}) =>
	({
		ok,
		status,
		url: SUBSCRIPTION.endpoint,
		headers: new Headers(),
		text: async () => body,
	}) as unknown as Response

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.NODE_ENV
	delete process.env.POSTBOI_PUSH_PROVIDER
})
afterEach(() => {
	reset_config()
	delete process.env.VAPID_PUBLIC_KEY
	delete process.env.VAPID_PRIVATE_KEY
	delete process.env.VAPID_SUBJECT
})

describe("prepare", () => {
	it("rejects an empty message, tagged with the push channel", async () => {
		const notify = new MockPush()
		const error = (await notify.send({ message: " " }).catch((e) => e)) as PostboiError
		expect(error.code).toBe("empty_message")
		expect(error.channel).toBe<Channel>("push")
	})

	it("defaults ttl and urgency", async () => {
		const notify = new MockPush()
		await notify.send({ to: "tok", message: "hi" })
		expect(notify.last).toMatchObject({ to: "tok", message: "hi" })
	})
})

describe("webpush", () => {
	it("posts the encrypted body with the headers a push service expects", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({}))
		vi.stubGlobal("fetch", fetch)
		const notify = new WebPush(VAPID)

		await notify.send({
			to: SUBSCRIPTION,
			title: "Order shipped",
			message: "On its way",
			urgency: "high",
			ttl: 60,
		})

		const [url, init] = fetch.mock.calls[0]
		expect(url).toBe(SUBSCRIPTION.endpoint)
		expect(init.headers["Content-Encoding"]).toBe("aes128gcm")
		expect(init.headers["Content-Type"]).toBe("application/octet-stream")
		expect(init.headers.TTL).toBe("60")
		expect(init.headers.Urgency).toBe("high")
		expect(init.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/)
		// The body must be raw encrypted bytes, not JSON.
		expect(init.body).toBeInstanceOf(Uint8Array)
	})

	it("treats a 410 as an expired subscription, and says what to do about it", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ ok: false, status: 410 })))
		const notify = new WebPush(VAPID)

		const error = (await notify
			.send({ to: SUBSCRIPTION, message: "hi" })
			.catch((e) => e)) as PostboiError

		expect(error.code).toBe("expired_subscription")
		expect(error.status).toBe(410)
		// Expiry is routine, and the right response is to forget the subscription rather than
		// retry — so it's a first-class check, not a status code to match on by hand.
		expect(PushProvider.is_expired(error)).toBe(true)
	})

	it("refuses a bare token, pointing at the provider that wants one", async () => {
		vi.stubGlobal("fetch", vi.fn())
		const notify = new WebPush(VAPID)
		await expect(notify.send({ to: "a-device-token", message: "hi" })).rejects.toMatchObject({
			code: "invalid_target",
		})
	})

	it("signs one VAPID JWT per push-service origin, not per send", async () => {
		clear_vapid_cache()
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({})))
		// ECDSA signing only happens in vapid_header — payload encryption is ECDH + AES.
		const sign_spy = vi.spyOn(crypto.subtle, "sign")
		const notify = new WebPush(VAPID)

		await notify.send({ to: SUBSCRIPTION, message: "one" })
		await notify.send({ to: SUBSCRIPTION, message: "two" })
		expect(sign_spy).toHaveBeenCalledTimes(1)

		const elsewhere = {
			...SUBSCRIPTION,
			endpoint: "https://updates.push.services.mozilla.com/wpush/v2/xyz",
		}
		await notify.send({ to: elsewhere, message: "three" })
		expect(sign_spy).toHaveBeenCalledTimes(2)

		// The cache is shared across instances on purpose: zero-config push() constructs a
		// fresh provider per call, and a per-instance cache would never hit.
		const fresh = new WebPush(VAPID)
		await fresh.send({ to: SUBSCRIPTION, message: "four" })
		expect(sign_spy).toHaveBeenCalledTimes(2)
		sign_spy.mockRestore()
	})

	it("rejects an oversized payload before encrypting, naming the real limit", async () => {
		vi.stubGlobal("fetch", vi.fn())
		const notify = new WebPush(VAPID)
		await expect(
			notify.send({ to: SUBSCRIPTION, message: "a".repeat(4200) })
		).rejects.toMatchObject({ code: "payload_too_large" })
	})
})

describe("zero-config push()", () => {
	it("resolves webpush from the environment", async () => {
		process.env.VAPID_PUBLIC_KEY = VAPID.public_key
		process.env.VAPID_PRIVATE_KEY = VAPID.private_key
		process.env.VAPID_SUBJECT = VAPID.subject
		configure({ push: { provider: "webpush" } })
		const fetch = vi.fn().mockResolvedValue(respond({}))
		vi.stubGlobal("fetch", fetch)

		await push({ to: SUBSCRIPTION, message: "hi" })
		expect(fetch.mock.calls[0][0]).toBe(SUBSCRIPTION.endpoint)
	})

	it("throws outside development when nothing is configured", async () => {
		await expect(push({ to: "tok", message: "hi" })).rejects.toMatchObject({
			code: "no_push_provider",
		})
	})

	it("reports a missing credential by env var name", async () => {
		configure({ push: { provider: "webpush" } })
		await expect(push({ to: SUBSCRIPTION, message: "hi" })).rejects.toThrow(/VAPID_PUBLIC_KEY/)
	})
})

describe("expiry handling", () => {
	it("is_expired covers both codes a push service uses, and nothing else", async () => {
		const notify = new MockPush({ expired: true })
		const error = await notify.send({ to: "tok", message: "hi" }).catch((e) => e)
		expect(PushProvider.is_expired(error)).toBe(true)
		// The documented one-import form: the check hangs off push() itself.
		expect(push.expired(error)).toBe(true)
		expect(push.expired(new Error("other"))).toBe(false)

		const other = await new MockPush({ fail: true })
			.send({ to: "tok", message: "hi" })
			.catch((e) => e)
		expect(PushProvider.is_expired(other)).toBe(false)
	})

	it("one bad notification in a batch does not lose the rest", async () => {
		// The mock defaults a target so it works unconfigured, so drop that to get a
		// genuinely unaddressed send.
		class NoDefault extends MockPush {
			constructor() {
				super()
				this.defaults = {}
			}
		}
		const notify = new NoDefault()
		const results = await notify.send([
			{ to: "good-1", message: "hi" },
			{ message: "no target" },
			{ to: "good-2", message: "hi" },
		])
		expect(results.map((r) => r.ok)).toEqual([true, false, true])
		expect(notify.sent).toHaveLength(2)
	})
})
