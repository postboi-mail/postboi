import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Postboi, { PostboiError } from "$library/cloud.js"

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

const sent_url = () => fetch.mock.calls.at(-1)![0] as string
const sent_init = () =>
	fetch.mock.calls.at(-1)![1] as RequestInit & { headers: Record<string, string> }
const sent_json = () => JSON.parse(sent_init().body as string)

beforeEach(() => fetch.mockReset())
afterEach(() => vi.unstubAllEnvs())

describe("Postboi Cloud (zero-config)", () => {
	it("auto-reads POSTBOI_TOKEN from the environment", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "pb_live_123")
		fetch.mockResolvedValue(respond({ json: { id: "abc" } }))

		const mail = new Postboi({ default_from: "from@test.com" })
		const result = await mail.send({ to: "to@test.com", subject: "Hi", body: "<p>x</p>" })

		expect(sent_url()).toBe("https://api.postboi.dev/v1/send")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer pb_live_123" })
		const body = sent_json()
		expect(body.from).toEqual({ email: "from@test.com" })
		expect(body.to).toEqual([{ email: "to@test.com" }])
		expect(body.html).toBe("<p>x</p>")
		expect(result).toEqual({ id: "abc" })
	})

	it("an explicit token overrides the environment", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "from_env")
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))

		const mail = new Postboi({ token: "explicit", default_from: "from@test.com" })
		await mail.send({ to: "to@test.com", body: "x" })

		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer explicit" })
	})

	it("throws a friendly PostboiError when no token is available", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "")
		const mail = new Postboi({ default_from: "from@test.com" })

		const error = await mail.send({ to: "to@test.com", body: "x" }).catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.code).toBe("no_token")
		expect(error.message).toMatch(/postboi init/)
		expect(fetch).not.toHaveBeenCalled()
	})

	it("honours a custom base_url and POSTBOI_API_URL", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))
		await new Postboi({
			token: "t",
			base_url: "https://staging.postboi.dev/",
			default_from: "f@test.com",
		}).send({
			to: "to@test.com",
			body: "x",
		})
		expect(sent_url()).toBe("https://staging.postboi.dev/v1/send")

		vi.stubEnv("POSTBOI_API_URL", "http://localhost:8787")
		await new Postboi({ token: "t", default_from: "f@test.com" }).send({
			to: "to@test.com",
			body: "x",
		})
		expect(sent_url()).toBe("http://localhost:8787/v1/send")
	})

	it("forwards headers, tags and attachments", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))
		await new Postboi({ token: "t", default_from: "f@test.com" }).send({
			to: "to@test.com",
			body: "x",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome"],
			attachments: new File(["data"], "doc.pdf", { type: "application/pdf" }),
		})
		const body = sent_json()
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.tags).toEqual(["welcome"])
		expect(body.attachments).toEqual([
			{
				content: Buffer.from("data").toString("base64"),
				filename: "doc.pdf",
				type: "application/pdf",
			},
		])
	})

	it("normalizes API errors to PostboiError", async () => {
		fetch.mockResolvedValue(
			respond({ ok: false, status: 401, json: { message: "bad token", code: "unauthorized" } })
		)
		const mail = new Postboi({ token: "t", default_from: "f@test.com" })
		const error = await mail.send({ to: "to@test.com", body: "x" }).catch((e) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect(error.provider).toBe("postboi")
		expect(error.message).toBe("bad token")
		expect(error.code).toBe("unauthorized")
	})
})
