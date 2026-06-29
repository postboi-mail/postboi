import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import Resend from "$library/resend.js"
import Postmark from "$library/postmark.js"
import MailerSend from "$library/mailersend.js"
import Mailgun from "$library/mailgun.js"
import SparkPost from "$library/sparkpost.js"
import Mandrill from "$library/mandrill.js"
import SendGrid from "$library/sendgrid.js"
import Brevo from "$library/brevo.js"
import Mock from "$library/mock.js"

const fetch = vi.fn()
global.fetch = fetch

function respond(
	opts: { ok?: boolean; status?: number; json?: unknown; headers?: Record<string, string> } = {}
) {
	const body = opts.json !== undefined ? JSON.stringify(opts.json) : ""
	return {
		ok: opts.ok ?? true,
		status: opts.status ?? 200,
		headers: new Headers(opts.headers ?? {}),
		text: async () => body,
		json: async () => opts.json,
	}
}

const sent_url = () => fetch.mock.calls.at(-1)![0] as string
const sent_init = () =>
	fetch.mock.calls.at(-1)![1] as RequestInit & { headers: Record<string, string> }
const sent_json = () => JSON.parse(sent_init().body as string)
const sent_form = () => sent_init().body as FormData

// A two-recipient personalized batch reused across providers.
const batch = {
	to: ["a@test.com", "b@test.com"],
	from: "from@test.com",
	subject: "Hi {name}",
	body: "<p>Hello {name}, ref {id}</p>",
	data: {
		"a@test.com": { name: "Ada", id: "1" },
		"b@test.com": { name: "Linus", id: "2" },
	},
} as const

beforeEach(() => fetch.mockReset())
afterEach(() => vi.clearAllMocks())

describe("Resend batch (/emails/batch envelope)", () => {
	it("sends one request with a rendered message per recipient and maps ids", async () => {
		fetch.mockResolvedValue(respond({ json: { data: [{ id: "id-a" }, { id: "id-b" }] } }))
		const mail = new Resend({ api_key: "re_key" })
		const results = await mail.send(batch)

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(sent_url()).toBe("https://api.resend.com/emails/batch")
		const body = sent_json()
		expect(body).toHaveLength(2)
		expect(body[0]).toMatchObject({
			to: ["a@test.com"],
			subject: "Hi Ada",
			html: "<p>Hello Ada, ref 1</p>",
		})
		expect(body[1]).toMatchObject({
			to: ["b@test.com"],
			subject: "Hi Linus",
			html: "<p>Hello Linus, ref 2</p>",
		})
		expect(results).toEqual([
			{ ok: true, index: 0, response: { id: "id-a" } },
			{ ok: true, index: 1, response: { id: "id-b" } },
		])
	})
})

describe("Postmark batch (/email/batch envelope)", () => {
	it("flags per-recipient ErrorCode failures", async () => {
		fetch.mockResolvedValue(
			respond({
				json: [
					{ MessageID: "m-a", ErrorCode: 0, Message: "OK" },
					{ ErrorCode: 406, Message: "Inactive recipient" },
				],
			})
		)
		const mail = new Postmark({ api_key: "pm" })
		const results = await mail.send(batch)

		expect(sent_url()).toBe("https://api.postmarkapp.com/email/batch")
		expect(sent_json()).toHaveLength(2)
		expect(results[0].ok).toBe(true)
		expect(results[1].ok).toBe(false)
		expect(results[1].ok === false && results[1].error.code).toBe(406)
	})
})

describe("MailerSend batch (/bulk-email)", () => {
	it("returns the bulk id for every recipient", async () => {
		fetch.mockResolvedValue(respond({ json: { bulk_email_id: "bulk-1" } }))
		const mail = new MailerSend({ api_key: "ms" })
		const results = await mail.send(batch)

		expect(sent_url()).toBe("https://api.mailersend.com/v1/bulk-email")
		expect(sent_json()).toHaveLength(2)
		expect(results.map((r) => r.ok === true && r.response)).toEqual([
			{ message_id: "bulk-1" },
			{ message_id: "bulk-1" },
		])
	})
})

describe("Mailgun batch (recipient-variables)", () => {
	it("sends one message with %recipient.x% tags and a variables map", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "<id>", message: "Queued" } }))
		const mail = new Mailgun({ api_key: "mg", domain: "mg.test.com" })
		const results = await mail.send(batch)

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(sent_url()).toBe("https://api.mailgun.net/v3/mg.test.com/messages")
		const form = sent_form()
		expect(form.getAll("to")).toEqual(["a@test.com", "b@test.com"])
		expect(form.get("subject")).toBe("Hi %recipient.name%")
		expect(form.get("html")).toBe("<p>Hello %recipient.name%, ref %recipient.id%</p>")
		expect(JSON.parse(form.get("recipient-variables") as string)).toEqual(batch.data)
		// single aggregate response → same id for each recipient
		expect(results.map((r) => r.ok)).toEqual([true, true])
	})
})

