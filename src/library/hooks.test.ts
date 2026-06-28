import { describe, it, expect, vi, beforeEach } from "vitest"
import Mock from "$library/mock.js"
import Resend from "$library/resend.js"
import { PostboiError, SkipSendError, type Hooks } from "$library/index.js"

const fetch = vi.fn()
global.fetch = fetch

function respond(opts: { ok?: boolean; status?: number; json?: unknown } = {}) {
	const body = opts.json !== undefined ? JSON.stringify(opts.json) : ""
	return {
		ok: opts.ok ?? true,
		status: opts.status ?? 200,
		headers: new Headers(),
		text: async () => body,
		json: async () => opts.json,
	}
}

beforeEach(() => fetch.mockReset())

describe("before_send", () => {
	it("observes the normalized message", async () => {
		const seen: Array<unknown> = []
		const mail = new Mock({
			default: { from: "f@test.com" },
			hooks: {
				before_send: (ctx) => void seen.push({ provider: ctx.provider, to: ctx.message.to }),
			},
		})
		await mail.send({ to: "a@test.com", body: "<p>hi</p>" })
		expect(seen).toEqual([{ provider: "mock", to: "a@test.com" }])
	})

	it("can replace the message (staging redirect)", async () => {
		const mail = new Mock({
			default: { from: "f@test.com" },
			hooks: { before_send: ({ message }) => ({ ...message, to: "redirect@test.com" }) },
		})
		await mail.send({ to: "real@test.com", body: "hi" })
		expect(mail.last?.to).toEqual([{ address: "redirect@test.com" }])
	})

	it("throwing SkipSendError cancels the send without on_error", async () => {
		let on_error_called = false
		const mail = new Mock({
			default: { from: "f@test.com" },
			hooks: {
				before_send: () => {
					throw new SkipSendError()
				},
				on_error: () => void (on_error_called = true),
			},
		})

		const error = await mail.send({ to: "a@test.com", body: "hi" }).catch((e) => e)
		expect(error).toBeInstanceOf(SkipSendError)
		expect(mail.is_error(error)).toBe(true)
		expect(error.code).toBe("skipped")
		expect(mail.sent).toHaveLength(0)
		expect(on_error_called).toBe(false)
	})
})

describe("after_send", () => {
	it("fires on success with the response and a duration", async () => {
		const calls: Array<{ provider: string; duration_ms: number; id: string }> = []
		const mail = new Mock({
			default: { from: "f@test.com" },
			hooks: {
				after_send: ({ provider, response, duration_ms }) =>
					void calls.push({ provider, duration_ms, id: (response as { id: string }).id }),
			},
		})
		await mail.send({ to: "a@test.com", body: "hi" })
		expect(calls).toHaveLength(1)
		expect(calls[0].provider).toBe("mock")
		expect(calls[0].id).toBe("mock-1")
		expect(typeof calls[0].duration_ms).toBe("number")
	})
})

describe("on_error", () => {
	it("fires on a provider failure with a PostboiError", async () => {
		const errors: Array<PostboiError> = []
		const mail = new Resend({
			api_key: "k",
			default: { from: "f@test.com" },
			hooks: { on_error: ({ error }) => void errors.push(error) },
		})
		fetch.mockResolvedValue(
			respond({ ok: false, status: 401, json: { message: "nope", name: "x" } })
		)

		await mail.send({ to: "a@test.com", body: "hi" }).catch(() => {})
		expect(errors).toHaveLength(1)
		expect(errors[0]).toBeInstanceOf(PostboiError)
		expect(errors[0].status).toBe(401)
		expect(errors[0].provider).toBe("resend")
	})

	it("fires on a validation error (no message available)", async () => {
		const seen: Array<{ message: unknown; error: string }> = []
		const mail = new Mock({
			hooks: {
				on_error: ({ message, error }) => void seen.push({ message, error: error.message }),
			},
		})
		await mail.send({ to: "a@test.com", body: "hi" }).catch(() => {})
		expect(seen).toHaveLength(1)
		expect(seen[0].message).toBeUndefined()
		expect(seen[0].error).toMatch(/sender/)
	})
})

describe("hook error isolation", () => {
	it("swallows a throwing after_send (send still succeeds)", async () => {
		const mail = new Mock({
			default: { from: "f@test.com" },
			hooks: {
				after_send: () => {
					throw new Error("telemetry down")
				},
			},
		})
		const result = await mail.send({ to: "a@test.com", body: "hi" })
		expect(result.id).toBe("mock-1")
	})

	it("swallows a throwing on_error (original error still propagates)", async () => {
		const mail = new Mock({
			fail: true,
			default: { from: "f@test.com" },
			hooks: {
				on_error: () => {
					throw new Error("sentry down")
				},
			},
		})
		const error = await mail.send({ to: "a@test.com", body: "hi" }).catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.message).toMatch(/Simulated failure/)
	})
})

describe("on_retry", () => {
	it("fires before each retry attempt", async () => {
		const retries: Array<{ provider: string; attempt: number; status?: number; delay_ms: number }> =
			[]
		const hooks: Hooks = { on_retry: (ctx) => void retries.push(ctx) }
		const mail = new Resend({
			api_key: "k",
			default: { from: "f@test.com" },
			retries: 1,
			retry_delay: 0,
			hooks,
		})
		fetch
			.mockResolvedValueOnce(respond({ ok: false, status: 503 }))
			.mockResolvedValueOnce(respond({ json: { id: "ok" } }))

		const result = await mail.send({ to: "a@test.com", body: "hi" })
		expect(result).toEqual({ id: "ok" })
		expect(retries).toEqual([{ provider: "resend", attempt: 1, status: 503, delay_ms: 0 }])
	})
})

describe("hooks under bulk send", () => {
	it("runs per message; a skip becomes a failed BatchResult", async () => {
		const mail = new Mock({
			default: { from: "f@test.com" },
			hooks: {
				before_send: ({ message }) => {
					if (message.to === "blocked@test.com") throw new SkipSendError()
				},
			},
		})

		const results = await mail.send([
			{ to: "ok@test.com", body: "hi" },
			{ to: "blocked@test.com", body: "hi" },
		])

		expect(results[0].ok).toBe(true)
		expect(results[1].ok).toBe(false)
		if (!results[1].ok) expect(results[1].error).toBeInstanceOf(SkipSendError)
		expect(mail.sent).toHaveLength(1)
	})
})
