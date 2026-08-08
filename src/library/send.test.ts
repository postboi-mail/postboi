import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { send } from "./send.js"
import { configure, reset_config } from "./config.js"
import type { PostboiError } from "./errors.js"

const HOOK = "https://hooks.example.test/T000/B000/xxx"

/** One fetch stub for every channel, keyed by which host the request went to. */
function stub_channels({ fail = [] as Array<string> } = {}) {
	const fetch = vi.fn(async (url: string) => {
		const failing = fail.some((f) => url.includes(f))
		const ok = !failing
		const status = failing ? 500 : 200
		const body = url.includes("thesmsworks")
			? JSON.stringify({ messageid: "m1", status: "sent" })
			: url.includes("hooks.example.test")
				? "ok"
				: JSON.stringify({ id: "e1" })
		return { ok, status, headers: new Headers(), text: async () => body } as unknown as Response
	})
	vi.stubGlobal("fetch", fetch)
	return fetch
}

/** All three channels configured against stubs, so `send()` has somewhere to go. */
function configure_all() {
	process.env.RESEND_API_KEY = "k"
	process.env.SMSWORKS_API_KEY = "k"
	process.env.SLACK_WEBHOOK_URL = HOOK
	configure({
		provider: "resend",
		default: { from: "f@test.com" },
		sms: { provider: "smsworks", default: { from: "POSTBOI", country: "GB" } },
		chat: { provider: "slack" },
	})
}

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.NODE_ENV
})
afterEach(() => {
	reset_config()
	delete process.env.RESEND_API_KEY
	delete process.env.SMSWORKS_API_KEY
	delete process.env.SLACK_WEBHOOK_URL
})

