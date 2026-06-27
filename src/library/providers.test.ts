import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { PostboiError } from "$library/index.js"
import Resend from "$library/resend.js"
import Postmark from "$library/postmark.js"
import SendGrid from "$library/sendgrid.js"
import Mailgun from "$library/mailgun.js"
import Brevo from "$library/brevo.js"
import Cloudflare from "$library/cloudflare.js"
import MailerSend from "$library/mailersend.js"
import SparkPost from "$library/sparkpost.js"
import Mandrill from "$library/mandrill.js"
import Plunk from "$library/plunk.js"
import Mailtrap from "$library/mailtrap.js"
import MailPace from "$library/mailpace.js"
import Scaleway from "$library/scaleway.js"

const fetch = vi.fn()
global.fetch = fetch

/** Build a mock Response. `json` is serialised for both `.json()` and `.text()`. */
function respond(
	opts: {
		ok?: boolean
		status?: number
		json?: unknown
		text?: string
		headers?: Record<string, string>
	} = {}
) {
	const body = opts.text ?? (opts.json !== undefined ? JSON.stringify(opts.json) : "")
	return {
		ok: opts.ok ?? true,
		status: opts.status ?? 200,
		headers: new Headers(opts.headers ?? {}),
		text: async () => body,
		json: async () => opts.json,
	}
}

/** Parse the JSON request body of the most recent fetch call. */
function sent_json() {
	const init = fetch.mock.calls.at(-1)![1] as RequestInit
	return JSON.parse(init.body as string)
}

/** The init (method/headers/body) of the most recent fetch call. */
function sent_init() {
	return fetch.mock.calls.at(-1)![1] as RequestInit & { headers: Record<string, string> }
}

/** The URL of the most recent fetch call. */
function sent_url() {
	return fetch.mock.calls.at(-1)![0] as string
}

/** Await a send expected to fail and return the thrown PostboiError. */
async function caught(promise: Promise<unknown>): Promise<PostboiError> {
	const error = await promise.catch((e) => e)
	expect(error).toBeInstanceOf(PostboiError)
	return error as PostboiError
}

const b64 = (s: string) => Buffer.from(s).toString("base64")
const attachment = () => new File(["filedata"], "doc.pdf", { type: "application/pdf" })

beforeEach(() => {
	fetch.mockReset()
})
afterEach(() => {
	vi.clearAllMocks()
})

