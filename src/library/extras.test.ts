import { describe, it, expect, vi, beforeEach } from "vitest"

import { PostboiError } from "$library/index.js"
import Resend from "$library/resend.js"
import Postmark from "$library/postmark.js"
import SendGrid from "$library/sendgrid.js"
import Mailgun from "$library/mailgun.js"
import SparkPost from "$library/sparkpost.js"
import Mandrill from "$library/mandrill.js"
import Mailtrap from "$library/mailtrap.js"
import Scaleway from "$library/scaleway.js"
import MailPace from "$library/mailpace.js"

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

const sent_json = () => JSON.parse((fetch.mock.calls.at(-1)![1] as RequestInit).body as string)
const sent_form = () => (fetch.mock.calls.at(-1)![1] as RequestInit).body as FormData

beforeEach(() => {
	fetch.mockReset()
	fetch.mockResolvedValue(respond({ json: { id: "ok", MessageID: "ok", messageId: "ok" } }))
})

const base = { headers: { "X-Campaign": "spring" }, tags: ["welcome", "vip"] }

describe("custom headers + tags", () => {
	it("Resend: headers object and {name,value} tags", async () => {
		await new Resend({ api_key: "k", default: { from: "f@test.com" } }).send({
			to: "a@test.com",
			body: "x",
			...base,
		})
		const body = sent_json()
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.tags).toEqual([
			{ name: "welcome", value: "welcome" },
			{ name: "vip", value: "vip" },
		])
	})

	it("Postmark: Headers array and a single Tag", async () => {
		await new Postmark({ api_key: "k", default: { from: "f@test.com" } }).send({
			to: "a@test.com",
			body: "x",
			...base,
		})
		const body = sent_json()
		expect(body.Headers).toEqual([{ Name: "X-Campaign", Value: "spring" }])
		expect(body.Tag).toBe("welcome")
	})

	it("SendGrid: headers and categories", async () => {
		await new SendGrid({ api_key: "k", default: { from: "f@test.com" } }).send({
			to: "a@test.com",
			body: "x",
			...base,
		})
		const body = sent_json()
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.categories).toEqual(["welcome", "vip"])
	})

	it("Mailgun: h: headers and repeated o:tag", async () => {
		await new Mailgun({ api_key: "k", domain: "d.com", default: { from: "f@test.com" } }).send({
			to: "a@test.com",
			body: "x",
			...base,
		})
		const form = sent_form()
		expect(form.get("h:X-Campaign")).toBe("spring")
		expect(form.getAll("o:tag")).toEqual(["welcome", "vip"])
	})

	it("SparkPost: merges custom headers with the CC header", async () => {
		await new SparkPost({ api_key: "k", default: { from: "f@test.com" } }).send({
			to: "a@test.com",
			cc: "c@test.com",
			body: "x",
			headers: { "X-Campaign": "spring" },
		})
		expect(sent_json().content.headers).toEqual({ CC: "c@test.com", "X-Campaign": "spring" })
	})

	it("Mandrill: merges custom headers with Reply-To and sets tags", async () => {
		await new Mandrill({ api_key: "k", default: { from: "f@test.com" } }).send({
			to: "a@test.com",
			reply_to: "r@test.com",
			body: "x",
			...base,
		})
		const body = sent_json()
		expect(body.message.headers).toEqual({ "Reply-To": "r@test.com", "X-Campaign": "spring" })
		expect(body.message.tags).toEqual(["welcome", "vip"])
	})

	it("Scaleway: custom headers join reply-to in additional_headers", async () => {
		await new Scaleway({
			secret_key: "k",
			project_id: "p",
			region: "fr-par",
			default: { from: "f@test.com" },
		}).send({
			to: "a@test.com",
			reply_to: "r@test.com",
			body: "x",
			headers: { "X-Campaign": "spring" },
		})
		expect(sent_json().additional_headers).toEqual([
			{ key: "Reply-To", value: "r@test.com" },
			{ key: "X-Campaign", value: "spring" },
		])
	})

	it("Mailtrap: first tag becomes the category", async () => {
		await new Mailtrap({ api_key: "k", default: { from: "f@test.com" } }).send({
			to: "a@test.com",
			body: "x",
			...base,
		})
		expect(sent_json().category).toBe("welcome")
	})

	it("MailPace: tags array", async () => {
		await new MailPace({ api_key: "k", default: { from: "f@test.com" } }).send({
			to: "a@test.com",
			body: "x",
			...base,
		})
		expect(sent_json().tags).toEqual(["welcome", "vip"])
	})
})

describe("send(array) — bulk", () => {
	it("returns a result per message and never rejects", async () => {
		const mail = new Resend({ api_key: "k", default: { from: "f@test.com" } })
		fetch.mockReset()
		fetch
			.mockResolvedValueOnce(respond({ json: { id: "1" } }))
			.mockResolvedValueOnce(
				respond({ ok: false, status: 422, json: { message: "bad", name: "validation_error" } })
			)
			.mockResolvedValueOnce(respond({ json: { id: "3" } }))

		const results = await mail.send(
			[
				{ to: "a@test.com", body: "x" },
				{ to: "b@test.com", body: "x" },
				{ to: "c@test.com", body: "x" },
			],
			{ concurrency: 1 }
		)

		expect(results.map((r) => r.ok)).toEqual([true, false, true])
		expect(results[0]).toMatchObject({ ok: true, index: 0, response: { id: "1" } })
		expect(results[2]).toMatchObject({ ok: true, index: 2, response: { id: "3" } })
		const failed = results[1]
		expect(failed.ok).toBe(false)
		if (!failed.ok) {
			expect(failed.error).toBeInstanceOf(PostboiError)
			expect(failed.error.message).toBe("bad")
		}
	})

	it("captures validation errors without sending", async () => {
		fetch.mockReset()
		const mail = new Resend({ api_key: "k" })
		const results = await mail.send([{ to: "a@test.com", body: "x" }])
		expect(results[0].ok).toBe(false)
		if (!results[0].ok) expect(results[0].error.message).toMatch(/sender/)
		expect(fetch).not.toHaveBeenCalled()
	})

	it("bounds concurrency to the requested limit", async () => {
		let inflight = 0
		let peak = 0
		fetch.mockReset()
		fetch.mockImplementation(async () => {
			inflight++
			peak = Math.max(peak, inflight)
			await new Promise((r) => setTimeout(r, 5))
			inflight--
			return respond({ json: { id: "x" } })
		})
		const mail = new Resend({ api_key: "k", default: { from: "f@test.com" } })
		const messages = Array.from({ length: 6 }, (_, i) => ({ to: `u${i}@test.com`, body: "x" }))
		await mail.send(messages, { concurrency: 2 })
		expect(peak).toBeLessThanOrEqual(2)
	})

	it("a single send still returns the response directly", async () => {
		fetch.mockReset()
		fetch.mockResolvedValue(respond({ json: { id: "single" } }))
		const mail = new Resend({ api_key: "k", default: { from: "f@test.com" } })
		const result = await mail.send({ to: "a@test.com", body: "x" })
		expect(result).toEqual({ id: "single" })
	})
})