describe("fan-out", () => {
	it("reaches every addressed channel and reports each one", async () => {
		configure_all()
		const fetch = stub_channels()

		const result = await send({
			to: { email: "ada@test.com", sms: "+447788223344", chat: HOOK },
			subject: "Your order shipped",
			message: "Your order shipped",
		})

		expect(result.ok).toBe(true)
		expect(result.results).toHaveLength(3)
		expect(result.results.every((r) => r.ok)).toBe(true)
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	// The property that matters: a failing channel must not take the others with it.
	it("does not lose the email when sms fails", async () => {
		configure_all()
		stub_channels({ fail: ["thesmsworks"] })

		const result = await send({
			to: { email: "ada@test.com", sms: "+447788223344" },
			subject: "hi",
			message: "hi",
		})

		expect(result.ok).toBe(true)
		const email = result.results.find((r) => r.channel === "email")
		const sms = result.results.find((r) => r.channel === "sms")
		expect(email?.ok).toBe(true)
		expect(sms?.ok).toBe(false)
		expect(result.delivered).toBe("email")
	})

	it("reports ok:false when every channel fails, without rejecting", async () => {
		configure_all()
		stub_channels({ fail: ["thesmsworks", "hooks.example.test"] })

		const result = await send({ to: { sms: "+447788223344", chat: HOOK }, message: "hi" })
		expect(result.ok).toBe(false)
		expect(result.delivered).toBeUndefined()
		expect(result.results.every((r) => !r.ok)).toBe(true)
	})

	it("tags each failure with the channel it came from", async () => {
		configure_all()
		stub_channels({ fail: ["thesmsworks"] })

		const result = await send({ to: { sms: "+447788223344" }, message: "hi" })
		const failure = result.results[0]
		expect(failure.ok).toBe(false)
		if (!failure.ok) expect((failure.error as PostboiError).channel).toBe("sms")
	})

	it("only touches channels that have an address", async () => {
		configure_all()
		const fetch = stub_channels()
		const result = await send({ to: { chat: HOOK }, message: "hi" })
		expect(result.results.map((r) => r.channel)).toEqual(["chat"])
		expect(fetch).toHaveBeenCalledOnce()
	})

	it("throws when `to` names no reachable channel at all", async () => {
		configure_all()
		await expect(send({ to: {}, message: "hi" })).rejects.toMatchObject({ code: "no_recipient" })
	})
})

describe("fallback chain", () => {
	it("stops at the first success and never pays for the rest", async () => {
		configure_all()
		const fetch = stub_channels()

		const result = await send({
			to: { email: "ada@test.com", sms: "+447788223344", chat: HOOK },
			channels: "cheapest",
			message: "Your code is 4291",
		})

		// Cost order is push → chat → email → sms, so chat wins and nothing else is tried.
		expect(result.delivered).toBe("chat")
		expect(result.results).toHaveLength(1)
		expect(fetch).toHaveBeenCalledOnce()
	})

	it("moves to the next channel when one fails", async () => {
		configure_all()
		stub_channels({ fail: ["hooks.example.test"] })

		const result = await send({
			to: { chat: HOOK, sms: "+447788223344" },
			channels: ["chat", "sms"],
			message: "hi",
		})

		expect(result.results.map((r) => [r.channel, r.ok])).toEqual([
			["chat", false],
			["sms", true],
		])
		expect(result.delivered).toBe("sms")
	})

	it("honours an explicit order over the cost order", async () => {
		configure_all()
		stub_channels()
		const result = await send({
			to: { chat: HOOK, sms: "+447788223344" },
			channels: ["sms", "chat"],
			message: "hi",
		})
		expect(result.delivered).toBe("sms")
	})

	// "cheapest" lists channels we may have no address for; it must not try them.
	it("skips channels in the order that have no address", async () => {
		configure_all()
		stub_channels()
		const result = await send({ to: { sms: "+447788223344" }, channels: "cheapest", message: "hi" })
		expect(result.results.map((r) => r.channel)).toEqual(["sms"])
	})

	it("reports every attempt when the whole chain fails", async () => {
		configure_all()
		stub_channels({ fail: ["hooks.example.test", "thesmsworks"] })
		const result = await send({
			to: { chat: HOOK, sms: "+447788223344" },
			channels: ["chat", "sms"],
			message: "hi",
		})
		expect(result.ok).toBe(false)
		expect(result.results).toHaveLength(2)
	})
})

describe("content mapping", () => {
	it("gives each channel the shape it expects from shared fields", async () => {
		configure_all()
		const fetch = stub_channels()

		await send({
			to: { email: "ada@test.com", sms: "+447788223344", chat: HOOK },
			subject: "Order shipped",
			message: "Your order shipped",
			body: "<p>Your order shipped</p>",
		})

		const by_host = (needle: string) =>
			JSON.parse(fetch.mock.calls.find(([u]) => (u as string).includes(needle))![1].body as string)

		expect(by_host("resend")).toMatchObject({
			subject: "Order shipped",
			html: "<p>Your order shipped</p>",
			text: "Your order shipped",
		})
		expect(by_host("thesmsworks")).toMatchObject({ content: "Your order shipped" })
		// Slack has no subject, so the shared one becomes the title.
		expect(by_host("hooks.example.test")).toMatchObject({
			text: "*Order shipped*\nYour order shipped",
		})
	})

	it("lets a per-channel override win over the shared field", async () => {
		configure_all()
		const fetch = stub_channels()

		await send({
			to: { sms: "+447788223344", chat: HOOK },
			message: "the long version, for chat",
			sms: { message: "short, for sms" },
		})

		const sms_body = JSON.parse(
			fetch.mock.calls.find(([u]) => (u as string).includes("thesmsworks"))![1].body as string
		)
		expect(sms_body.content).toBe("short, for sms")
	})

	it("uses `message` as the email body when no html is given", async () => {
		configure_all()
		const fetch = stub_channels()
		await send({ to: { email: "ada@test.com" }, subject: "hi", message: "plain only" })
		const body = JSON.parse(fetch.mock.calls[0][1].body as string)
		expect(body.html).toBe("plain only")
	})
})
