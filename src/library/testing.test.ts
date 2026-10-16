import { describe, it, expect, beforeEach } from "vitest"
import { reset_config } from "./config.js"
import {
	mock_fetch,
	run_sms_contract,
	sms_contract_cases,
	type MockResponse,
	type SmsContractFixtures,
} from "./testing.js"
import type { SmsProvider } from "./sms/provider.js"
import type { SmsReceipt } from "./sms/types.js"
import Twilio from "./sms/twilio.js"
import Telnyx from "./sms/telnyx.js"
import Vonage from "./sms/vonage.js"
import Plivo from "./sms/plivo.js"
import Sinch from "./sms/sinch.js"
import Bandwidth from "./sms/bandwidth.js"
import PureSms from "./sms/puresms.js"
import SmsWorks from "./sms/smsworks.js"
import Sns from "./sms/sns.js"

beforeEach(() => {
	reset_config()
	delete process.env.NODE_ENV
})

describe("mock_fetch", () => {
	it("answers in order, keeps answering with the last, and records every request", async () => {
		const fetch = mock_fetch([{ status: 201, json: { a: 1 } }, { text: "<ok/>" }])
		const first = await fetch("https://example.com/a", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "To=%2B1&Body=hi",
		})
		expect(first.status).toBe(201)
		expect(await first.json()).toEqual({ a: 1 })
		expect(await (await fetch("https://example.com/b")).text()).toBe("<ok/>")
		expect(await (await fetch("https://example.com/c")).text()).toBe("<ok/>")
		expect(fetch.calls.map((c) => c.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
			"https://example.com/c",
		])
		expect(fetch.calls[0].form().get("Body")).toBe("hi")
		expect(fetch.calls[0].method).toBe("POST")
	})

	it("can decide from the request, throw like a dropped connection, and stand in for fetch", async () => {
		const fetch = mock_fetch((request) =>
			request.url.endsWith("/down") ? { error: new TypeError("fetch failed") } : { json: {} }
		)
		await expect(fetch("https://example.com/down")).rejects.toThrow("fetch failed")
		const original = globalThis.fetch
		const restore = fetch.install()
		expect(globalThis.fetch).not.toBe(original)
		await globalThis.fetch("https://example.com/up")
		restore()
		expect(globalThis.fetch).toBe(original)
		expect(fetch.calls).toHaveLength(2)
	})

	it("reads the method, headers and body off a Request", async () => {
		const fetch = mock_fetch([{ json: {} }])
		await fetch(
			new Request("https://example.com/r", {
				method: "POST",
				headers: { "x-key": "k" },
				body: JSON.stringify({ to: "+1" }),
			})
		)
		expect(fetch.calls[0].method).toBe("POST")
		expect(fetch.calls[0].headers.get("x-key")).toBe("k")
		expect(fetch.calls[0].json()).toEqual({ to: "+1" })
	})
})

/** Every SMS provider postboi ships, with the answer its API gives an accepted send. */
const PROVIDERS: Array<
	[string, () => SmsProvider<SmsReceipt>, MockResponse, Partial<SmsContractFixtures>?]
> = [
	[
		"twilio",
		() => new Twilio({ account_sid: "AC1", auth_token: "t", default: { from: "+15550001111" } }),
		{ status: 201, json: { sid: "SM1", status: "queued" } },
		{ reserved: "To" },
	],
	[
		"telnyx",
		() => new Telnyx({ api_key: "k", default: { from: "+15550001111" } }),
		{ json: { data: { id: "m1", to: [{ status: "queued" }] } } },
		{ reserved: "to" },
	],
	[
		"vonage",
		() => new Vonage({ api_key: "k", api_secret: "s", default: { from: "ACME" } }),
		{ status: 202, json: { message_uuid: "u1" } },
		{ reserved: "to" },
	],
	[
		"plivo",
		() => new Plivo({ auth_id: "MA1", auth_token: "t", default: { from: "+15550001111" } }),
		{ status: 202, json: { message_uuid: ["u1"], api_id: "a" } },
		{ reserved: "dst" },
	],
	[
		"sinch",
		() => new Sinch({ service_plan_id: "p", api_token: "t", default: { from: "ACME" } }),
		{ status: 201, json: { id: "b1" } },
		{ reserved: "to" },
	],
	[
		"bandwidth",
		() =>
			new Bandwidth({
				account_id: "1",
				username: "u",
				password: "p",
				application_id: "a",
				default: { from: "+15550001111" },
			}),
		{ status: 202, json: { id: "m1", segmentCount: 1 } },
		{ reserved: "to" },
	],
	[
		"puresms",
		() => new PureSms({ api_key: "k", default: { from: "ACME" } }),
		{ json: { id: "123" } },
		{ reserved: "recipient" },
	],
	[
		"smsworks",
		() => new SmsWorks({ api_key: "k", default: { from: "ACME" } }),
		{ status: 201, json: { messageid: "w1", status: "SENT" } },
		{
			reserved: "destination",
			scheduled: { status: 201, json: { messageid: "w1", status: "SCHEDULED" } },
		},
	],
	[
		"sns",
		() => new Sns({ access_key_id: "a", secret_access_key: "s", region: "eu-west-2" }),
		{
			text: "<PublishResponse><PublishResult><MessageId>n1</MessageId></PublishResult></PublishResponse>",
		},
	],
]

describe("every SMS provider keeps the contract", () => {
	for (const [name, make, accepted, extra] of PROVIDERS) {
		describe(name, () => {
			for (const contract of sms_contract_cases(make, {
				to: "+447700900123",
				accepted,
				...extra,
			})) {
				it(contract.name, async () => {
					await expect(contract.run()).resolves.toBeUndefined()
				})
			}
		})
	}
})

describe("run_sms_contract", () => {
	it("reports a provider that breaks the contract, case by case", async () => {
		// Answers with an empty id: the receipt check has to catch it.
		const report = await run_sms_contract(PROVIDERS[0][1], {
			to: "+447700900123",
			accepted: { status: 201, json: {} },
		})
		expect(report.ok).toBe(false)
		expect(report.failed.map((f) => f.name)).toContain(
			"a send makes one request and answers with the common result"
		)
		expect(report.passed.length).toBeGreaterThan(0)
	})
})
