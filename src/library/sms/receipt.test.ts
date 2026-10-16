import { describe, it, expect, vi, beforeEach } from "vitest"
import { reset_config } from "../config.js"
import { sms_delivery } from "./provider.js"
import MockSms from "./mock.js"
import SmsWorks from "./smsworks.js"
import Twilio from "./twilio.js"

const to = "+447700900123"

function stub(status: number, json: unknown) {
	const fetch = vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(),
		text: async () => JSON.stringify(json),
	})
	vi.stubGlobal("fetch", fetch)
	return fetch
}

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
})

describe("sms_delivery", () => {
	it("reads every provider's word for a message it just took", () => {
		expect(sms_delivery(undefined)).toBe("queued")
		expect(sms_delivery("accepted")).toBe("queued")
		expect(sms_delivery("QUEUED")).toBe("queued")
		expect(sms_delivery("scheduled")).toBe("scheduled")
		expect(sms_delivery("SENT")).toBe("sent")
		expect(sms_delivery("sending")).toBe("sent")
		expect(sms_delivery("delivered")).toBe("delivered")
		expect(sms_delivery("something new")).toBe("unknown")
	})
})

describe("every send answers with the same few fields", () => {
	it("keeps the provider's own fields and adds id, ids, provider and delivery", async () => {
		stub(200, { messageid: "w-1", status: "SENT", credits: 1 })
		const result = await new SmsWorks({ api_key: "k", default: { from: "ACME" } }).send({
			to,
			message: "hi",
		})
		expect(result).toEqual({
			id: "w-1",
			ids: ["w-1"],
			provider: "smsworks",
			delivery: "sent",
			messageid: "w-1",
			status: "SENT",
			credits: 1,
		})
	})

	it("says scheduled for a scheduled send whose answer names no state", async () => {
		stub(201, { messageid: "w-2" })
		const result = await new SmsWorks({ api_key: "k", default: { from: "ACME" } }).send({
			to,
			message: "hi",
			scheduled_at: new Date(Date.now() + 3_600_000),
		})
		expect(result).toMatchObject({ id: "w-2", status: "sent", delivery: "scheduled" })
	})

	it("says scheduled for a send held for later, whatever the provider called it", async () => {
		stub(201, { sid: "SM1", status: "accepted" })
		const result = await new Twilio({
			account_sid: "AC1",
			auth_token: "t",
			messaging_service_sid: "MG1",
		}).send({ to, message: "hi", scheduled_at: new Date(Date.now() + 3_600_000) })
		expect(result).toMatchObject({ id: "SM1", status: "accepted", delivery: "scheduled" })
	})

	it("the mock answers in the same shape", async () => {
		const text = new MockSms()
		const now = await text.send({ to, message: "hi" })
		const later = await text.send({
			to,
			message: "hi",
			scheduled_at: new Date(Date.now() + 60_000),
		})
		expect(now).toMatchObject({ provider: "mock", delivery: "sent", ids: [now.id] })
		expect(later.delivery).toBe("scheduled")
	})
})
