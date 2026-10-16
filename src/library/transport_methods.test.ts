import { describe, it, expect, vi, afterEach } from "vitest"
import { Transport, type RequestSpec } from "./transport.js"
import type { PostboiError } from "./errors.js"

/** A provider with one read and one write, to ask what each failure could mean. */
class Reader extends Transport<unknown, unknown> {
	protected readonly provider = "reader"
	protected readonly channel = "email" as const
	protected build_request(): RequestSpec {
		return { url: "https://example.invalid/send", headers: {} }
	}
	protected parse_response(_response: Response, data: unknown) {
		return data
	}
	read() {
		return this.call({ url: "https://example.invalid/item", method: "GET", headers: {} }, "read")
	}
	write() {
		return this.call({ url: "https://example.invalid/item", method: "POST", headers: {} }, "write")
	}
}

const answer = (status: number) => ({
	ok: status < 300,
	status,
	headers: new Headers(),
	text: async () => "",
})

afterEach(() => vi.unstubAllGlobals())

describe("what a failed request could have done", () => {
	it("a 5xx on a GET is a failed read, not an unknown send", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(503)))
		const error = (await new Reader().read().catch((e) => e)) as PostboiError
		expect(error.status).toBe(503)
		expect(error.outcome_unknown).toBe(false)
	})

	it("a dropped connection on a GET changed nothing either", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")))
		const error = (await new Reader().read().catch((e) => e)) as PostboiError
		expect(error.outcome_unknown).toBe(false)
	})

	it("the same failures on a POST may have sent something", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(503)))
		expect(((await new Reader().write().catch((e) => e)) as PostboiError).outcome_unknown).toBe(
			true
		)
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")))
		expect(((await new Reader().write().catch((e) => e)) as PostboiError).outcome_unknown).toBe(
			true
		)
	})
})
