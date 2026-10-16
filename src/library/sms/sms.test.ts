import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import MockSms from "./mock.js"
import Twilio from "./twilio.js"
import SmsWorks from "./smsworks.js"
import PureSms from "./puresms.js"
import { PostboiError, type Channel } from "../errors.js"
import { reset_config, configure } from "../config.js"

const respond = ({ ok = true, status = 200, json = {} as unknown } = {}) =>
	({
		ok,
		status,
		headers: new Headers(),
		text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
	}) as unknown as Response

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
})
afterEach(() => reset_config())

describe("prepare", () => {
	it("normalises recipients and records segment cost", async () => {
		const text = new MockSms({ default: { from: "POSTBOI", country: "GB" } })
		await text.send({ to: "07788 223344", message: "Your code is 4291" })
		expect(text.last?.to).toEqual(["+447788223344"])
		expect(text.last?.from).toBe("POSTBOI")
		expect(text.last?.segments).toMatchObject({ count: 1, encoding: "gsm7" })
	})

	it("rejects a recipient list that is empty once parsed", async () => {
		const text = new MockSms({ default: { from: "POSTBOI" } })
		for (const to of [[], ", "]) {
			await expect(text.send({ to, message: "hi" })).rejects.toMatchObject({ code: "no_recipient" })
		}
		expect(text.last).toBeUndefined()
	})

	it("accepts a comma-separated list, an array, and the object form", async () => {
		const text = new MockSms({ default: { country: "GB" } })
		await text.send({ to: "07788223344, 07700900123", message: "hi" })
		expect(text.last?.to).toHaveLength(2)
		await text.send({ to: ["+447788223344", 447700900123], message: "hi" })
		expect(text.last?.to).toEqual(["+447788223344", "+447700900123"])
		await text.send({ to: { number: "07788223344", name: "Ada" }, message: "hi" })
		expect(text.last?.to).toEqual(["+447788223344"])
	})

	it("lets a per-send country override the default", async () => {
		const text = new MockSms({ default: { country: "US" } })
		await text.send({ to: "07788223344", message: "hi", country: "GB" })
		expect(text.last?.to).toEqual(["+447788223344"])
	})

	it("rejects an empty message rather than sending one", async () => {
		const text = new MockSms({ default: { country: "GB" } })
		await expect(text.send({ to: "07788223344", message: "   " })).rejects.toMatchObject({
			code: "empty_message",
		})
	})

	it("rejects a send with no recipient", async () => {
		const text = new MockSms()
		await expect(text.send({ message: "hi" })).rejects.toMatchObject({ code: "no_recipient" })
	})

	it("tags errors with the sms channel", async () => {
		const text = new MockSms()
		try {
			await text.send({ message: "hi" })
		} catch (error) {
			expect((error as PostboiError).channel).toBe<Channel>("sms")
		}
	})
})

describe("scheduling", () => {
	it("refuses rather than silently sending now when unsupported", async () => {
		// SNS has no scheduling; the mock does, so use a provider that says it doesn't.
		class NoSchedule extends MockSms {
			protected override readonly supports_scheduling = false
		}
		const text = new NoSchedule({ default: { country: "GB" } })
		await expect(
			text.send({ to: "07788223344", message: "hi", scheduled_at: { days: 1 } })
		).rejects.toMatchObject({ code: "scheduling_not_supported" })
	})

	it("resolves a relative duration where the provider supports it", async () => {
		const text = new MockSms({ default: { country: "GB" } })
		await text.send({ to: "07788223344", message: "hi", scheduled_at: { days: 1 } })
		expect(text.last?.scheduled_at).toBeInstanceOf(Date)
	})
})

describe("batch", () => {
	it("returns one result per message and never rejects wholesale", async () => {
		const text = new MockSms({ default: { country: "GB" } })
		const results = await text.send([
			{ to: "07788223344", message: "one" },
			{ message: "no recipient" },
			{ to: "07700900123", message: "three" },
		])
		expect(results).toHaveLength(3)
		expect(results[0]).toMatchObject({ ok: true, index: 0 })
		expect(results[1]).toMatchObject({ ok: false, index: 1 })
		expect(results[2]).toMatchObject({ ok: true, index: 2 })
		expect(text.sent).toHaveLength(2)
	})
})

describe("hooks", () => {
	it("fires with the sms channel and can replace the message", async () => {
		const seen: Array<string> = []
		configure({
			hooks: {
				before: {
					send: ({ channel, message }) => {
						seen.push(channel)
						if (channel === "sms") return { ...message, message: "replaced" }
					},
				},
			},
		})
		const text = new MockSms({ default: { country: "GB" } })
		await text.send({ to: "07788223344", message: "original" })
		expect(seen).toEqual(["sms"])
		expect(text.last?.message).toBe("replaced")
	})
})

