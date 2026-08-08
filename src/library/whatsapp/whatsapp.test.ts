import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import MockWhatsapp from "./mock.js"
import TwilioWhatsapp from "./twilio.js"
import Meta from "./meta.js"
import { WhatsappProvider } from "./provider.js"
import { whatsapp } from "./send.js"
import { send } from "../send.js"
import { configure, reset_config } from "../config.js"
import type { Channel, PostboiError } from "../errors.js"

const respond = ({ ok = true, status = 200, body = {} as unknown } = {}) =>
	({
		ok,
		status,
		url: "",
		headers: new Headers(),
		text: async () => JSON.stringify(body),
	}) as unknown as Response

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.NODE_ENV
	delete process.env.POSTBOI_WHATSAPP_PROVIDER
})
afterEach(() => {
	reset_config()
	for (const key of [
		"WHATSAPP_ACCESS_TOKEN",
		"WHATSAPP_PHONE_NUMBER_ID",
		"POSTBOI_WHATSAPP_LANGUAGE",
		"POSTBOI_WHATSAPP_COUNTRY",
		"POSTBOI_SMS_PROVIDER",
	])
		delete process.env[key]
})

describe("prepare", () => {
	it("requires a message or a template", async () => {
		const wa = new MockWhatsapp()
		const error = (await wa.send({ to: "+447788223344" }).catch((e) => e)) as PostboiError
		expect(error.code).toBe("no_content")
		expect(error.channel).toBe<Channel>("whatsapp")
	})

	it("rejects a message and a template together, explaining variables", async () => {
		const wa = new MockWhatsapp()
		await expect(
			wa.send({ to: "+447788223344", message: "hi", template: "order_shipped" })
		).rejects.toMatchObject({ code: "ambiguous_content" })
	})

	it("normalises the recipient to E.164 with the default country", async () => {
		const wa = new MockWhatsapp({ default: { country: "GB" } })
		await wa.send({ to: "07788 223344", message: "hi" })
		expect(wa.last?.to).toBe("+447788223344")
	})

	it("defaults the template language to en", async () => {
		const wa = new MockWhatsapp()
		await wa.send({ to: "+447788223344", template: "order_shipped" })
		expect(wa.last?.language).toBe("en")
	})
})

describe("mock outside_window simulation", () => {
	it("fails free-form text but still delivers templates, like production", async () => {
		const wa = new MockWhatsapp({ outside_window: true })
		const error = await wa.send({ to: "+447788223344", message: "hi" }).catch((e) => e)
		expect(WhatsappProvider.is_outside_window(error)).toBe(true)
		expect(MockWhatsapp.is_outside_window(error)).toBe(true)
		// The documented one-import form: the check hangs off whatsapp() itself.
		expect(whatsapp.closed(error)).toBe(true)
		expect(whatsapp.closed(new Error("other"))).toBe(false)

		await wa.send({ to: "+447788223344", template: "order_shipped" })
		expect(wa.last?.template).toBe("order_shipped")
	})
})

