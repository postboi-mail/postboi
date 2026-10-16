import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { reset_config } from "../config.js"
import Twilio from "./twilio.js"
import Telnyx from "./telnyx.js"
import Vonage from "./vonage.js"
import SmsWorks from "./smsworks.js"
import Sns from "./sns.js"
import MockSms from "./mock.js"

const respond = (status: number, json: unknown) => ({
	ok: status < 300,
	status,
	headers: new Headers(),
	text: async () => JSON.stringify(json),
})
const fetch = vi.fn()
const to = "+447700900123"
const image = "https://example.com/a.png"

beforeEach(() => {
	reset_config()
	fetch.mockReset()
	vi.stubGlobal("fetch", fetch)
})
afterEach(() => vi.unstubAllGlobals())

const form = () => new URLSearchParams(fetch.mock.calls[0][1].body as string)
const json = () => JSON.parse(fetch.mock.calls[0][1].body as string)

describe("MMS, validity and provider_options", () => {
	it("Twilio: MediaUrl per image, ValidityPeriod, and its own parameters", async () => {
		fetch.mockResolvedValue(respond(201, { sid: "MM1", status: "queued" }))
		await new Twilio({ account_sid: "AC1", auth_token: "t", default: { from: "+1555" } }).send({
			to,
			message: "hi",
			media: [image, "https://example.com/b.png"],
			validity: 600,
			provider_options: { MessageIntent: "otp", SmartEncoded: true },
		})
		expect(form().getAll("MediaUrl")).toEqual([image, "https://example.com/b.png"])
		expect(form().get("ValidityPeriod")).toBe("600")
		expect(form().get("MessageIntent")).toBe("otp")
		expect(form().get("SmartEncoded")).toBe("true")
	})

	it("Telnyx: media_urls with type MMS, and its own fields", async () => {
		fetch.mockResolvedValue(respond(200, { data: { id: "m" } }))
		await new Telnyx({ api_key: "k", default: { from: "+1555" } }).send({
			to,
			message: "hi",
			media: [image],
			provider_options: { subject: "Your order" },
		})
		expect(json()).toMatchObject({ media_urls: [image], type: "MMS", subject: "Your order" })
	})

	it("Vonage: validity is its ttl, and its own sms object passes through", async () => {
		fetch.mockResolvedValue(respond(202, { message_uuid: "u" }))
		await new Vonage({ api_key: "k", api_secret: "s", default: { from: "ACME" } }).send({
			to,
			message: "hi",
			validity: 300,
			provider_options: { sms: { encoding_type: "text" } },
		})
		expect(json()).toMatchObject({ ttl: 300, sms: { encoding_type: "text" } })
	})

	it("refuses what a provider can't carry, before any request", async () => {
		const works = new SmsWorks({ api_key: "k", default: { from: "ACME" } })
		const vonage = new Vonage({ api_key: "k", api_secret: "s", default: { from: "ACME" } })
		const sns = new Sns({ access_key_id: "a", secret_access_key: "s", region: "eu-west-2" })
		const twilio = new Twilio({ account_sid: "AC1", auth_token: "t", default: { from: "+1555" } })
		const refused = async (p: { send(o: object): Promise<unknown> }, o: object) =>
			((await p.send({ to, message: "hi", ...o }).catch((e) => e)) as { code: string }).code

		expect(await refused(works, { media: [image] })).toBe("media_not_supported")
		expect(await refused(vonage, { media: [image] })).toBe("media_not_supported")
		expect(await refused(works, { validity: 600 })).toBe("validity_not_supported")
		expect(await refused(vonage, { validity: 10 })).toBe("invalid_validity")
		expect(await refused(twilio, { validity: 36001 })).toBe("invalid_validity")
		expect(await refused(twilio, { media: Array(11).fill(image) })).toBe("too_much_media")
		expect(await refused(twilio, { media: ["ftp://example.com/a.png"] })).toBe("invalid_media")
		expect(await refused(sns, { provider_options: { Foo: "1" } })).toBe(
			"provider_options_not_supported"
		)
		// A field the send sets itself can't be overwritten, whatever its case.
		expect(await refused(twilio, { provider_options: { body: "else" } })).toBe(
			"reserved_provider_option"
		)
		expect(fetch).not.toHaveBeenCalled()
	})

	it("validate() lists them all", async () => {
		const check = await new SmsWorks({ api_key: "k", default: { from: "ACME" } }).validate({
			to,
			message: "hi",
			media: [image],
			validity: 60,
		})
		expect(check.issues.map((i) => i.code)).toEqual([
			"media_not_supported",
			"validity_not_supported",
		])
	})

	it("the mock records media and validity, and refuses neither", async () => {
		const text = new MockSms()
		await text.send({ to, message: "hi", media: [image], validity: 60, provider_options: { x: 1 } })
		expect(text.last).toMatchObject({ media: [image], validity: 60 })
	})
})
