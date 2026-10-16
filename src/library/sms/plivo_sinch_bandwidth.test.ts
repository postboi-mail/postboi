import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { reset_config } from "../config.js"
import type { PostboiError } from "../errors.js"
import Plivo from "./plivo.js"
import Sinch from "./sinch.js"
import Bandwidth from "./bandwidth.js"
import { sms } from "./send.js"

const respond = (status: number, json: unknown) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: new Headers(),
	text: async () => JSON.stringify(json),
})

function stub(status: number, json: unknown) {
	const fetch = vi.fn().mockResolvedValue(respond(status, json))
	vi.stubGlobal("fetch", fetch)
	return fetch
}

const sent = (fetch: ReturnType<typeof vi.fn>) => {
	const [url, init] = fetch.mock.calls[0]
	return { url: url as string, headers: init.headers, body: JSON.parse(init.body as string) }
}

const refused = async (p: { send(o: object): Promise<unknown> }, o: object) =>
	((await p.send({ to: "+15557770006", message: "hi", ...o }).catch((e) => e)) as PostboiError).code

const image = "https://example.com/a.png"

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.NODE_ENV
})
afterEach(() => {
	for (const key of [
		"POSTBOI_SMS_PROVIDER",
		"PLIVO_AUTH_ID",
		"PLIVO_AUTH_TOKEN",
		"PLIVO_POWERPACK_UUID",
		"SINCH_SERVICE_PLAN_ID",
		"SINCH_API_TOKEN",
		"SINCH_REGION",
		"SINCH_CALLBACK_URL",
		"BANDWIDTH_ACCOUNT_ID",
		"BANDWIDTH_USERNAME",
		"BANDWIDTH_PASSWORD",
		"BANDWIDTH_MESSAGING_APPLICATION_ID",
	])
		delete process.env[key]
})