describe("twilio", () => {
	it("posts form-encoded parameters with basic auth", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ json: { sid: "SM1", status: "queued" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new Twilio({
			account_sid: "AC123",
			auth_token: "tok",
			default: { from: "+15550001111", country: "GB" },
		})
		const result = await text.send({ to: "07788223344", message: "hi" })

		expect(result).toEqual({ sid: "SM1", status: "queued" })
		const [url, init] = fetch.mock.calls[0]
		expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json")
		expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded")
		expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("AC123:tok").toString("base64")}`)
		const body = new URLSearchParams(init.body as string)
		expect(body.get("To")).toBe("+447788223344")
		expect(body.get("From")).toBe("+15550001111")
		expect(body.get("Body")).toBe("hi")
	})

	it("surfaces a twilio error payload as a normalized error", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					respond({ ok: false, status: 400, json: { code: 21211, message: "Invalid 'To'" } })
				)
		)
		const text = new Twilio({ account_sid: "AC1", auth_token: "t", default: { from: "+1555" } })
		await expect(text.send({ to: "+447788223344", message: "hi" })).rejects.toMatchObject({
			provider: "twilio",
			channel: "sms",
			code: 21211,
			status: 400,
		})
	})

	it("refuses to schedule without a messaging service, rather than sending now", async () => {
		vi.stubGlobal("fetch", vi.fn())
		const text = new Twilio({ account_sid: "AC1", auth_token: "t", default: { from: "+1555" } })
		await expect(
			text.send({ to: "+447788223344", message: "hi", scheduled_at: { days: 1 } })
		).rejects.toMatchObject({ code: "scheduling_needs_service" })
	})

	it("sends no idempotency header, since Twilio documents none for a send", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ json: { sid: "SM1", status: "queued" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new Twilio({ account_sid: "AC1", auth_token: "t", default: { from: "+1555" } })
		await text.send({ to: "+447788223344", message: "hi", idempotency_key: "order-1" })
		const headers = fetch.mock.calls[0][1].headers as Record<string, string>
		expect(Object.keys(headers).some((h) => /idempotency/i.test(h))).toBe(false)
	})

	it("never retries a 5xx, even with a key, because the text may already have gone", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ ok: false, status: 503 }))
		vi.stubGlobal("fetch", fetch)
		const text = new Twilio({
			account_sid: "AC1",
			auth_token: "t",
			default: { from: "+1555" },
			retries: 2,
			retry_delay: 0,
		})
		const error = await text
			.send({ to: "+447788223344", message: "hi", idempotency_key: "order-1" })
			.catch((e: unknown) => e)
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(error).toMatchObject({ status: 503, outcome_unknown: true })
	})

	it("retries a 429, which Twilio refused before creating anything", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				respond({ ok: false, status: 429, json: { code: 20429, message: "Too Many Requests" } })
			)
			.mockResolvedValueOnce(respond({ json: { sid: "SM1", status: "queued" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new Twilio({
			account_sid: "AC1",
			auth_token: "t",
			default: { from: "+1555" },
			retries: 1,
			retry_delay: 0,
		})
		await expect(text.send({ to: "+447788223344", message: "hi" })).resolves.toMatchObject({
			sid: "SM1",
		})
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it("refuses several recipients on one send instead of texting only the first", async () => {
		vi.stubGlobal("fetch", vi.fn())
		const text = new Twilio({ account_sid: "AC1", auth_token: "t", default: { from: "+1555" } })
		await expect(
			text.send({ to: ["+447788223344", "+447700900123"], message: "hi" })
		).rejects.toMatchObject({ code: "single_recipient_only" })
	})
})

describe("smsworks", () => {
	it("sends a single message to /message/send with the bare token", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(respond({ json: { messageid: "abc", status: "sent", credits: 1 } }))
		vi.stubGlobal("fetch", fetch)
		const text = new SmsWorks({ api_key: "jwt-token", default: { from: "POSTBOI", country: "GB" } })
		const result = await text.send({ to: "07788223344", message: "hi" })

		expect(result).toMatchObject({ messageid: "abc", status: "sent" })
		const [url, init] = fetch.mock.calls[0]
		expect(url).toBe("https://api.thesmsworks.co.uk/v1/message/send")
		expect(init.headers.Authorization).toBe("jwt-token")
		const body = JSON.parse(init.body as string)
		// Their API wants the number without the leading plus.
		expect(body).toMatchObject({ sender: "POSTBOI", destination: "447788223344", content: "hi" })
	})

	it("uses the batch endpoint for several recipients", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ json: { batchid: "b1" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new SmsWorks({ api_key: "k", default: { from: "POSTBOI", country: "GB" } })
		const result = await text.send({ to: ["07788223344", "07700900123"], message: "hi" })

		const [url, init] = fetch.mock.calls[0]
		expect(url).toBe("https://api.thesmsworks.co.uk/v1/batch/any")
		expect(JSON.parse(init.body as string).messages).toHaveLength(2)
		expect(result).toMatchObject({ messageid: "b1" })
	})

	it("recognises an error body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				respond({
					ok: false,
					status: 401,
					json: { status: "401", errorCode: "AUTH", message: "bad token" },
				})
			)
		)
		const text = new SmsWorks({ api_key: "k", default: { from: "P" } })
		await expect(text.send({ to: "+447788223344", message: "hi" })).rejects.toMatchObject({
			provider: "smsworks",
			channel: "sms",
			code: "AUTH",
		})
	})
})

describe("puresms", () => {
	it("sends a single message to /sms/send with the key in X-Api-Key", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ json: { id: "12345" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new PureSms({ api_key: "key", default: { from: "POSTBOI", country: "GB" } })
		const result = await text.send({ to: "07788223344", message: "hi", tags: ["otp"] })

		expect(result).toEqual({ id: "12345", kind: "message" })
		const [url, init] = fetch.mock.calls[0]
		expect(url).toBe("https://connect-api.divergent.cloud/sms/send")
		expect(init.headers["X-Api-Key"]).toBe("key")
		// Their API takes E.164 as-is, plus included.
		expect(JSON.parse(init.body as string)).toEqual({
			sender: "POSTBOI",
			recipient: "+447788223344",
			content: "hi",
			clientReference: "otp",
		})
	})

	it("uses the bulk endpoint for several recipients, scheduled from the top level", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ json: { batchId: "b1", messageCount: 2 } }))
		vi.stubGlobal("fetch", fetch)
		const text = new PureSms({ api_key: "k", default: { from: "POSTBOI", country: "GB" } })
		const when = new Date("2030-01-01T10:00:00Z")
		const result = await text.send({
			to: ["07788223344", "07700900123"],
			message: "hi",
			scheduled_at: when,
		})

		const [url, init] = fetch.mock.calls[0]
		expect(url).toBe("https://connect-api.divergent.cloud/sms/send/bulk")
		const body = JSON.parse(init.body as string)
		expect(body.sendAtUtc).toBe(when.toISOString())
		expect(body.messages).toHaveLength(2)
		expect(body.messages[1]).toMatchObject({ recipient: "+447700900123" })
		expect(body.messages[1]).not.toHaveProperty("sendAtUtc")
		expect(result).toEqual({ id: "b1", kind: "batch", count: 2 })
	})

	it("fails a batch that was only partly accepted, keeping what did go out on raw", async () => {
		// 207 Multi-Status is `ok` to fetch; the errors array is what says a recipient was dropped.
		const rejected = { index: 1, description: "Invalid recipient" }
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					respond({ status: 207, json: { batchId: "b1", messageCount: 1, errors: [rejected] } })
				)
		)
		const text = new PureSms({ api_key: "k", default: { from: "P", country: "GB" } })
		const error = await text
			.send({ to: ["07788223344", "07700900123"], message: "hi" })
			.catch((e: PostboiError) => e)
		expect(error).toMatchObject({ provider: "puresms", code: "partial_batch", status: 207 })
		expect(error.message).toContain("Invalid recipient")
		expect(error.raw).toMatchObject({ batchId: "b1", messageCount: 1 })
	})

	it("reads problem details, including the per-field validation errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				respond({
					ok: false,
					status: 400,
					json: {
						title: "One or more validation errors occurred.",
						status: 400,
						errors: { recipient: ["Recipient must be E.164."] },
					},
				})
			)
		)
		const text = new PureSms({ api_key: "k", default: { from: "P" } })
		await expect(text.send({ to: "+447788223344", message: "hi" })).rejects.toMatchObject({
			provider: "puresms",
			channel: "sms",
			status: 400,
			message: "One or more validation errors occurred. Recipient must be E.164.",
		})
	})

	it("cancels a pending scheduled message", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ json: {} }))
		vi.stubGlobal("fetch", fetch)
		const text = new PureSms({ api_key: "k" })
		await expect(text.cancel("12345")).resolves.toEqual({ id: "12345" })
		const [url, init] = fetch.mock.calls[0]
		expect(url).toBe("https://connect-api.divergent.cloud/sms/send/12345")
		expect(init.method).toBe("DELETE")
	})

	it("treats a batch cancel that cancelled nothing as a failure, not a 200", async () => {
		// The bulk endpoint answers 200 whether or not anything was still pending — the
		// count is the only thing that says so.
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(respond({ json: { cancelledCount: 2 } }))
			.mockResolvedValueOnce(
				respond({ json: { cancelledCount: 0, reason: "Batch has already been sent" } })
			)
		vi.stubGlobal("fetch", fetch)
		const text = new PureSms({ api_key: "k" })
		await expect(text.cancel("b1", "batch")).resolves.toEqual({ id: "b1" })
		expect(fetch.mock.calls[0][0]).toBe("https://connect-api.divergent.cloud/sms/send/bulk/b1")
		await expect(text.cancel("b1", "batch")).rejects.toMatchObject({
			provider: "puresms",
			message: "Batch has already been sent",
		})
	})
})
