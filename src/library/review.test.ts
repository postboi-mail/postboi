/**
 * Regression tests for the findings of the first multi-channel code review — one per
 * confirmed bug, so none of them can come back quietly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { configure, reset_config } from "./config.js"
import { Transport, type RequestSpec } from "./transport.js"
import type { Hooks, PreparedMessage } from "./index.js"
import { SmsProvider, ChatProvider, PushProvider } from "./postboi.js"
import SmsWorks from "./sms/smsworks.js"
import Twilio from "./sms/twilio.js"
import Telegram from "./chat/telegram.js"
import Discord from "./chat/discord.js"
import WebPush from "./push/webpush.js"
import FCM from "./push/fcm.js"
import { to_e164 } from "./sms/phone.js"
import { chat } from "./chat/send.js"
import type { Channel } from "./errors.js"

const respond = ({ ok = true, status = 200, body = "" as unknown, url = "" } = {}) =>
	({
		ok,
		status,
		url,
		headers: new Headers(),
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	}) as unknown as Response

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.NODE_ENV
})
afterEach(() => reset_config())

describe("hooks narrow on channel (discriminated union)", () => {
	// The documented pattern must *compile* — this test's value is at typecheck time.
	it("the documented narrowing example typechecks and runs", async () => {
		const seen: Array<string> = []
		const hooks: Hooks = {
			before: {
				send: (ctx) => {
					if (ctx.channel === "email") seen.push(`email:${ctx.message.subject}`)
					if (ctx.channel === "sms") seen.push(`sms:${ctx.message.to.join()}`)
					if (ctx.channel === "chat") seen.push(`chat:${ctx.message.to}`)
					if (ctx.channel === "push") seen.push(`push:${ctx.message.message}`)
				},
			},
		}
		configure({ hooks })

		const { default: MockSms } = await import("./sms/mock.js")
		await new MockSms({ default: { country: "GB" } }).send({ to: "07788223344", message: "hi" })
		expect(seen).toEqual(["sms:+447788223344"])
	})

	// A pre-existing email-only hook that replaces the message must keep compiling.
	it("an email replace hook narrows and returns its own shape", async () => {
		const hooks: Hooks = {
			before: {
				send: (ctx) => {
					if (ctx.channel !== "email") return
					const replaced: PreparedMessage = { ...ctx.message, to: "qa@example.com" }
					return replaced
				},
			},
		}
		configure({ hooks })
		const { default: Mock } = await import("./mock.js")
		const mail = new Mock({ default: { from: "f@test.com" } })
		await mail.send({ to: "real@test.com", body: "hi" })
		expect(mail.last?.to).toEqual([{ address: "qa@example.com" }])
	})
})

describe("third-party Transport subclasses get global config hooks", () => {
	class CustomChannel extends Transport<{ ok: true }, { note: string }> {
		protected readonly provider = "custom"
		protected readonly channel = "chat" as Channel
		async post(note: string) {
			return this.with_hooks(
				async () => ({ note }),
				async () => ({ ok: true }) as const
			)
		}
		protected build_request(): RequestSpec {
			throw new Error("unused")
		}
		protected parse_response(): { ok: true } {
			return { ok: true }
		}
	}

	it("runs before.send from postboi.config without any subclass ritual", async () => {
		const seen: Array<string> = []
		configure({
			hooks: { before: { send: (ctx) => void seen.push(ctx.provider) } },
		})
		await new CustomChannel().post("hello")
		expect(seen).toEqual(["custom"])
	})
})

describe("channel base classes are importable from the package root", () => {
	it("exports SmsProvider, ChatProvider and PushProvider", () => {
		expect(SmsProvider).toBeTypeOf("function")
		expect(ChatProvider).toBeTypeOf("function")
		expect(PushProvider).toBeTypeOf("function")
		// The documented 410 check rides the export.
		expect(PushProvider.is_expired(new Error("nope"))).toBe(false)
	})
})

describe("smsworks scheduling", () => {
	it("posts a scheduled single send to /message/schedule, not /message/send", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { messageid: "m1" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new SmsWorks({ api_key: "k", default: { from: "P", country: "GB" } })
		await text.send({ to: "07788223344", message: "hi", scheduled_at: { days: 1 } })
		expect(fetch.mock.calls[0][0]).toBe("https://api.thesmsworks.co.uk/v1/message/schedule")
		expect(JSON.parse(fetch.mock.calls[0][1].body as string).schedule).toBeTruthy()
	})

	it("posts a scheduled multi send to /batch/schedule", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { batchid: "b1" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new SmsWorks({ api_key: "k", default: { from: "P", country: "GB" } })
		await text.send({
			to: ["07788223344", "07700900123"],
			message: "hi",
			scheduled_at: { days: 1 },
		})
		expect(fetch.mock.calls[0][0]).toBe("https://api.thesmsworks.co.uk/v1/batch/schedule")
	})
})

describe("twilio with a messaging service", () => {
	it("sends with no from at all — the service supplies the sender pool", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { sid: "SM1", status: "queued" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new Twilio({
			account_sid: "AC1",
			auth_token: "t",
			messaging_service_sid: "MG123",
		})
		await text.send({ to: "+447788223344", message: "hi" })
		const body = new URLSearchParams(fetch.mock.calls[0][1].body as string)
		expect(body.get("MessagingServiceSid")).toBe("MG123")
		expect(body.get("From")).toBeNull()
	})

	it("still requires a sender without one", async () => {
		vi.stubGlobal("fetch", vi.fn())
		const text = new Twilio({ account_sid: "AC1", auth_token: "t" })
		await expect(text.send({ to: "+447788223344", message: "hi" })).rejects.toMatchObject({
			code: "no_sender",
		})
	})
})

describe("telegram", () => {
	it("reads a default chat id committed to postboi.config", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
		configure({ chat: { provider: "telegram", default: { to: "987654321" } } })
		const fetch = vi
			.fn()
			.mockResolvedValue(respond({ body: { ok: true, result: { message_id: 7 } } }))
		vi.stubGlobal("fetch", fetch)

		await chat({ message: "Deploy finished" })
		expect(JSON.parse(fetch.mock.calls[0][1].body as string).chat_id).toBe("987654321")
		delete process.env.TELEGRAM_BOT_TOKEN
	})

	it("escapes the body under a title instead of feeding it to Markdown", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(respond({ body: { ok: true, result: { message_id: 7 } } }))
		vi.stubGlobal("fetch", fetch)
		const bot = new Telegram({ bot_token: "t" })
		await bot.send({
			to: "1",
			title: "Deploy <ok>",
			message: "migrated table user_accounts & friends",
		})

		const body = JSON.parse(fetch.mock.calls[0][1].body as string)
		expect(body.parse_mode).toBe("HTML")
		expect(body.text).toBe("<b>Deploy &lt;ok&gt;</b>\nmigrated table user_accounts &amp; friends")
	})
})

describe("webpush success handling", () => {
	const SUBSCRIPTION = {
		endpoint: "https://push.example.net/send/abc",
		keys: {
			p256dh:
				"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
			auth: "BTBZMqHH6r4Tts7J_aSIgg",
		},
	}

	it("does not throw on a 201 that carries a text body", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(respond({ status: 201, body: "Created", url: SUBSCRIPTION.endpoint }))
		)
		const notify = new WebPush({
			public_key:
				"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
			private_key: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
			subject: "mailto:a@b.c",
		})
		await expect(notify.send({ to: SUBSCRIPTION, message: "hi" })).resolves.toMatchObject({
			ok: true,
		})
	})
})

describe("phone numbers with a printed (0)", () => {
	it("drops the bracketed trunk zero from international form", () => {
		expect(to_e164("+44 (0) 7788 223344")).toBe("+447788223344")
		expect(to_e164("+44 (0)7788 223344")).toBe("+447788223344")
	})

	it("still treats real bracketed digits as digits", () => {
		// "(020) 7946 0958" is area-code formatting, not the (0) convention.
		expect(to_e164("(020) 7946 0958", "GB")).toBe("+442079460958")
	})
})

describe("discord truncation", () => {
	it("counts code points, so emoji content is not needlessly cut", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ status: 204 }))
		vi.stubGlobal("fetch", fetch)
		// 1500 emoji = 3000 UTF-16 units but only 1500 of Discord's 2000 code points.
		await new Discord({ webhook_url: "https://h.test/x" }).send({ message: "😀".repeat(1500) })
		const content = JSON.parse(fetch.mock.calls[0][1].body as string).content
		expect(Array.from(content)).toHaveLength(1500)
	})

	it("never splits a surrogate pair at the cut", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ status: 204 }))
		vi.stubGlobal("fetch", fetch)
		await new Discord({ webhook_url: "https://h.test/x" }).send({ message: "😀".repeat(2100) })
		const content = JSON.parse(fetch.mock.calls[0][1].body as string).content
		const points = Array.from(content) as Array<string>
		expect(points).toHaveLength(2000)
		expect(points.at(-1)).toBe("…")
		// Every remaining point is a whole emoji or the ellipsis — no lone surrogates.
		expect(content.includes("�")).toBe(false)
		for (const point of points.slice(0, -1)) expect(point).toBe("😀")
	})
})

describe("fcm token cache", () => {
	const KEY_PEM = "" // filled per test — the exchange is mocked before signing matters

	it("concurrent cold sends share one token exchange", async () => {
		let oauth_calls = 0
		const fetch = vi.fn(async (url: string) => {
			if (url.includes("oauth2.googleapis.com")) {
				oauth_calls++
				// Slow enough that both sends are in flight before it resolves.
				await new Promise((r) => setTimeout(r, 20))
				return respond({ body: { access_token: "tok", expires_in: 3600 } })
			}
			return respond({ body: { name: "projects/p/messages/1" } })
		})
		vi.stubGlobal("fetch", fetch)

		// A real PKCS8 sign needs a real key; stub the crypto sign path via a spy instead.
		const import_spy = vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey)
		const sign_spy = vi.spyOn(crypto.subtle, "sign").mockResolvedValue(new ArrayBuffer(8))

		const notify = new FCM({
			project_id: "p",
			client_email: `svc-${Date.now()}@test.iam`,
			private_key: KEY_PEM,
		})
		await Promise.all([
			notify.send({ to: "tok-1", message: "hi" }),
			notify.send({ to: "tok-2", message: "hi" }),
		])

		expect(oauth_calls).toBe(1)
		import_spy.mockRestore()
		sign_spy.mockRestore()
	})
})