describe("SparkPost batch (substitution_data)", () => {
	it("uses {{x}} tags and per-recipient substitution_data", async () => {
		fetch.mockResolvedValue(
			respond({ json: { results: { id: "1", total_accepted_recipients: 2 } } })
		)
		const mail = new SparkPost({ api_key: "sp" })
		await mail.send(batch)

		expect(sent_url()).toBe("https://api.sparkpost.com/api/v1/transmissions")
		const body = sent_json()
		expect(body.content.subject).toBe("Hi {{name}}")
		expect(body.content.html).toBe("<p>Hello {{name}}, ref {{id}}</p>")
		expect(body.recipients).toEqual([
			{ address: { email: "a@test.com" }, substitution_data: { name: "Ada", id: "1" } },
			{ address: { email: "b@test.com" }, substitution_data: { name: "Linus", id: "2" } },
		])
	})
})

describe("Mandrill batch (merge_vars)", () => {
	it("uses *|x|* tags, merge_vars, and maps per-recipient status", async () => {
		fetch.mockResolvedValue(
			respond({
				json: [
					{ email: "a@test.com", status: "sent", _id: "1", reject_reason: null },
					{ email: "b@test.com", status: "rejected", _id: "2", reject_reason: "hard-bounce" },
				],
			})
		)
		const mail = new Mandrill({ api_key: "md" })
		const results = await mail.send(batch)

		expect(sent_url()).toBe("https://mandrillapp.com/api/1.0/messages/send")
		const body = sent_json()
		expect(body.message.subject).toBe("Hi *|name|*")
		expect(body.message.html).toBe("<p>Hello *|name|*, ref *|id|*</p>")
		expect(body.message.merge).toBe(true)
		expect(body.message.merge_language).toBe("mailchimp")
		expect(body.message.merge_vars).toEqual([
			{
				rcpt: "a@test.com",
				vars: [
					{ name: "name", content: "Ada" },
					{ name: "id", content: "1" },
				],
			},
			{
				rcpt: "b@test.com",
				vars: [
					{ name: "name", content: "Linus" },
					{ name: "id", content: "2" },
				],
			},
		])
		expect(results[0].ok).toBe(true)
		expect(results[1].ok).toBe(false)
		expect(results[1].ok === false && results[1].error.code).toBe("rejected")
	})
})

describe("SendGrid batch (personalizations + substitutions)", () => {
	it("keeps {key} tags and one personalization per recipient", async () => {
		fetch.mockResolvedValue(respond({ status: 202, headers: { "x-message-id": "sg-1" } }))
		const mail = new SendGrid({ api_key: "sg" })
		const results = await mail.send(batch)

		expect(sent_url()).toBe("https://api.sendgrid.com/v3/mail/send")
		const body = sent_json()
		expect(body.subject).toBe("Hi {name}")
		expect(body.personalizations).toEqual([
			{ to: [{ email: "a@test.com" }], substitutions: { "{name}": "Ada", "{id}": "1" } },
			{ to: [{ email: "b@test.com" }], substitutions: { "{name}": "Linus", "{id}": "2" } },
		])
		expect(results.map((r) => r.ok === true && r.response)).toEqual([
			{ message_id: "sg-1" },
			{ message_id: "sg-1" },
		])
	})
})

describe("Brevo batch (messageVersions)", () => {
	it("uses {{params.x}} tags, a version per recipient, and maps messageIds", async () => {
		fetch.mockResolvedValue(respond({ json: { messageIds: ["br-a", "br-b"] } }))
		const mail = new Brevo({ api_key: "brevo" })
		const results = await mail.send(batch)

		expect(sent_url()).toBe("https://api.brevo.com/v3/smtp/email")
		const body = sent_json()
		expect(body.subject).toBe("Hi {{params.name}}")
		expect(body.htmlContent).toBe("<p>Hello {{params.name}}, ref {{params.id}}</p>")
		expect(body.messageVersions).toEqual([
			{ to: [{ email: "a@test.com" }], params: { name: "Ada", id: "1" } },
			{ to: [{ email: "b@test.com" }], params: { name: "Linus", id: "2" } },
		])
		expect(results.map((r) => r.ok === true && r.response)).toEqual([
			{ messageId: "br-a" },
			{ messageId: "br-b" },
		])
	})
})

// Compile-time only: `data` keys are inferred from a literal `to` array. Never executed —
// `tsc -p tsconfig.json` (which includes test files) is the guard.
async function _type_inference_guards() {
	const mail = new Mock()

	// Valid: keys match the `to` literals.
	await mail.send({
		to: ["a@x.com", "b@x.com"],
		data: { "a@x.com": { name: "A" }, "b@x.com": { name: "B" } },
		body: "{name}",
	})

	// @ts-expect-error "typo@x.com" is not one of the `to` addresses
	await mail.send({ to: ["a@x.com"], data: { "typo@x.com": { name: "no" } }, body: "{name}" })

	// Object recipients can't be inferred → keys relax to any string (no error).
	await mail.send({
		to: [{ address: "a@x.com" }],
		data: { "a@x.com": { name: "ok" } },
		body: "{name}",
	})
}