describe("twilio", () => {
	const CREDS = { account_sid: "AC1", auth_token: "t" }

	it("prefixes both addresses with whatsapp: and sends free-form text as Body", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { sid: "SM1", status: "queued" } }))
		vi.stubGlobal("fetch", fetch)
		const wa = new TwilioWhatsapp({ ...CREDS, default: { from: "+14155238886" } })
		await wa.send({ to: "+447788223344", message: "On its way" })

		const body = new URLSearchParams(fetch.mock.calls[0][1].body as string)
		expect(body.get("To")).toBe("whatsapp:+447788223344")
		expect(body.get("From")).toBe("whatsapp:+14155238886")
		expect(body.get("Body")).toBe("On its way")
		expect(body.get("ContentSid")).toBeNull()
	})

	it("sends a template as ContentSid with JSON ContentVariables and no Body", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { sid: "SM1", status: "queued" } }))
		vi.stubGlobal("fetch", fetch)
		const wa = new TwilioWhatsapp({ ...CREDS, default: { from: "+14155238886" } })
		await wa.send({
			to: "+447788223344",
			template: "HXb5b62575e6e4ff6129ad7c8efe1f983e",
			variables: { 1: "Ada" },
		})

		const body = new URLSearchParams(fetch.mock.calls[0][1].body as string)
		expect(body.get("ContentSid")).toBe("HXb5b62575e6e4ff6129ad7c8efe1f983e")
		expect(JSON.parse(body.get("ContentVariables") ?? "")).toEqual({ 1: "Ada" })
		expect(body.get("Body")).toBeNull()
	})

	it("normalises error 63016 to outside_window", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				respond({
					ok: false,
					status: 400,
					body: { code: 63016, message: "outside the allowed window", status: 400 },
				})
			)
		)
		const wa = new TwilioWhatsapp({ ...CREDS, default: { from: "+14155238886" } })
		const error = await wa.send({ to: "+447788223344", message: "hi" }).catch((e) => e)
		expect(WhatsappProvider.is_outside_window(error)).toBe(true)
	})

	it("needs a sender unless a messaging service supplies one", async () => {
		vi.stubGlobal("fetch", vi.fn())
		await expect(
			new TwilioWhatsapp(CREDS).send({ to: "+447788223344", message: "hi" })
		).rejects.toMatchObject({ code: "no_sender" })

		const fetch = vi.fn().mockResolvedValue(respond({ body: { sid: "SM1" } }))
		vi.stubGlobal("fetch", fetch)
		await new TwilioWhatsapp({ ...CREDS, messaging_service_sid: "MG1" }).send({
			to: "+447788223344",
			message: "hi",
		})
		const body = new URLSearchParams(fetch.mock.calls[0][1].body as string)
		expect(body.get("MessagingServiceSid")).toBe("MG1")
		expect(body.get("From")).toBeNull()
	})
})

describe("meta cloud api", () => {
	const CREDS = { access_token: "tok", phone_number_id: "123456" }

	it("posts text to the phone number id with a Bearer token", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { messages: [{ id: "wamid.A" }] } }))
		vi.stubGlobal("fetch", fetch)
		const wa = new Meta(CREDS)
		const result = (await wa.send({ to: "+447788223344", message: "hi" })) as { id: string }

		const [url, init] = fetch.mock.calls[0]
		expect(url).toContain("/123456/messages")
		expect(init.headers.Authorization).toBe("Bearer tok")
		const payload = JSON.parse(init.body as string)
		expect(payload).toMatchObject({
			messaging_product: "whatsapp",
			to: "+447788223344",
			type: "text",
			text: { body: "hi" },
		})
		expect(result.id).toBe("wamid.A")
	})

	it("sends named template variables with parameter_name", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { messages: [{ id: "wamid.A" }] } }))
		vi.stubGlobal("fetch", fetch)
		await new Meta(CREDS).send({
			to: "+447788223344",
			template: "order_shipped",
			language: "en_GB",
			variables: { name: "Ada", tracking: "AB123" },
		})

		const payload = JSON.parse(fetch.mock.calls[0][1].body as string)
		expect(payload.type).toBe("template")
		expect(payload.template.name).toBe("order_shipped")
		expect(payload.template.language).toEqual({ code: "en_GB" })
		expect(payload.template.components).toEqual([
			{
				type: "body",
				parameters: [
					{ type: "text", parameter_name: "name", text: "Ada" },
					{ type: "text", parameter_name: "tracking", text: "AB123" },
				],
			},
		])
	})

	it("sends numeric keys positionally, in order, without parameter_name", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { messages: [{ id: "wamid.A" }] } }))
		vi.stubGlobal("fetch", fetch)
		await new Meta(CREDS).send({
			to: "+447788223344",
			template: "order_shipped",
			variables: { 2: "AB123", 1: "Ada" },
		})

		const payload = JSON.parse(fetch.mock.calls[0][1].body as string)
		expect(payload.template.components[0].parameters).toEqual([
			{ type: "text", text: "Ada" },
			{ type: "text", text: "AB123" },
		])
	})

	it("normalises error 131047 to outside_window", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				respond({
					ok: false,
					status: 400,
					body: { error: { message: "Re-engagement message", code: 131047 } },
				})
			)
		)
		const error = await new Meta(CREDS).send({ to: "+447788223344", message: "hi" }).catch((e) => e)
		expect(WhatsappProvider.is_outside_window(error)).toBe(true)
	})
})