describe("plivo", () => {
	const plivo = (options = {}) =>
		new Plivo({ auth_id: "MA1", auth_token: "tok", default: { from: "+15550001111" }, ...options })

	it("posts JSON with Basic auth, several recipients joined with <", async () => {
		const fetch = stub(202, { message_uuid: ["u1", "u2"], api_id: "a" })
		const result = await plivo().send({
			to: ["+447700900001", "+447700900002"],
			message: "Your code is 4291",
		})
		expect(result).toEqual({
			id: "u1",
			ids: ["u1", "u2"],
			provider: "plivo",
			delivery: "queued",
			message_uuid: ["u1", "u2"],
			api_id: "a",
		})
		const { url, headers, body } = sent(fetch)
		expect(url).toBe("https://api.plivo.com/v1/Account/MA1/Message/")
		expect(headers.Authorization).toBe(`Basic ${btoa("MA1:tok")}`)
		expect(body).toEqual({
			src: "+15550001111",
			dst: "447700900001<447700900002",
			text: "Your code is 4291",
		})
	})

	it("sends MMS and an expiry", async () => {
		const fetch = stub(202, { message_uuid: ["u"] })
		await plivo().send({ to: "+15557770006", message: "hi", media: [image], validity: 600 })
		expect(sent(fetch).body).toMatchObject({
			type: "mms",
			media_urls: [image],
			message_expiry: 600,
		})
	})

	it("lets a Powerpack choose the sender", async () => {
		const fetch = stub(202, { message_uuid: ["u"] })
		await new Plivo({ auth_id: "MA1", auth_token: "t", powerpack_uuid: "pp-1" }).send({
			to: "+15557770006",
			message: "hi",
		})
		const { body } = sent(fetch)
		expect(body.powerpack_uuid).toBe("pp-1")
		expect(body.src).toBeUndefined()
	})

	it("reads the error text and a reason from the status", async () => {
		stub(401, { api_id: "a", error: "authentication failed" })
		const error = (await plivo()
			.send({ to: "+15557770006", message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error).toMatchObject({ message: "authentication failed", reason: "auth" })
	})

	it("says so when it took only some of the numbers", async () => {
		stub(202, { message_uuid: ["u1"], invalid_number: ["4477"], api_id: "a" })
		const error = (await plivo()
			.send({ to: ["+447700900001", "+447700900002"], message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error).toMatchObject({ code: "invalid_number", outcome_unknown: true })
		expect(error.reason).toBeUndefined()
	})

	it("refuses what it can't carry", async () => {
		vi.stubGlobal("fetch", vi.fn())
		expect(await refused(plivo(), { scheduled_at: new Date(Date.now() + 60_000) })).toBe(
			"scheduling_not_supported"
		)
		expect(await refused(plivo(), { validity: 1 })).toBe("invalid_validity")
		expect(await refused(plivo(), { media: Array(11).fill(image) })).toBe("too_much_media")
		expect(await refused(plivo(), { provider_options: { dst: "x" } })).toBe(
			"reserved_provider_option"
		)
	})

	it("is reachable from sms() with its pair", async () => {
		process.env.POSTBOI_SMS_PROVIDER = "plivo"
		process.env.PLIVO_AUTH_ID = "MAENV"
		process.env.PLIVO_AUTH_TOKEN = "envtok"
		process.env.PLIVO_POWERPACK_UUID = ""
		const fetch = stub(202, { message_uuid: ["u"] })
		await sms({ to: "+15557770006", from: "+15550001111", message: "hi" })
		expect(sent(fetch).url).toContain("/Account/MAENV/")
	})
})

describe("sinch", () => {
	const sinch = (options = {}) =>
		new Sinch({ service_plan_id: "plan", api_token: "tok", default: { from: "ACME" }, ...options })

	it("posts a batch with a Bearer token and reads its id", async () => {
		const fetch = stub(201, { id: "batch-1" })
		const result = await sinch({ region: "eu" }).send({
			to: ["+447700900001", "+447700900002"],
			message: "Your code is 4291",
			tags: ["otp"],
		})
		expect(result).toEqual({
			id: "batch-1",
			ids: ["batch-1"],
			provider: "sinch",
			delivery: "queued",
		})
		const { url, headers, body } = sent(fetch)
		expect(url).toBe("https://eu.sms.api.sinch.com/xms/v1/plan/batches")
		expect(headers.Authorization).toBe("Bearer tok")
		expect(body).toEqual({
			from: "ACME",
			to: ["+447700900001", "+447700900002"],
			body: "Your code is 4291",
			client_reference: "otp",
		})
	})

	it("schedules, and measures validity from the scheduled time", async () => {
		const fetch = stub(201, { id: "b" })
		const when = new Date("2030-01-01T09:00:00Z")
		await sinch({ callback_url: "https://example.com/dlr" }).send({
			to: "+447700900001",
			message: "hi",
			scheduled_at: when,
			validity: 3600,
		})
		const { url, body } = sent(fetch)
		expect(url.startsWith("https://us.")).toBe(true)
		expect(body).toMatchObject({
			send_at: "2030-01-01T09:00:00.000Z",
			expire_at: "2030-01-01T10:00:00.000Z",
			callback_url: "https://example.com/dlr",
			delivery_report: "per_recipient",
		})
	})

	it("reads { code, text } errors", async () => {
		stub(400, { code: "syntax_invalid_parameter_format", text: "Bad number" })
		const error = (await sinch()
			.send({ to: "+447700900001", message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error).toMatchObject({
			message: "Bad number",
			code: "syntax_invalid_parameter_format",
			reason: "request",
		})
	})

	it("refuses what it can't carry", async () => {
		vi.stubGlobal("fetch", vi.fn())
		expect(await refused(sinch(), { media: [image] })).toBe("media_not_supported")
		expect(await refused(sinch(), { validity: 3 * 24 * 60 * 60 + 1 })).toBe("invalid_validity")
	})

	it("is reachable from sms() with its plan and token", async () => {
		process.env.POSTBOI_SMS_PROVIDER = "sinch"
		process.env.SINCH_SERVICE_PLAN_ID = "envplan"
		process.env.SINCH_API_TOKEN = "envtok"
		process.env.SINCH_REGION = ""
		process.env.SINCH_CALLBACK_URL = ""
		const fetch = stub(201, { id: "b" })
		await sms({ to: "+447700900001", from: "ACME", message: "hi" })
		const { url, headers } = sent(fetch)
		expect(url).toBe("https://us.sms.api.sinch.com/xms/v1/envplan/batches")
		expect(headers.Authorization).toBe("Bearer envtok")
	})
})

describe("bandwidth", () => {
	const bandwidth = (options = {}) =>
		new Bandwidth({
			account_id: "9900",
			username: "user",
			password: "pass",
			application_id: "app-1",
			default: { from: "+15550001111" },
			...options,
		})

	it("posts one recipient with Basic auth and reads the id", async () => {
		const fetch = stub(202, { id: "m-1", segmentCount: 1 })
		const result = await bandwidth().send({
			to: "+15557770006",
			message: "Your code is 4291",
			media: [image],
			tags: ["otp"],
		})
		expect(result).toEqual({
			id: "m-1",
			ids: ["m-1"],
			provider: "bandwidth",
			delivery: "queued",
			segment_count: 1,
		})
		const { url, headers, body } = sent(fetch)
		expect(url).toBe("https://messaging.bandwidth.com/api/v2/users/9900/messages")
		expect(headers.Authorization).toBe(`Basic ${btoa("user:pass")}`)
		expect(body).toEqual({
			applicationId: "app-1",
			to: ["+15557770006"],
			from: "+15550001111",
			text: "Your code is 4291",
			media: [image],
			tag: "otp",
		})
	})

	it("reads { type, description } errors", async () => {
		stub(429, { type: "rate-limit", description: "Too many requests" })
		const error = (await bandwidth()
			.send({ to: "+15557770006", message: "hi" })
			.catch((e) => e)) as PostboiError
		expect(error).toMatchObject({
			message: "Too many requests",
			code: "rate-limit",
			reason: "rate_limited",
		})
	})

	it("refuses a group, a validity and a schedule", async () => {
		vi.stubGlobal("fetch", vi.fn())
		expect(await refused(bandwidth(), { to: ["+15557770006", "+15557770007"] })).toBe(
			"single_recipient_only"
		)
		expect(await refused(bandwidth(), { validity: 60 })).toBe("validity_not_supported")
		expect(await refused(bandwidth(), { scheduled_at: new Date(Date.now() + 60_000) })).toBe(
			"scheduling_not_supported"
		)
	})

	it("passes an expiration through provider_options", async () => {
		const fetch = stub(202, { id: "m" })
		await bandwidth().send({
			to: "+15557770006",
			message: "hi",
			provider_options: { expiration: "2030-01-01T00:00:00Z" },
		})
		expect(sent(fetch).body.expiration).toBe("2030-01-01T00:00:00Z")
	})

	it("is reachable from sms() with its four fields", async () => {
		process.env.POSTBOI_SMS_PROVIDER = "bandwidth"
		process.env.BANDWIDTH_ACCOUNT_ID = "1234"
		process.env.BANDWIDTH_USERNAME = "u"
		process.env.BANDWIDTH_PASSWORD = "p"
		process.env.BANDWIDTH_MESSAGING_APPLICATION_ID = "app"
		const fetch = stub(202, { id: "m" })
		await sms({ to: "+15557770006", from: "+15550001111", message: "hi" })
		expect(sent(fetch).body.applicationId).toBe("app")
	})
})