describe("Resend", () => {
	const mail = () => new Resend({ api_key: "re_key", default_from: "from@test.com" })

	it("maps a send to the Resend API", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "abc" } }))
		const result = await mail().send({
			to: "to@test.com",
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.resend.com/emails")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer re_key" })
		const body = sent_json()
		expect(body.from).toBe("from@test.com")
		expect(body.to).toEqual(["to@test.com"])
		expect(body.cc).toEqual(["cc@test.com"])
		expect(body.bcc).toEqual(["bcc@test.com"])
		expect(body.reply_to).toEqual(["reply@test.com"])
		expect(body.html).toBe("<p>x</p>")
		expect(body.text).toBe("x")
		expect(body.attachments).toEqual([
			{ filename: "doc.pdf", content: b64("filedata"), content_type: "application/pdf" },
		])
		expect(result).toEqual({ id: "abc" })
	})

	it("throws a normalized PostboiError", async () => {
		const raw = { statusCode: 422, name: "validation_error", message: "bad" }
		fetch.mockResolvedValue(respond({ ok: false, status: 422, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("resend")
		expect(error.message).toBe("bad")
		expect(error.code).toBe("validation_error")
		expect(error.status).toBe(422)
		expect(error.raw).toEqual(raw)
		expect(mail().is_error(error)).toBe(true)
		expect(mail().is_error(raw)).toBe(false)
	})
})

describe("Postmark", () => {
	const mail = () => new Postmark({ api_key: "pm_token", default_from: "from@test.com" })

	it("maps recipients to comma-separated strings and PascalCase fields", async () => {
		fetch.mockResolvedValue(respond({ json: { MessageID: "id", ErrorCode: 0, Message: "OK" } }))
		await mail().send({
			to: ["a@test.com", "b@test.com"],
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.postmarkapp.com/email")
		expect(sent_init().headers).toMatchObject({ "X-Postmark-Server-Token": "pm_token" })
		const body = sent_json()
		expect(body.To).toBe("a@test.com, b@test.com")
		expect(body.ReplyTo).toBe("reply@test.com")
		expect(body.HtmlBody).toBe("<p>x</p>")
		expect(body.MessageStream).toBe("outbound")
		expect(body.Attachments).toEqual([
			{ Name: "doc.pdf", Content: b64("filedata"), ContentType: "application/pdf" },
		])
	})

	it("treats ErrorCode != 0 as an error even on HTTP 200", async () => {
		const raw = { ErrorCode: 300, Message: "Invalid 'From'" }
		fetch.mockResolvedValue(respond({ ok: true, status: 200, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("postmark")
		expect(error.message).toBe("Invalid 'From'")
		expect(error.code).toBe(300)
	})
})

describe("SendGrid", () => {
	const mail = () => new SendGrid({ api_key: "sg_key", default_from: "from@test.com" })

	it("nests recipients in personalizations and content array", async () => {
		fetch.mockResolvedValue(respond({ status: 202, headers: { "x-message-id": "sg-1" } }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
		})

		expect(sent_url()).toBe("https://api.sendgrid.com/v3/mail/send")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer sg_key" })
		const body = sent_json()
		expect(body.personalizations[0].to).toEqual([{ email: "to@test.com", name: "To" }])
		expect(body.personalizations[0].cc).toEqual([{ email: "cc@test.com" }])
		expect(body.from).toEqual({ email: "from@test.com" })
		expect(body.content).toEqual([
			{ type: "text/plain", value: "x" },
			{ type: "text/html", value: "<p>x</p>" },
		])
		expect(result).toEqual({ message_id: "sg-1" })
	})

	it("uses the EU host when region is eu", async () => {
		fetch.mockResolvedValue(respond({ status: 202 }))
		await new SendGrid({ api_key: "k", region: "eu", default_from: "f@test.com" }).send({
			to: "to@test.com",
			body: "x",
		})
		expect(sent_url()).toBe("https://api.eu.sendgrid.com/v3/mail/send")
	})

	it("throws on non-202 with an errors array", async () => {
		const raw = { errors: [{ message: "bad", field: "from" }] }
		fetch.mockResolvedValue(respond({ ok: false, status: 400, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("sendgrid")
		expect(error.message).toBe("bad")
	})
})

describe("Mailgun", () => {
	const mail = () =>
		new Mailgun({ api_key: "mg_key", domain: "mg.test.com", default_from: "from@test.com" })

	it("posts multipart form data with basic auth", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "<id>", message: "Queued" } }))
		await mail().send({
			to: "to@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.mailgun.net/v3/mg.test.com/messages")
		const init = sent_init()
		expect(init.headers).toMatchObject({ Authorization: `Basic ${b64("api:mg_key")}` })
		const form = init.body as FormData
		expect(form.get("from")).toBe("from@test.com")
		expect(form.get("to")).toBe("to@test.com")
		expect(form.get("html")).toBe("<p>x</p>")
		expect(form.get("h:Reply-To")).toBe("reply@test.com")
		expect(form.get("attachment")).toBeInstanceOf(File)
	})

	it("uses the EU host when region is eu", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "x", message: "ok" } }))
		await new Mailgun({
			api_key: "k",
			domain: "d.com",
			region: "eu",
			default_from: "f@test.com",
		}).send({ to: "to@test.com", body: "x" })
		expect(sent_url()).toBe("https://api.eu.mailgun.net/v3/d.com/messages")
	})

	it("detects errors", async () => {
		const raw = { message: "Forbidden" }
		fetch.mockResolvedValue(respond({ ok: false, status: 401, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("mailgun")
		expect(error.message).toBe("Forbidden")
	})
})

describe("Brevo", () => {
	const mail = () => new Brevo({ api_key: "brevo_key", default_from: "from@test.com" })

	it("maps to sender/htmlContent and the api-key header", async () => {
		fetch.mockResolvedValue(respond({ status: 201, json: { messageId: "m-1" } }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			subject: "Hi",
			body: "<p>x</p>",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.brevo.com/v3/smtp/email")
		expect(sent_init().headers).toMatchObject({ "api-key": "brevo_key" })
		const body = sent_json()
		expect(body.sender).toEqual({ email: "from@test.com" })
		expect(body.to).toEqual([{ email: "to@test.com", name: "To" }])
		expect(body.htmlContent).toBe("<p>x</p>")
		expect(body.attachment).toEqual([{ content: b64("filedata"), name: "doc.pdf" }])
		expect(result).toEqual({ messageId: "m-1" })
	})

	it("detects errors", async () => {
		const raw = { code: "invalid_parameter", message: "bad" }
		fetch.mockResolvedValue(respond({ ok: false, status: 400, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("brevo")
		expect(error.message).toBe("bad")
		expect(error.code).toBe("invalid_parameter")
	})
})

describe("Cloudflare", () => {
	const mail = () =>
		new Cloudflare({ api_key: "cf_token", account_id: "acc-123", default_from: "from@test.com" })

	it("posts to the account send endpoint with a bearer token", async () => {
		fetch.mockResolvedValue(
			respond({
				json: {
					success: true,
					errors: [],
					messages: [],
					result: { delivered: ["to@test.com"], permanent_bounces: [], queued: [] },
				},
			})
		)
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			attachments: attachment(),
		})

		expect(sent_url()).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acc-123/email/sending/send"
		)
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer cf_token" })
		const body = sent_json()
		expect(body.from).toEqual({ email: "from@test.com" })
		expect(body.to).toEqual([{ email: "to@test.com", name: "To" }])
		expect(body.cc).toEqual([{ email: "cc@test.com" }])
		expect(body.replyTo).toEqual({ email: "reply@test.com" })
		expect(body.html).toBe("<p>x</p>")
		expect(body.text).toBe("x")
		expect(body.attachments).toEqual([
			{
				content: b64("filedata"),
				filename: "doc.pdf",
				type: "application/pdf",
				disposition: "attachment",
			},
		])
		expect(result.success).toBe(true)
	})

	it("treats success:false as an error even on HTTP 200", async () => {
		const raw = {
			success: false,
			errors: [{ code: 10001, message: "email.sending.error.invalid_request_schema" }],
			messages: [],
			result: null,
		}
		fetch.mockResolvedValue(respond({ ok: true, status: 200, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("cloudflare")
		expect(error.message).toBe("email.sending.error.invalid_request_schema")
		expect(error.code).toBe(10001)
	})
})

describe("MailerSend", () => {
	const mail = () => new MailerSend({ api_key: "ms_key", default_from: "from@test.com" })

	it("maps to from/html and reads the id header", async () => {
		fetch.mockResolvedValue(respond({ status: 202, headers: { "x-message-id": "ms-1" } }))
		const result = await mail().send({
			to: "to@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.mailersend.com/v1/email")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer ms_key" })
		const body = sent_json()
		expect(body.from).toEqual({ email: "from@test.com" })
		expect(body.reply_to).toEqual({ email: "reply@test.com" })
		expect(body.html).toBe("<p>x</p>")
		expect(body.attachments).toEqual([
			{ content: b64("filedata"), filename: "doc.pdf", disposition: "attachment" },
		])
		expect(result).toEqual({ message_id: "ms-1" })
	})

	it("detects errors", async () => {
		const raw = { message: "The given data was invalid.", errors: { "to.0.email": ["invalid"] } }
		fetch.mockResolvedValue(respond({ ok: false, status: 422, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("mailersend")
		expect(error.message).toBe("The given data was invalid.")
	})
})

describe("SparkPost", () => {
	const mail = () => new SparkPost({ api_key: "sp_key", default_from: "from@test.com" })

	it("splits content/recipients and routes cc via header_to + CC header", async () => {
		fetch.mockResolvedValue(
			respond({ json: { results: { id: "1", total_accepted_recipients: 2 } } })
		)
		await mail().send({
			to: "to@test.com",
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.sparkpost.com/api/v1/transmissions")
		expect(sent_init().headers).toMatchObject({ Authorization: "sp_key" })
		const body = sent_json()
		expect(body.content.from).toEqual({ email: "from@test.com" })
		expect(body.content.reply_to).toBe("reply@test.com")
		expect(body.content.headers).toEqual({ CC: "cc@test.com" })
		expect(body.content.attachments).toEqual([
			{ name: "doc.pdf", type: "application/pdf", data: b64("filedata") },
		])
		expect(body.recipients).toEqual([
			{ address: { email: "to@test.com" } },
			{ address: { email: "cc@test.com", header_to: "to@test.com" } },
			{ address: { email: "bcc@test.com", header_to: "to@test.com" } },
		])
	})

	it("detects errors", async () => {
		const raw = { errors: [{ message: "bad", code: "1902" }] }
		fetch.mockResolvedValue(respond({ ok: false, status: 422, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("sparkpost")
		expect(error.message).toBe("bad")
		expect(error.code).toBe("1902")
	})
})

describe("Mandrill", () => {
	const mail = () => new Mandrill({ api_key: "md_key", default_from: "from@test.com" })

	it("puts the key in the body and tags recipients with type", async () => {
		fetch.mockResolvedValue(
			respond({ json: [{ email: "to@test.com", status: "sent", _id: "1", reject_reason: null }] })
		)
		await mail().send({
			to: "to@test.com",
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://mandrillapp.com/api/1.0/messages/send")
		const body = sent_json()
		expect(body.key).toBe("md_key")
		expect(body.message.from_email).toBe("from@test.com")
		expect(body.message.to).toEqual([
			{ email: "to@test.com", type: "to" },
			{ email: "cc@test.com", type: "cc" },
			{ email: "bcc@test.com", type: "bcc" },
		])
		expect(body.message.headers).toEqual({ "Reply-To": "reply@test.com" })
		expect(body.message.attachments).toEqual([
			{ type: "application/pdf", name: "doc.pdf", content: b64("filedata") },
		])
	})

	it("detects a call-level error object (not the success array)", async () => {
		const raw = { status: "error", code: 12, name: "Invalid_Key", message: "bad key" }
		fetch.mockResolvedValue(respond({ ok: true, status: 200, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("mandrill")
		expect(error.message).toBe("bad key")
		expect(error.code).toBe(12)
	})
})

describe("Plunk", () => {
	const mail = () => new Plunk({ api_key: "pl_key", default_from: "from@test.com" })

	it("sends html in body with to as a string array", async () => {
		fetch.mockResolvedValue(respond({ json: { success: true, emails: [], timestamp: "t" } }))
		await mail().send({
			to: ["a@test.com", "b@test.com"],
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
		})

		expect(sent_url()).toBe("https://api.useplunk.com/v1/send")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer pl_key" })
		const body = sent_json()
		expect(body.to).toEqual(["a@test.com", "b@test.com"])
		expect(body.body).toBe("<p>x</p>")
		expect(body.from).toBe("from@test.com")
		expect(body.reply).toBe("reply@test.com")
	})

	it("detects errors", async () => {
		const raw = { code: 401, error: "Unauthorized", message: "bad key", time: 1 }
		fetch.mockResolvedValue(respond({ ok: false, status: 401, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("plunk")
		expect(error.message).toBe("bad key")
		expect(error.code).toBe(401)
	})
})

describe("Mailtrap", () => {
	const mail = () => new Mailtrap({ api_key: "mt_token", default_from: "from@test.com" })

	it("maps to from/to objects and html", async () => {
		fetch.mockResolvedValue(respond({ json: { success: true, message_ids: ["1"] } }))
		await mail().send({
			to: { address: "to@test.com", name: "To" },
			subject: "Hi",
			body: "<p>x</p>",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://send.api.mailtrap.io/api/send")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer mt_token" })
		const body = sent_json()
		expect(body.from).toEqual({ email: "from@test.com" })
		expect(body.to).toEqual([{ email: "to@test.com", name: "To" }])
		expect(body.html).toBe("<p>x</p>")
		expect(body.attachments).toEqual([
			{ content: b64("filedata"), filename: "doc.pdf", type: "application/pdf" },
		])
	})

	it("uses the sandbox host with an inbox id", async () => {
		fetch.mockResolvedValue(respond({ json: { success: true, message_ids: ["1"] } }))
		await new Mailtrap({
			api_key: "t",
			sandbox: true,
			inbox_id: "999",
			default_from: "f@test.com",
		}).send({
			to: "to@test.com",
			body: "x",
		})
		expect(sent_url()).toBe("https://sandbox.api.mailtrap.io/api/send/999")
	})

	it("requires an inbox id in sandbox mode", () => {
		expect(() => new Mailtrap({ api_key: "t", sandbox: true })).toThrow(/inbox_id/)
	})

	it("detects errors", async () => {
		const raw = { success: false, errors: ["'to' is invalid"] }
		fetch.mockResolvedValue(respond({ ok: false, status: 400, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("mailtrap")
		expect(error.message).toContain("'to' is invalid")
	})
})

describe("MailPace", () => {
	const mail = () => new MailPace({ api_key: "mp_token", default_from: "from@test.com" })

	it("maps to lowercase string fields", async () => {
		fetch.mockResolvedValue(respond({ json: { id: 1, status: "queued" } }))
		await mail().send({
			to: ["a@test.com", "b@test.com"],
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://app.mailpace.com/api/v1/send")
		expect(sent_init().headers).toMatchObject({ "MailPace-Server-Token": "mp_token" })
		const body = sent_json()
		expect(body.to).toBe("a@test.com, b@test.com")
		expect(body.replyto).toBe("reply@test.com")
		expect(body.htmlbody).toBe("<p>x</p>")
		expect(body.attachments).toEqual([
			{ name: "doc.pdf", content: b64("filedata"), content_type: "application/pdf" },
		])
	})

	it("normalizes both error shapes", async () => {
		fetch.mockResolvedValue(
			respond({ ok: false, status: 422, json: { errors: { to: ["invalid"] } } })
		)
		let error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("mailpace")
		expect(error.message).toContain("invalid")

		fetch.mockResolvedValue(respond({ ok: false, status: 401, json: { error: "unauthorized" } }))
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("unauthorized")
	})
})

describe("Scaleway", () => {
	const mail = () =>
		new Scaleway({
			secret_key: "scw_secret",
			project_id: "proj-1",
			region: "fr-par",
			default_from: "from@test.com",
		})

	it("includes project_id, region path and reply-to header", async () => {
		fetch.mockResolvedValue(respond({ json: { emails: [{ id: "e1" }] } }))
		await mail().send({
			to: "to@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			attachments: attachment(),
		})

		expect(sent_url()).toBe(
			"https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails"
		)
		expect(sent_init().headers).toMatchObject({ "X-Auth-Token": "scw_secret" })
		const body = sent_json()
		expect(body.project_id).toBe("proj-1")
		expect(body.from).toEqual({ email: "from@test.com" })
		expect(body.to).toEqual([{ email: "to@test.com" }])
		expect(body.additional_headers).toEqual([{ key: "Reply-To", value: "reply@test.com" }])
		expect(body.attachments).toEqual([
			{ name: "doc.pdf", type: "application/pdf", content: b64("filedata") },
		])
	})

	it("detects errors", async () => {
		const raw = { message: "denied" }
		fetch.mockResolvedValue(respond({ ok: false, status: 403, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("scaleway")
		expect(error.message).toBe("denied")
	})
})

describe("resilience (shared base)", () => {
	const make = (opts = {}) =>
		new Resend({ api_key: "k", default_from: "from@test.com", retry_delay: 0, ...opts })

	it("retries on 5xx then succeeds", async () => {
		fetch
			.mockResolvedValueOnce(respond({ ok: false, status: 503 }))
			.mockResolvedValueOnce(respond({ json: { id: "ok" } }))
		const result = await make({ retries: 1 }).send({ to: "to@test.com", body: "x" })
		expect(result).toEqual({ id: "ok" })
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it("gives up after exhausting retries", async () => {
		fetch.mockResolvedValue(
			respond({ ok: false, status: 503, json: { message: "down", name: "x" } })
		)
		const error = await caught(make({ retries: 2 }).send({ to: "to@test.com", body: "x" }))
		expect(error.status).toBe(503)
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	it("does not retry on 4xx", async () => {
		fetch.mockResolvedValue(
			respond({ ok: false, status: 400, json: { message: "bad", name: "x" } })
		)
		await caught(make({ retries: 3 }).send({ to: "to@test.com", body: "x" }))
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("wraps network failures in a PostboiError", async () => {
		fetch.mockImplementation(async () => {
			throw new Error("ECONNRESET")
		})
		await expect(make().send({ to: "to@test.com", body: "x" })).rejects.toMatchObject({
			name: "PostboiError",
			provider: "resend",
			message: expect.stringContaining("ECONNRESET"),
		})
	})

	it("forwards an idempotency key header", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))
		await make().send({ to: "to@test.com", body: "x", idempotency_key: "abc" })
		expect(sent_init().headers).toMatchObject({ "Idempotency-Key": "abc" })
	})
})