describe("zero-config whatsapp()", () => {
	it("resolves meta from config and environment", async () => {
		process.env.WHATSAPP_ACCESS_TOKEN = "tok"
		process.env.WHATSAPP_PHONE_NUMBER_ID = "123456"
		configure({ whatsapp: { provider: "meta" } })
		const fetch = vi.fn().mockResolvedValue(respond({ body: { messages: [{ id: "wamid.A" }] } }))
		vi.stubGlobal("fetch", fetch)

		await whatsapp({ to: "+447788223344", message: "hi" })
		expect(fetch.mock.calls[0][0]).toContain("/123456/messages")
	})

	it("throws outside development when nothing is configured", async () => {
		await expect(whatsapp({ to: "+447788223344", message: "hi" })).rejects.toMatchObject({
			code: "no_whatsapp_provider",
		})
	})

	it("reports a missing credential by env var name", async () => {
		configure({ whatsapp: { provider: "meta" } })
		await expect(whatsapp({ to: "+447788223344", message: "hi" })).rejects.toThrow(
			/WHATSAPP_ACCESS_TOKEN/
		)
	})

	it("intercepts in development even when a real provider is configured", async () => {
		process.env.NODE_ENV = "development"
		process.env.WHATSAPP_ACCESS_TOKEN = "tok"
		process.env.WHATSAPP_PHONE_NUMBER_ID = "123456"
		configure({ whatsapp: { provider: "meta" } })
		const fetch = vi.fn()
		vi.stubGlobal("fetch", fetch)
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		await whatsapp({ to: "+447788223344", message: "hi" })
		expect(fetch).not.toHaveBeenCalled()
		log.mockRestore()
		warn.mockRestore()
	})

	it("reads POSTBOI_WHATSAPP_* defaults from the environment", async () => {
		process.env.NODE_ENV = "development"
		process.env.POSTBOI_WHATSAPP_LANGUAGE = "en_GB"
		process.env.POSTBOI_WHATSAPP_COUNTRY = "GB"
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const result = (await whatsapp({ to: "07788 223344", template: "order_shipped" })) as {
			message: { to: string; language: string }
		}
		expect(result.message.to).toBe("+447788223344")
		expect(result.message.language).toBe("en_GB")
		log.mockRestore()
		warn.mockRestore()
	})
})

describe("send() with whatsapp", () => {
	it("orders whatsapp before sms in the cheapest chain, and advances on failure", async () => {
		// WhatsApp deliberately unconfigured (production mode → it throws), SMS on the mock:
		// the chain should record the whatsapp failure and deliver on sms.
		process.env.POSTBOI_SMS_PROVIDER = "mock"
		process.env.POSTBOI_SMS_DEV = "send"
		const log = vi.spyOn(console, "log").mockImplementation(() => {})

		const result = await send({
			to: { whatsapp: "+447788223344", sms: "+447788223344" },
			channels: "cheapest",
			message: "Your code is 4291",
		})

		expect(result.results.map((r) => r.channel)).toEqual(["whatsapp", "sms"])
		expect(result.results[0]).toMatchObject({ ok: false })
		expect(result.delivered).toBe("sms")
		log.mockRestore()
		delete process.env.POSTBOI_SMS_DEV
	})

	it("keeps the shared message off whatsapp when a template override is given", async () => {
		process.env.NODE_ENV = "development"
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const result = await send({
			to: { whatsapp: "+447788223344" },
			message: "Your order shipped",
			whatsapp: { template: "order_shipped", variables: { name: "Ada" } },
		})

		expect(result.ok).toBe(true)
		const attempt = result.results[0] as { response: { message: Record<string, unknown> } }
		expect(attempt.response.message.template).toBe("order_shipped")
		expect(attempt.response.message.message).toBeUndefined()
		log.mockRestore()
		warn.mockRestore()
	})
})
