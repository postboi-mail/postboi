import { describe, it, expect, vi, beforeEach } from "vitest"
import { configure, reset_config } from "../config.js"
import {
	IdempotencyConflictError,
	memory_idempotency_store,
	type IdempotencyStore,
} from "../idempotency.js"
import { PostboiError } from "../errors.js"
import MockSms from "./mock.js"
import Twilio from "./twilio.js"
import { sms } from "./send.js"

const to = "+447700900123"

const answer = (status: number, json: unknown) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: new Headers(),
	text: async () => JSON.stringify(json),
})

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.POSTBOI_SMS_PROVIDER
	delete process.env.TWILIO_ACCOUNT_SID
	delete process.env.TWILIO_AUTH_TOKEN
})

const twilio = (idempotency: IdempotencyStore) =>
	new Twilio({
		account_sid: "AC1",
		auth_token: "t",
		default: { from: "+15550001111" },
		idempotency,
	})

describe("an idempotency store", () => {
	it("sends a key once, and answers a repeat with the first result", async () => {
		const fetch = vi.fn().mockResolvedValue(answer(201, { sid: "SM1", status: "queued" }))
		vi.stubGlobal("fetch", fetch)
		const text = twilio(memory_idempotency_store())
		const first = await text.send({ to, message: "hi", idempotency_key: "order:1" })
		const again = await text.send({ to, message: "hi", idempotency_key: "order:1" })
		expect(again).toEqual(first)
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("refuses the same key for a different message, and sends nothing", async () => {
		const fetch = vi.fn().mockResolvedValue(answer(201, { sid: "SM1", status: "queued" }))
		vi.stubGlobal("fetch", fetch)
		const text = twilio(memory_idempotency_store())
		await text.send({ to, message: "hi", idempotency_key: "k" })
		const error = await text.send({ to, message: "bye", idempotency_key: "k" }).catch((e) => e)
		expect(error).toBeInstanceOf(IdempotencyConflictError)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.code).toBe("idempotency_conflict")
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("frees a key after a proven refusal, so it can go again", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(answer(400, { code: 21606, message: "From is not SMS-capable" }))
			.mockResolvedValueOnce(answer(201, { sid: "SM2", status: "queued" }))
		vi.stubGlobal("fetch", fetch)
		const text = twilio(memory_idempotency_store())
		await expect(text.send({ to, message: "hi", idempotency_key: "k" })).rejects.toMatchObject({
			outcome_unknown: false,
		})
		await expect(text.send({ to, message: "hi", idempotency_key: "k" })).resolves.toMatchObject({
			id: "SM2",
		})
	})

	it("holds a key whose outcome is unknown, rather than risk a second copy", async () => {
		const fetch = vi.fn().mockResolvedValue(answer(502, "Bad Gateway"))
		vi.stubGlobal("fetch", fetch)
		const text = twilio(memory_idempotency_store())
		await expect(text.send({ to, message: "hi", idempotency_key: "k" })).rejects.toMatchObject({
			outcome_unknown: true,
		})
		const repeat = await text.send({ to, message: "hi", idempotency_key: "k" }).catch((e) => e)
		expect(repeat).toMatchObject({ code: "idempotency_unknown", outcome_unknown: true })
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("refuses a repeat while the first is still in flight", async () => {
		let finish: (value: unknown) => void = () => {}
		const fetch = vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)))
		vi.stubGlobal("fetch", fetch)
		const text = twilio(memory_idempotency_store())
		const first = text.send({ to, message: "hi", idempotency_key: "k" })
		// Only once the first is on the wire has it certainly reserved the key.
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
		const second = await text.send({ to, message: "hi", idempotency_key: "k" }).catch((e) => e)
		expect(second).toMatchObject({ code: "idempotency_in_progress", outcome_unknown: true })
		finish(answer(201, { sid: "SM1", status: "queued" }))
		await expect(first).resolves.toMatchObject({ id: "SM1" })
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("does nothing without a key, and forgets a key after its ttl", async () => {
		const store = memory_idempotency_store({ ttl_ms: 1 })
		const text = new MockSms({ idempotency: store })
		await text.send({ to, message: "hi" })
		await text.send({ to, message: "hi" })
		await text.send({ to, message: "hi", idempotency_key: "k" })
		await new Promise((resolve) => setTimeout(resolve, 5))
		await text.send({ to, message: "hi", idempotency_key: "k" })
		expect(text.sent).toHaveLength(4)
	})

	it("identifies the message by a hash, not by its text", async () => {
		const prints: Array<string> = []
		const store = memory_idempotency_store()
		const spying: IdempotencyStore = {
			reserve: (key, print) => (prints.push(print), store.reserve(key, print)),
			settle: (key, record) => store.settle(key, record),
			release: (key) => store.release(key),
		}
		await new MockSms({ idempotency: spying }).send({
			to,
			message: "code 4291",
			idempotency_key: "k",
		})
		expect(prints).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)])
	})

	it("is set for every SMS provider by sms.idempotency in the config", async () => {
		configure({ sms: { provider: "mock", idempotency: memory_idempotency_store() } })
		const first = await sms({ to, message: "hi", idempotency_key: "k" })
		const again = await sms({ to, message: "hi", idempotency_key: "k" })
		expect(again.id).toBe(first.id)
	})
})
