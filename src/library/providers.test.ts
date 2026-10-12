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
import Lettermint from "$library/lettermint.js"
import Unosend from "$library/unosend.js"
import Sequenzy from "$library/sequenzy.js"
import Loops from "$library/loops.js"
import MailChannels from "$library/mailchannels.js"
import SMTP2GO from "$library/smtp2go.js"
import SocketLabs from "$library/socketlabs.js"
import Azure from "$library/azure.js"
import Gmail from "$library/gmail.js"
import Maileroo from "$library/maileroo.js"
import AhaSend from "$library/ahasend.js"
import Postal from "$library/postal.js"
import CustomerIO from "$library/customerio.js"
import Infobip from "$library/infobip.js"
import SendPulse from "$library/sendpulse.js"
import Iterable from "$library/iterable.js"
import JetEmail from "$library/jetemail.js"
import Lettr from "$library/lettr.js"
import Primitive from "$library/primitive.js"
import Netcore from "$library/netcore.js"
import Klaviyo from "$library/klaviyo.js"
import HubSpot from "$library/hubspot.js"
import OneSignal from "$library/onesignal.js"
import AlibabaDirectMail from "$library/alibaba.js"
import YandexPostbox from "$library/yandex.js"
import { clear_token_cache } from "$library/push/oauth.js"
import { createHash, createHmac, generateKeyPairSync } from "node:crypto"
import Scaleway from "$library/scaleway.js"
import SES from "$library/ses.js"
import Microsoft365 from "$library/microsoft365.js"
import Mailjet from "$library/mailjet.js"
import ElasticEmail from "$library/elasticemail.js"

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
	const mail = () => new Resend({ api_key: "re_key", default: { from: "from@test.com" } })

	it("refuses web_version, which only Postboi can host, before anything is sent", async () => {
		const send = mail().send({
			to: "to@test.com",
			subject: "Hi",
			body: '<a href="{{ postboi.web_url }}">View in browser</a>',
			// Typed away for every provider but Postboi; plain JS still gets here.
			web_version: true as never,
		})
		await expect(send).rejects.toMatchObject({ code: "web_version_unsupported" })
		await expect(send).rejects.toBeInstanceOf(PostboiError)
		expect(fetch).not.toHaveBeenCalled()
	})

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
	const mail = () => new Postmark({ api_key: "pm_token", default: { from: "from@test.com" } })

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
	const mail = () => new SendGrid({ api_key: "sg_key", default: { from: "from@test.com" } })

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
		await new SendGrid({ api_key: "k", region: "eu", default: { from: "f@test.com" } }).send({
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
		new Mailgun({ api_key: "mg_key", domain: "mg.test.com", default: { from: "from@test.com" } })

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
			default: { from: "f@test.com" },
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
	const mail = () => new Brevo({ api_key: "brevo_key", default: { from: "from@test.com" } })

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
		new Cloudflare({
			api_key: "cf_token",
			account_id: "acc-123",
			default: { from: "from@test.com" },
		})

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
	const mail = () => new MailerSend({ api_key: "ms_key", default: { from: "from@test.com" } })

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
	const mail = () => new SparkPost({ api_key: "sp_key", default: { from: "from@test.com" } })

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
	const mail = () => new Mandrill({ api_key: "md_key", default: { from: "from@test.com" } })

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
	const mail = () => new Plunk({ api_key: "pl_key", default: { from: "from@test.com" } })

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
	const mail = () => new Mailtrap({ api_key: "mt_token", default: { from: "from@test.com" } })

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
			default: { from: "f@test.com" },
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
	const mail = () => new MailPace({ api_key: "mp_token", default: { from: "from@test.com" } })

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

describe("Lettermint", () => {
	const mail = () => new Lettermint({ api_key: "lm_token", default: { from: "from@test.com" } })

	it("maps a send to the Lettermint API", async () => {
		fetch.mockResolvedValue(respond({ json: { message_id: "msg-1", status: "queued" } }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			idempotency_key: "idem-1",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome"],
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.lettermint.co/v1/send")
		expect(sent_init().headers).toMatchObject({
			"x-lettermint-token": "lm_token",
			"Idempotency-Key": "idem-1",
		})
		const body = sent_json()
		expect(body.from).toBe("from@test.com")
		expect(body.to).toEqual(["To <to@test.com>"])
		expect(body.cc).toEqual(["cc@test.com"])
		expect(body.reply_to).toEqual(["reply@test.com"])
		expect(body.html).toBe("<p>x</p>")
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.tags).toEqual([{ name: "welcome", value: "welcome" }])
		expect(body.route).toBeUndefined()
		expect(body.settings).toBeUndefined()
		expect(body.attachments).toEqual([
			{ filename: "doc.pdf", content: b64("filedata"), content_type: "application/pdf" },
		])
		expect(result).toEqual({ message_id: "msg-1", status: "queued" })
	})

	it("sends through a named route with tracking settings", async () => {
		fetch.mockResolvedValue(respond({ json: { message_id: "msg-2", status: "queued" } }))
		await new Lettermint({
			api_key: "lm_token",
			route: "transactional",
			default: { from: "from@test.com" },
		}).send({
			to: "to@test.com",
			body: "x",
			tracking: { opens: false },
		})
		const body = sent_json()
		expect(body.route).toBe("transactional")
		expect(body.settings).toEqual({ track_opens: false })
	})

	it("detects errors", async () => {
		fetch.mockResolvedValue(respond({ ok: false, status: 422, json: { error: "ValidationError" } }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("lettermint")
		expect(error.message).toContain("ValidationError")
	})
})

describe("Unosend", () => {
	const mail = () => new Unosend({ api_key: "un_key", default: { from: "from@test.com" } })

	it("maps a send to the Unosend API and unwraps the data envelope", async () => {
		fetch.mockResolvedValue(
			respond({ json: { success: true, data: { id: "uno-1", status: "queued" } } })
		)
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			bcc: "bcc@test.com",
			reply_to: ["reply@test.com", "extra@test.com"],
			subject: "Hi",
			body: "<p>x</p>",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome"],
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.unosend.co/emails")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer un_key" })
		const body = sent_json()
		expect(body.from).toBe("from@test.com")
		expect(body.to).toEqual(["To <to@test.com>"])
		expect(body.bcc).toEqual(["bcc@test.com"])
		expect(body.reply_to).toBe("reply@test.com")
		expect(body.html).toBe("<p>x</p>")
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.tags).toEqual([{ name: "welcome", value: "welcome" }])
		expect(body.attachments).toEqual([
			{ filename: "doc.pdf", content: b64("filedata"), content_type: "application/pdf" },
		])
		expect(result).toEqual({ id: "uno-1", status: "queued" })
	})

	it("detects errors", async () => {
		fetch.mockResolvedValue(
			respond({ ok: false, status: 422, json: { error: { message: "Invalid to", code: 422 } } })
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("unosend")
		expect(error.message).toContain("Invalid to")
	})
})

describe("Sequenzy", () => {
	const mail = () => new Sequenzy({ api_key: "seq_live_key", default: { from: "from@test.com" } })
	const accepted = { success: true, emailSendId: "send_1", jobId: "job_1", to: "to@test.com" }

	it("maps a send to the Sequenzy transactional endpoint", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			reply_to: ["Support <reply@test.com>", "extra@test.com"],
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome"],
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.sequenzy.com/api/v1/transactional/send")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer seq_live_key" })
		expect(sent_init().headers["x-company-id"]).toBeUndefined()
		const body = sent_json()
		// One recipient is a string, and a bare address: Sequenzy files it as a subscriber.
		expect(body.to).toBe("to@test.com")
		expect(body.cc).toEqual(["cc@test.com"])
		expect(body.from).toBe("from@test.com")
		expect(body.replyTo).toBe("Support <reply@test.com>")
		expect(body.subject).toBe("Hi")
		expect(body.body).toBe("<p>x</p>")
		expect(body.attachments).toEqual([{ filename: "doc.pdf", content: b64("filedata") }])
		// No equivalent on the wire — dropped rather than sent under a guessed name.
		expect(body.headers).toBeUndefined()
		expect(body.tags).toBeUndefined()
		expect(body.text).toBeUndefined()
		expect(result).toEqual(accepted)
	})

	it("sends several recipients as an array, and a text-only message as the body", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		await new Sequenzy({
			api_key: "seq_user_key",
			company_id: "company_1",
			default: { from: "from@test.com" },
		}).send({ to: ["a@test.com", "b@test.com"], subject: "Hi", text: "plain" })
		expect(sent_init().headers).toMatchObject({ "x-company-id": "company_1" })
		const body = sent_json()
		expect(body.to).toEqual(["a@test.com", "b@test.com"])
		expect(body.body).toBe("plain")
	})

	it("detects errors, including a rejection that arrives with a 200", async () => {
		fetch.mockResolvedValue(
			respond({ ok: false, status: 401, json: { success: false, error: "Unauthorized" } })
		)
		let error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("sequenzy")
		expect(error.status).toBe(401)
		expect(error.message).toBe("Unauthorized")

		fetch.mockResolvedValue(respond({ json: { success: false, error: "Sending paused" } }))
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("Sending paused")
	})
})

describe("Scaleway", () => {
	const mail = () =>
		new Scaleway({
			secret_key: "scw_secret",
			project_id: "proj-1",
			region: "fr-par",
			default: { from: "from@test.com" },
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

describe("SES", () => {
	const mail = () =>
		new SES({
			access_key_id: "AKIAEXAMPLE",
			secret_access_key: "secret",
			region: "eu-west-1",
			default: { from: "from@test.com" },
		})

	it("maps to the v2 SendEmail shape and signs with SigV4", async () => {
		fetch.mockResolvedValue(respond({ json: { MessageId: "ses-1" } }))
		const result = await mail().send({
			to: "to@test.com",
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Custom": "1" },
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails")
		const headers = sent_init().headers
		expect(headers.Authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/
		)
		expect(headers["X-Amz-Date"]).toMatch(/^\d{8}T\d{6}Z$/)
		const body = sent_json()
		expect(body.FromEmailAddress).toBe("from@test.com")
		expect(body.Destination).toEqual({
			ToAddresses: ["to@test.com"],
			CcAddresses: ["cc@test.com"],
			BccAddresses: ["bcc@test.com"],
		})
		expect(body.ReplyToAddresses).toEqual(["reply@test.com"])
		expect(body.Content.Simple.Subject).toEqual({ Data: "Hi" })
		expect(body.Content.Simple.Body).toEqual({ Html: { Data: "<p>x</p>" }, Text: { Data: "x" } })
		expect(body.Content.Simple.Headers).toEqual([{ Name: "X-Custom", Value: "1" }])
		expect(body.Content.Simple.Attachments).toEqual([
			{
				RawContent: b64("filedata"),
				FileName: "doc.pdf",
				ContentType: "application/pdf",
				ContentDisposition: "ATTACHMENT",
			},
		])
		expect(result).toEqual({ MessageId: "ses-1" })
	})

	it("detects errors and reads the error type header", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 400,
				json: { message: "Email address is not verified." },
				headers: { "x-amzn-errortype": "MessageRejected:" },
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("ses")
		expect(error.message).toBe("Email address is not verified.")
		expect(error.code).toBe("MessageRejected")
	})
})

describe("Microsoft 365", () => {
	const mail = () =>
		new Microsoft365({
			tenant_id: "tenant",
			client_id: "client",
			client_secret: "secret",
			default: { from: "from@test.com" },
		})

	/** Mock the token response, then the sendMail 202. */
	const mock_token_then_send = () => {
		fetch
			.mockResolvedValueOnce(respond({ json: { access_token: "tok", expires_in: 3600 } }))
			.mockResolvedValueOnce(respond({ status: 202 }))
	}

	it("fetches a token then posts the Graph message", async () => {
		mock_token_then_send()
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			headers: { "X-Custom": "1" },
			attachments: attachment(),
		})

		// First call is the OAuth token request.
		const token_call = fetch.mock.calls[0]
		expect(token_call[0]).toBe("https://login.microsoftonline.com/tenant/oauth2/v2.0/token")
		expect((token_call[1]!.body as URLSearchParams).get("grant_type")).toBe("client_credentials")

		// Second call is the sendMail, scoped to the from-address mailbox.
		expect(sent_url()).toBe("https://graph.microsoft.com/v1.0/users/from%40test.com/sendMail")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer tok" })
		const body = sent_json()
		expect(body.saveToSentItems).toBe(false)
		expect(body.message.subject).toBe("Hi")
		expect(body.message.body).toEqual({ contentType: "HTML", content: "<p>x</p>" })
		expect(body.message.toRecipients).toEqual([
			{ emailAddress: { address: "to@test.com", name: "To" } },
		])
		expect(body.message.ccRecipients).toEqual([{ emailAddress: { address: "cc@test.com" } }])
		expect(body.message.bccRecipients).toEqual([{ emailAddress: { address: "bcc@test.com" } }])
		expect(body.message.replyTo).toEqual([{ emailAddress: { address: "reply@test.com" } }])
		expect(body.message.internetMessageHeaders).toEqual([{ name: "X-Custom", value: "1" }])
		expect(body.message.attachments).toEqual([
			{
				"@odata.type": "#microsoft.graph.fileAttachment",
				name: "doc.pdf",
				contentType: "application/pdf",
				contentBytes: b64("filedata"),
			},
		])
		// sendMail returns no id, so the provider mints the internet Message-ID itself —
		// the same id the message-trace API (and poll()) reports for this message.
		expect(body.message.internetMessageId).toMatch(/^<pb-[0-9a-f-]+@test\.com>$/)
		expect(result).toEqual({ accepted: true, message_id: body.message.internetMessageId })
	})

	it("retries once without the minted id when a tenant's Graph rejects the property", async () => {
		fetch
			.mockResolvedValueOnce(respond({ json: { access_token: "tok", expires_in: 3600 } }))
			.mockResolvedValueOnce(
				respond({
					ok: false,
					status: 400,
					json: {
						error: { code: "RequestBodyRead", message: "Invalid property 'internetMessageId'." },
					},
				})
			)
			.mockResolvedValueOnce(respond({ status: 202 }))

		const result = await mail().send({ to: "to@test.com", body: "<p>x</p>" })
		// A 400 means nothing was sent, so the one retry is safe — and the retry's
		// payload carries no minted id, so the response can't either.
		expect(result).toEqual({ accepted: true })
		expect(fetch).toHaveBeenCalledTimes(3)
		const retry = JSON.parse(String(fetch.mock.calls[2][1]?.body))
		expect(retry.message.internetMessageId).toBeUndefined()
	})

	it("caches the token across sends", async () => {
		mock_token_then_send()
		fetch.mockResolvedValueOnce(respond({ status: 202 }))
		const m = mail()
		await m.send({ to: "to@test.com", body: "x" })
		await m.send({ to: "to@test.com", body: "y" })
		// 1 token + 2 sends — the second send reuses the cached token.
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	it("surfaces a token request failure", async () => {
		fetch.mockResolvedValueOnce(
			respond({
				ok: false,
				status: 401,
				json: { error: "invalid_client", error_description: "bad secret" },
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("microsoft365")
		expect(error.message).toBe("bad secret")
		expect(error.code).toBe("invalid_client")
	})

	it("detects a Graph send error", async () => {
		fetch
			.mockResolvedValueOnce(respond({ json: { access_token: "tok", expires_in: 3600 } }))
			.mockResolvedValueOnce(
				respond({
					ok: false,
					status: 400,
					json: { error: { code: "ErrorInvalidRecipients", message: "bad recipient" } },
				})
			)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("microsoft365")
		expect(error.message).toBe("bad recipient")
		expect(error.code).toBe("ErrorInvalidRecipients")
	})
})

describe("Mailjet", () => {
	const mail = () =>
		new Mailjet({ api_key: "mj_pub", api_secret: "mj_priv", default: { from: "from@test.com" } })

	it("wraps the message in Messages[] with basic auth", async () => {
		fetch.mockResolvedValue(
			respond({
				json: {
					Messages: [{ Status: "success", To: [{ MessageID: 111, MessageUUID: "uuid-1" }] }],
				},
			})
		)
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.mailjet.com/v3.1/send")
		expect(sent_init().headers).toMatchObject({
			Authorization: `Basic ${b64("mj_pub:mj_priv")}`,
		})
		const msg = sent_json().Messages[0]
		expect(msg.From).toEqual({ Email: "from@test.com" })
		expect(msg.To).toEqual([{ Email: "to@test.com", Name: "To" }])
		expect(msg.Cc).toEqual([{ Email: "cc@test.com" }])
		expect(msg.Bcc).toEqual([{ Email: "bcc@test.com" }])
		expect(msg.ReplyTo).toEqual({ Email: "reply@test.com" })
		expect(msg.HTMLPart).toBe("<p>x</p>")
		expect(msg.TextPart).toBe("x")
		expect(msg.Attachments).toEqual([
			{ ContentType: "application/pdf", Filename: "doc.pdf", Base64Content: b64("filedata") },
		])
		expect(result).toEqual({ message_id: "111", message_uuid: "uuid-1" })
	})

	it("treats a per-message error Status as a failure on HTTP 200", async () => {
		const raw = {
			Messages: [
				{ Status: "error", Errors: [{ ErrorCode: "mj-0004", ErrorMessage: "invalid email" }] },
			],
		}
		fetch.mockResolvedValue(respond({ ok: true, status: 200, json: raw }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("mailjet")
		expect(error.message).toBe("invalid email")
		expect(error.code).toBe("mj-0004")
	})

	it("normalizes a top-level auth error", async () => {
		fetch.mockResolvedValue(
			respond({ ok: false, status: 401, json: { ErrorMessage: "API key invalid" } })
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("API key invalid")
	})
})

describe("Elastic Email", () => {
	const mail = () => new ElasticEmail({ api_key: "ee_key", default: { from: "from@test.com" } })

	it("posts to the transactional endpoint with To/CC/BCC and a Body array", async () => {
		fetch.mockResolvedValue(respond({ json: { MessageID: "msg-1", TransactionID: "tx-1" } }))
		const result = await mail().send({
			to: "to@test.com",
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Custom": "1" },
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://api.elasticemail.com/v4/emails/transactional")
		expect(sent_init().headers).toMatchObject({ "X-ElasticEmail-ApiKey": "ee_key" })
		const body = sent_json()
		expect(body.Recipients).toEqual({
			To: ["to@test.com"],
			CC: ["cc@test.com"],
			BCC: ["bcc@test.com"],
		})
		expect(body.Content.From).toBe("from@test.com")
		expect(body.Content.ReplyTo).toBe("reply@test.com")
		expect(body.Content.Subject).toBe("Hi")
		expect(body.Content.Body).toEqual([
			{ ContentType: "HTML", Content: "<p>x</p>", Charset: "utf-8" },
			{ ContentType: "PlainText", Content: "x", Charset: "utf-8" },
		])
		expect(body.Content.Headers).toEqual({ "X-Custom": "1" })
		expect(body.Content.Attachments).toEqual([
			{ BinaryContent: b64("filedata"), Name: "doc.pdf", ContentType: "application/pdf" },
		])
		expect(result).toEqual({ message_id: "msg-1", transaction_id: "tx-1" })
	})

	it("detects errors", async () => {
		fetch.mockResolvedValue(respond({ ok: false, status: 400, json: { Error: "Invalid email" } }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("elasticemail")
		expect(error.message).toBe("Invalid email")
	})
})

describe("resilience (shared base)", () => {
	const make = (opts = {}) =>
		new Resend({ api_key: "k", default: { from: "from@test.com" }, retry_delay: 0, ...opts })

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

	it("forwards scheduled_at as an ISO string", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))
		const when = new Date("2030-01-01T00:00:00.000Z")
		await make().send({ to: "to@test.com", body: "x", scheduled_at: when })
		expect(sent_json().scheduled_at).toBe(when.toISOString())
	})

	it("rejects an invalid scheduled_at", async () => {
		const error = await caught(make().send({ to: "to@test.com", body: "x", scheduled_at: "nope" }))
		expect(error.message).toContain("Invalid scheduled_at")
	})

	it("accepts a relative Duration for scheduled_at", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "1" } }))
		const before = Date.now()
		await make().send({ to: "to@test.com", body: "x", scheduled_at: { days: 1, hours: 5 } })
		const sent = new Date(sent_json().scheduled_at).getTime()
		// 1 day + 5 hours from "now" (calendar arithmetic ≈ 29h with no DST boundary crossed).
		expect(Math.abs(sent - (before + 29 * 60 * 60 * 1000))).toBeLessThan(60_000)
	})
})

describe("scheduled_at provider formats", () => {
	const when = new Date("2030-01-01T00:00:00.000Z")

	it("SendGrid uses a unix-seconds send_at", async () => {
		fetch.mockResolvedValue(respond({ status: 202 }))
		await new SendGrid({ api_key: "k", default: { from: "from@test.com" } }).send({
			to: "to@test.com",
			body: "x",
			scheduled_at: when,
		})
		expect(sent_json().send_at).toBe(Math.floor(when.getTime() / 1000))
	})

	it("Brevo uses an ISO scheduledAt", async () => {
		fetch.mockResolvedValue(respond({ json: { messageId: "1" } }))
		await new Brevo({ api_key: "k", default: { from: "from@test.com" } }).send({
			to: "to@test.com",
			body: "x",
			scheduled_at: when,
		})
		expect(sent_json().scheduledAt).toBe(when.toISOString())
	})

	it("Mailgun uses an RFC 2822 o:deliverytime", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "1", message: "ok" } }))
		await new Mailgun({
			api_key: "k",
			domain: "mg.test.com",
			default: { from: "from@test.com" },
		}).send({ to: "to@test.com", body: "x", scheduled_at: when })
		const form = sent_init().body as FormData
		expect(form.get("o:deliverytime")).toBe(when.toUTCString())
	})
})

describe("Loops", () => {
	const mail = () => new Loops({ api_key: "loops_key", transactional_id: "clx_tpl" })

	it("hands the send over as data variables for the transactional template", async () => {
		fetch.mockResolvedValue(respond({ json: { success: true } }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			from: "Acme <from@test.com>",
			subject: "Hi {name}",
			body: "<p>x</p>",
			text: "x",
			idempotency_key: "idem-1",
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://app.loops.so/api/v1/transactional")
		expect(sent_init().headers).toMatchObject({
			Authorization: "Bearer loops_key",
			"Idempotency-Key": "idem-1",
		})
		const body = sent_json()
		expect(body.transactionalId).toBe("clx_tpl")
		expect(body.email).toBe("to@test.com")
		expect(body.dataVariables).toEqual({
			subject: "Hi {name}",
			from: "Acme <from@test.com>",
			html: "<p>x</p>",
			text: "x",
			name: "To",
		})
		expect(body.attachments).toEqual([
			{ filename: "doc.pdf", contentType: "application/pdf", data: b64("filedata") },
		])
		expect(result).toEqual({ success: true })
	})

	it("needs no from, and refuses several recipients rather than guessing", async () => {
		fetch.mockResolvedValue(respond({ json: { success: true } }))
		await mail().send({ to: "to@test.com", subject: "Hi", body: "x" })
		expect(sent_json().dataVariables.from).toBeUndefined()

		const error = await caught(mail().send({ to: ["a@test.com", "b@test.com"], body: "x" }))
		expect(error.code).toBe("single_recipient")
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("reads Loops' error envelope", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 400,
				json: {
					success: false,
					message: "Missing required data variable(s): confirmationUrl",
					error: { path: "dataVariables", message: "Missing required data variable(s)" },
				},
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("loops")
		expect(error.message).toBe("Missing required data variable(s): confirmationUrl")
		expect(error.code).toBe("dataVariables")
	})
})

describe("MailChannels", () => {
	const mail = () => new MailChannels({ api_key: "mc_key", default: { from: "from@test.com" } })

	it("maps a send to one personalization with both content parts", async () => {
		fetch.mockResolvedValue(respond({ status: 202, json: { request_id: "req_1" } }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "Support <reply@test.com>",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tracking: { opens: true, clicks: false },
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://api.mailchannels.net/tx/v1/send")
		expect(sent_init().headers).toMatchObject({ "X-Api-Key": "mc_key" })
		const body = sent_json()
		expect(body.personalizations).toEqual([
			{
				to: [{ email: "to@test.com", name: "To" }],
				cc: [{ email: "cc@test.com" }],
				bcc: [{ email: "bcc@test.com" }],
			},
		])
		expect(body.from).toEqual({ email: "from@test.com" })
		expect(body.reply_to).toEqual({ email: "reply@test.com", name: "Support" })
		expect(body.content).toEqual([
			{ type: "text/plain", value: "x" },
			{ type: "text/html", value: "<p>x</p>" },
		])
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.tracking_settings).toEqual({
			open_tracking: { enable: true },
			click_tracking: { enable: false },
		})
		expect(body.attachments).toEqual([
			{ filename: "doc.pdf", content: b64("filedata"), type: "application/pdf" },
		])
		expect(result).toEqual({ request_id: "req_1" })
	})

	it("signs with a DKIM key when given one, and reads the errors array", async () => {
		fetch.mockResolvedValue(respond({ status: 202, json: {} }))
		await new MailChannels({
			api_key: "mc_key",
			dkim: { domain: "test.com", selector: "mc", private_key: "PEM" },
			default: { from: "from@test.com" },
		}).send({ to: "to@test.com", body: "x" })
		expect(sent_json().personalizations[0]).toMatchObject({
			dkim_domain: "test.com",
			dkim_selector: "mc",
			dkim_private_key: "PEM",
		})

		fetch.mockResolvedValue(
			respond({ ok: false, status: 400, json: { errors: ["from address is invalid"] } })
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("mailchannels")
		expect(error.message).toBe("from address is invalid")
	})
})

describe("SMTP2GO", () => {
	const mail = () => new SMTP2GO({ api_key: "api-key", default: { from: "From <from@test.com>" } })
	const accepted = {
		request_id: "req_1",
		data: { succeeded: 1, failed: 0, failures: [], email_id: "1a2b3c" },
	}

	it("maps a send to the v3 endpoint, reply-to as a custom header", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			scheduled_at: "2030-01-01T10:00:00Z",
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://api.smtp2go.com/v3/email/send")
		expect(sent_init().headers).toMatchObject({ "X-Smtp2go-Api-Key": "api-key" })
		const body = sent_json()
		expect(body.sender).toBe("From <from@test.com>")
		expect(body.to).toEqual(["To <to@test.com>"])
		expect(body.cc).toEqual(["cc@test.com"])
		expect(body.html_body).toBe("<p>x</p>")
		expect(body.text_body).toBe("x")
		expect(body.custom_headers).toEqual([
			{ header: "X-Campaign", value: "spring" },
			{ header: "Reply-To", value: "reply@test.com" },
		])
		expect(body.attachments).toEqual([
			{ filename: "doc.pdf", fileblob: b64("filedata"), mimetype: "application/pdf" },
		])
		expect(body.schedule).toBe("2030-01-01T10:00:00.000Z")
		expect(result).toEqual(accepted)
	})

	it("pins a region, and reads both error shapes", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		await new SMTP2GO({ api_key: "k", region: "eu", default: { from: "from@test.com" } }).send({
			to: "to@test.com",
			body: "x",
		})
		expect(sent_url()).toBe("https://eu-api.smtp2go.com/v3/email/send")

		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 400,
				json: {
					request_id: "r",
					data: { error: "Invalid API key", error_code: "E_ApiResponseCodes.API_KEY_INVALID" },
				},
			})
		)
		let error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("smtp2go")
		expect(error.message).toBe("Invalid API key")
		expect(error.code).toBe("E_ApiResponseCodes.API_KEY_INVALID")

		fetch.mockResolvedValue(
			respond({
				json: { data: { succeeded: 0, failed: 1, failures: ["to@test.com: suppressed"] } },
			})
		)
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("to@test.com: suppressed")
	})
})

describe("SocketLabs", () => {
	const mail = () =>
		new SocketLabs({ server_id: "12345", api_key: "sl_key", default: { from: "from@test.com" } })
	const accepted = { ErrorCode: "Success", TransactionReceipt: "rcpt_1", MessageResults: [] }

	it("injects one message with the credentials in the body", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			bcc: "bcc@test.com",
			reply_to: ["Support <reply@test.com>", "extra@test.com"],
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome", "second"],
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://inject.socketlabs.com/api/v1/email")
		const body = sent_json()
		expect(body.serverId).toBe(12345)
		expect(body.apiKey).toBe("sl_key")
		expect(body.messages).toHaveLength(1)
		const one = body.messages[0]
		expect(one.from).toEqual({ emailAddress: "from@test.com" })
		expect(one.to).toEqual([{ emailAddress: "to@test.com", friendlyName: "To" }])
		expect(one.bcc).toEqual([{ emailAddress: "bcc@test.com" }])
		expect(one.replyTo).toEqual({ emailAddress: "reply@test.com", friendlyName: "Support" })
		expect(one.htmlBody).toBe("<p>x</p>")
		expect(one.textBody).toBe("x")
		expect(one.customHeaders).toEqual([{ name: "X-Campaign", value: "spring" }])
		expect(one.mailingId).toBe("welcome")
		expect(one.attachments).toEqual([
			{ name: "doc.pdf", contentType: "application/pdf", content: b64("filedata") },
		])
		expect(result).toEqual(accepted)
	})

	it("treats any ErrorCode but Success as a refusal, even on a 200", async () => {
		fetch.mockResolvedValue(
			respond({
				json: {
					ErrorCode: "Warning",
					MessageResults: [{ Index: 0, ErrorCode: "InvalidFromAddress", AddressResults: [] }],
				},
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("socketlabs")
		expect(error.code).toBe("Warning")
		expect(error.message).toContain("InvalidFromAddress")
	})
})

describe("Azure Communication Services", () => {
	const key = Buffer.from("azure-access-key-bytes-0123456789").toString("base64")
	const mail = () =>
		new Azure({
			connection_string: `endpoint=https://acme.communication.azure.com/;accesskey=${key}`,
			default: { from: "DoNotReply@test.com" },
		})

	it("signs the request the way the Azure SDKs do and maps the message", async () => {
		fetch.mockResolvedValue(respond({ status: 202, json: { id: "op_1", status: "Running" } }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			reply_to: ["Support <reply@test.com>", "extra@test.com"],
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tracking: { opens: false, clicks: false },
			idempotency_key: "8540c0de-899f-5cce-acb5-3ec493af3800",
			attachments: attachment(),
		})
		expect(sent_url()).toBe(
			"https://acme.communication.azure.com/emails:send?api-version=2023-03-31"
		)
		const init = sent_init()
		const body = JSON.parse(init.body as string)
		expect(body).toEqual({
			senderAddress: "DoNotReply@test.com",
			content: { subject: "Hi", plainText: "x", html: "<p>x</p>" },
			recipients: {
				to: [{ address: "to@test.com", displayName: "To" }],
				cc: [{ address: "cc@test.com" }],
			},
			replyTo: [
				{ address: "reply@test.com", displayName: "Support" },
				{ address: "extra@test.com" },
			],
			headers: { "X-Campaign": "spring" },
			attachments: [
				{ name: "doc.pdf", contentType: "application/pdf", contentInBase64: b64("filedata") },
			],
			userEngagementTrackingDisabled: true,
		})
		const hash = createHash("sha256")
			.update(init.body as string)
			.digest("base64")
		expect(init.headers["x-ms-content-sha256"]).toBe(hash)
		expect(init.headers["x-ms-date"]).toMatch(/GMT$/)
		expect(init.headers["Operation-Id"]).toBe("8540c0de-899f-5cce-acb5-3ec493af3800")
		expect(init.headers.Authorization).toMatch(
			/^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=[A-Za-z0-9+/=]+$/
		)
		expect(result).toEqual({ id: "op_1", status: "Running" })
	})

	it("takes endpoint + access_key too, refuses neither, and reads the error envelope", async () => {
		fetch.mockResolvedValue(respond({ status: 202, json: { id: "op_2", status: "Running" } }))
		await new Azure({
			endpoint: "https://acme.communication.azure.com",
			access_key: key,
			default: { from: "DoNotReply@test.com" },
		}).send({ to: "to@test.com", body: "x" })
		expect(sent_json().userEngagementTrackingDisabled).toBeUndefined()

		expect(() => new Azure({ default: { from: "x@test.com" } })).toThrow(PostboiError)

		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 401,
				json: { error: { code: "Denied", message: "Access key is invalid" } },
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("azure")
		expect(error.message).toBe("Access key is invalid")
		expect(error.code).toBe("Denied")
	})
})

describe("Gmail", () => {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string

	beforeEach(() => clear_token_cache())

	const decode = (raw: string) =>
		Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")

	it("mints a delegated token for the from mailbox, then sends the MIME as raw", async () => {
		fetch
			.mockResolvedValueOnce(respond({ json: { access_token: "ya29.token", expires_in: 3600 } }))
			.mockResolvedValueOnce(respond({ json: { id: "msg_1", threadId: "thr_1" } }))
		const result = await new Gmail({
			client_email: "svc@project.iam.gserviceaccount.com",
			private_key: pem.replace(/\n/g, "\\n"),
			default: { from: "Acme <from@test.com>" },
		}).send({
			to: { address: "to@test.com", name: "To" },
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			attachments: attachment(),
		})
		expect(fetch).toHaveBeenCalledTimes(2)
		const [token_url, token_init] = fetch.mock.calls[0] as [string, RequestInit]
		expect(token_url).toBe("https://oauth2.googleapis.com/token")
		const params = token_init.body as URLSearchParams
		expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
		const claims = JSON.parse(decode(params.get("assertion")!.split(".")[1]))
		expect(claims).toMatchObject({
			iss: "svc@project.iam.gserviceaccount.com",
			sub: "from@test.com",
			scope: "https://www.googleapis.com/auth/gmail.send",
			aud: "https://oauth2.googleapis.com/token",
		})

		expect(sent_url()).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer ya29.token" })
		const raw = decode(sent_json().raw)
		expect(raw).toContain("From: Acme <from@test.com>")
		expect(raw).toContain("To: To <to@test.com>")
		expect(raw).toContain("Bcc: bcc@test.com")
		expect(raw).toContain("Reply-To: reply@test.com")
		expect(raw).toContain("Subject: Hi")
		expect(raw).toContain("X-Campaign: spring")
		expect(raw).toContain("multipart/mixed")
		expect(raw).toContain('filename="doc.pdf"')
		expect(result).toEqual({ id: "msg_1", threadId: "thr_1" })
	})

	it("reuses the token across sends, and takes a ready access_token instead", async () => {
		fetch
			.mockResolvedValueOnce(respond({ json: { access_token: "ya29.token", expires_in: 3600 } }))
			.mockResolvedValue(respond({ json: { id: "msg" } }))
		const mail = new Gmail({
			client_email: "svc@p.iam.gserviceaccount.com",
			private_key: pem,
			user: "shared@test.com",
			default: { from: "from@test.com" },
		})
		await mail.send({ to: "a@test.com", body: "x" })
		await mail.send({ to: "b@test.com", body: "x" })
		expect(fetch).toHaveBeenCalledTimes(3)
		const claims = JSON.parse(
			decode((fetch.mock.calls[0][1].body as URLSearchParams).get("assertion")!.split(".")[1])
		)
		expect(claims.sub).toBe("shared@test.com")

		fetch.mockReset()
		fetch.mockResolvedValue(respond({ json: { id: "msg_2" } }))
		await new Gmail({ access_token: "byo", default: { from: "from@test.com" } }).send({
			to: "to@test.com",
			body: "x",
		})
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer byo" })

		expect(() => new Gmail({ default: { from: "from@test.com" } })).toThrow(PostboiError)
	})

	it("reads Google's error envelope", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 403,
				json: {
					error: { code: 403, message: "Insufficient Permission", status: "PERMISSION_DENIED" },
				},
			})
		)
		const error = await caught(
			new Gmail({ access_token: "byo", default: { from: "from@test.com" } }).send({
				to: "to@test.com",
				body: "x",
			})
		)
		expect(error.provider).toBe("gmail")
		expect(error.message).toBe("Insufficient Permission")
		expect(error.code).toBe("PERMISSION_DENIED")
	})
})

describe("Maileroo", () => {
	const mail = () => new Maileroo({ api_key: "mr_key", default: { from: "from@test.com" } })
	const accepted = { success: true, message: "Email queued", data: { reference_id: "ref_1" } }

	it("maps a send to the v2 endpoint", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome"],
			tracking: { opens: true },
			scheduled_at: "2030-01-01T10:00:00Z",
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://smtp.maileroo.com/api/v2/emails")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer mr_key" })
		const body = sent_json()
		expect(body.from).toEqual({ address: "from@test.com" })
		expect(body.to).toEqual([{ address: "to@test.com", display_name: "To" }])
		expect(body.reply_to).toEqual([{ address: "reply@test.com" }])
		expect(body.html).toBe("<p>x</p>")
		expect(body.plain).toBe("x")
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.tags).toEqual({ welcome: "welcome" })
		expect(body.tracking).toBe(true)
		expect(body.scheduled_at).toBe("2030-01-01T10:00:00.000Z")
		expect(body.attachments).toEqual([
			{
				file_name: "doc.pdf",
				content_type: "application/pdf",
				content: b64("filedata"),
				inline: false,
			},
		])
		expect(result).toEqual(accepted)
	})

	it("reads a refusal from the body, whatever the status", async () => {
		fetch.mockResolvedValue(respond({ json: { success: false, message: "Domain not verified" } }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("maileroo")
		expect(error.message).toBe("Domain not verified")
	})
})

describe("AhaSend", () => {
	const mail = () =>
		new AhaSend({ api_key: "aha-sk", account_id: "acct_1", default: { from: "from@test.com" } })
	const accepted = {
		object: "list",
		data: [
			{
				object: "message",
				id: "id@test.com",
				recipient: { email: "to@test.com" },
				status: "queued",
			},
		],
	}

	it("folds cc and bcc into recipients and maps the rest", async () => {
		fetch.mockResolvedValue(respond({ status: 202, json: accepted }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "Support <reply@test.com>",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome"],
			tracking: { opens: true, clicks: false },
			scheduled_at: "2030-01-01T10:00:00Z",
			idempotency_key: "idem-1",
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://api.ahasend.com/v2/accounts/acct_1/messages")
		expect(sent_init().headers).toMatchObject({
			Authorization: "Bearer aha-sk",
			"Idempotency-Key": "idem-1",
		})
		const body = sent_json()
		expect(body.from).toEqual({ email: "from@test.com" })
		expect(body.recipients).toEqual([
			{ email: "to@test.com", name: "To" },
			{ email: "cc@test.com" },
			{ email: "bcc@test.com" },
		])
		expect(body.reply_to).toEqual({ email: "reply@test.com", name: "Support" })
		expect(body.html_content).toBe("<p>x</p>")
		expect(body.text_content).toBe("x")
		expect(body.tags).toEqual(["welcome"])
		expect(body.tracking).toEqual({ open: true, click: false })
		expect(body.schedule).toEqual({ first_attempt: "2030-01-01T10:00:00.000Z" })
		expect(body.attachments).toEqual([
			{
				file_name: "doc.pdf",
				content_type: "application/pdf",
				data: b64("filedata"),
				base64: true,
			},
		])
		expect(result).toEqual(accepted)
	})

	it("reads a request refusal, and a 202 that refused every recipient", async () => {
		fetch.mockResolvedValue(respond({ ok: false, status: 401, json: { message: "Unauthorized" } }))
		let error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("ahasend")
		expect(error.message).toBe("Unauthorized")

		fetch.mockResolvedValue(
			respond({
				status: 202,
				json: {
					object: "list",
					data: [
						{
							id: null,
							recipient: { email: "to@test.com" },
							status: "error",
							error: "recipient suppressed",
						},
					],
				},
			})
		)
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("recipient suppressed")
	})
})

describe("Postal", () => {
	const mail = () =>
		new Postal({ host: "postal.test.com", api_key: "srv_key", default: { from: "from@test.com" } })
	const accepted = {
		status: "success",
		time: 0.02,
		flags: {},
		data: {
			message_id: "abc@rp.postal.test.com",
			messages: { "to@test.com": { id: 1, token: "tok" } },
		},
	}

	it("maps a send to the installation's send endpoint", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome", "second"],
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://postal.test.com/api/v1/send/message")
		expect(sent_init().headers).toMatchObject({ "X-Server-API-Key": "srv_key" })
		const body = sent_json()
		expect(body.to).toEqual(["To <to@test.com>"])
		expect(body.cc).toEqual(["cc@test.com"])
		expect(body.from).toBe("from@test.com")
		expect(body.reply_to).toBe("reply@test.com")
		expect(body.html_body).toBe("<p>x</p>")
		expect(body.plain_body).toBe("x")
		expect(body.tag).toBe("welcome")
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.attachments).toEqual([
			{ name: "doc.pdf", content_type: "application/pdf", data: b64("filedata") },
		])
		expect(result).toEqual(accepted)
	})

	it("accepts a full URL as host, and reads a 200 whose status isn't success", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		await new Postal({
			host: "https://postal.test.com/",
			api_key: "k",
			default: { from: "from@test.com" },
		}).send({ to: "to@test.com", body: "x" })
		expect(sent_url()).toBe("https://postal.test.com/api/v1/send/message")

		fetch.mockResolvedValue(
			respond({
				json: {
					status: "error",
					data: { code: "NoRecipients", message: "There are no recipients defined" },
				},
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("postal")
		expect(error.message).toBe("There are no recipients defined")
		expect(error.code).toBe("NoRecipients")
	})
})

describe("Customer.io", () => {
	const mail = () => new CustomerIO({ api_key: "app_key", default: { from: "from@test.com" } })
	const accepted = { delivery_id: "dlv_1", queued_at: "2030-01-01T10:00:00Z" }

	it("sends raw content against the person the first recipient identifies", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			bcc: ["bcc@test.com", "bcc2@test.com"],
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tracking: { clicks: true },
			scheduled_at: "2030-01-01T10:00:00Z",
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://api.customer.io/v1/send/email")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer app_key" })
		const body = sent_json()
		expect(body.to).toBe("To <to@test.com>, cc@test.com")
		expect(body.identifiers).toEqual({ email: "to@test.com" })
		expect(body.from).toBe("from@test.com")
		expect(body.reply_to).toBe("reply@test.com")
		expect(body.bcc).toBe("bcc@test.com, bcc2@test.com")
		expect(body.body).toBe("<p>x</p>")
		expect(body.plaintext_body).toBe("x")
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.attachments).toEqual({ "doc.pdf": b64("filedata") })
		expect(body.send_at).toBe(Math.floor(Date.parse("2030-01-01T10:00:00Z") / 1000))
		expect(body.tracked).toBe(true)
		expect(result).toEqual(accepted)
	})

	it("uses the EU host on request, and reads both error shapes", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		await new CustomerIO({ api_key: "k", region: "eu", default: { from: "from@test.com" } }).send({
			to: "to@test.com",
			body: "x",
		})
		expect(sent_url()).toBe("https://api-eu.customer.io/v1/send/email")

		fetch.mockResolvedValue(
			respond({ ok: false, status: 401, json: { meta: { error: "Unauthorized request" } } })
		)
		let error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("customerio")
		expect(error.message).toBe("Unauthorized request")

		fetch.mockResolvedValue(
			respond({ ok: false, status: 400, json: { errors: [{ detail: "body is required" }] } })
		)
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("body is required")
	})
})

describe("Infobip", () => {
	const mail = () =>
		new Infobip({
			api_key: "ib_key",
			base_url: "https://xxxxx.api.infobip.com/",
			default: { from: "from@test.com" },
		})
	const accepted = {
		messages: [
			{
				to: "to@test.com",
				messageId: "msg_1",
				status: {
					groupId: 1,
					groupName: "PENDING",
					id: 26,
					name: "PENDING_ACCEPTED",
					description: "Message accepted",
				},
			},
		],
	}

	it("posts multipart form data to the account's host", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		const result = await mail().send({
			to: [{ address: "to@test.com", name: "To" }, "other@test.com"],
			cc: "cc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tracking: { opens: true, clicks: false },
			scheduled_at: "2030-01-01T10:00:00Z",
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://xxxxx.api.infobip.com/email/3/send")
		const init = sent_init()
		expect(init.headers).toMatchObject({ Authorization: "App ib_key" })
		expect(init.headers["Content-Type"]).toBeUndefined()
		const form = init.body as FormData
		expect(form.get("from")).toBe("from@test.com")
		expect(form.getAll("to")).toEqual(["To <to@test.com>", "other@test.com"])
		expect(form.getAll("cc")).toEqual(["cc@test.com"])
		expect(form.get("replyTo")).toBe("reply@test.com")
		expect(form.get("subject")).toBe("Hi")
		expect(form.get("html")).toBe("<p>x</p>")
		expect(form.get("text")).toBe("x")
		expect(form.get("headers")).toBe(JSON.stringify({ "X-Campaign": "spring" }))
		expect(form.get("trackOpens")).toBe("true")
		expect(form.get("trackClicks")).toBe("false")
		expect(form.get("sendAt")).toBe("2030-01-01T10:00:00.000Z")
		expect((form.get("attachment") as File).name).toBe("doc.pdf")
		expect(result).toEqual(accepted)
	})

	it("reads the request error envelope, and a response that rejected every recipient", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 401,
				json: {
					requestError: {
						serviceException: { messageId: "UNAUTHORIZED", text: "Invalid login details" },
					},
				},
			})
		)
		let error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("infobip")
		expect(error.message).toBe("Invalid login details")
		expect(error.code).toBe("UNAUTHORIZED")

		fetch.mockResolvedValue(
			respond({
				json: {
					messages: [
						{
							to: "to@test.com",
							messageId: "m",
							status: {
								groupId: 5,
								groupName: "REJECTED",
								id: 6,
								name: "REJECTED_DESTINATION",
								description: "Destination rejected",
							},
						},
					],
				},
			})
		)
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("Destination rejected")
	})
})

describe("SendPulse", () => {
	beforeEach(() => clear_token_cache())
	const mail = () =>
		new SendPulse({
			client_id: "cid",
			client_secret: "csecret",
			default: { from: "From <from@test.com>" },
		})

	it("exchanges the credentials for a token, then sends with the HTML base64-encoded", async () => {
		fetch
			.mockResolvedValueOnce(
				respond({ json: { access_token: "sp_token", token_type: "Bearer", expires_in: 3600 } })
			)
			.mockResolvedValue(respond({ json: { result: true, id: "email_1" } }))
		const mailer = mail()
		const result = await mailer.send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			attachments: attachment(),
		})
		const [token_url, token_init] = fetch.mock.calls[0] as [string, RequestInit]
		expect(token_url).toBe("https://api.sendpulse.com/oauth/access_token")
		expect(JSON.parse(token_init.body as string)).toEqual({
			grant_type: "client_credentials",
			client_id: "cid",
			client_secret: "csecret",
		})
		expect(sent_url()).toBe("https://api.sendpulse.com/smtp/emails")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer sp_token" })
		const body = sent_json().email
		expect(body.html).toBe(b64("<p>x</p>"))
		expect(body.text).toBe("x")
		expect(body.from).toEqual({ email: "from@test.com", name: "From" })
		expect(body.to).toEqual([{ email: "to@test.com", name: "To" }])
		expect(body.cc).toEqual([{ email: "cc@test.com" }])
		expect(body.attachments_binary).toEqual({ "doc.pdf": b64("filedata") })
		expect(result).toEqual({ result: true, id: "email_1" })

		await mailer.send({ to: "b@test.com", body: "x" })
		// The token was cached — one exchange for two sends.
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	it("reads a failed exchange, and a refusal", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 401,
				json: { error: "invalid_client", message: "Client authentication failed" },
			})
		)
		let error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("sendpulse")
		expect(error.message).toBe("Client authentication failed")

		clear_token_cache()
		fetch
			.mockResolvedValueOnce(respond({ json: { access_token: "t", expires_in: 3600 } }))
			.mockResolvedValue(
				respond({
					ok: false,
					status: 400,
					json: { is_error: true, error_code: 8, message: "Sender is not confirmed" },
				})
			)
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("Sender is not confirmed")
		expect(error.code).toBe(8)
	})
})

describe("Iterable", () => {
	const mail = () => new Iterable({ api_key: "it_key", campaign_id: "123456" })

	it("targets the campaign with the send as data fields", async () => {
		fetch.mockResolvedValue(respond({ json: { msg: "Email sent", code: "Success", params: null } }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			from: "Acme <from@test.com>",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			scheduled_at: "2030-01-01T10:00:00Z",
		})
		expect(sent_url()).toBe("https://api.iterable.com/api/email/target")
		expect(sent_init().headers).toMatchObject({ "Api-Key": "it_key" })
		const body = sent_json()
		expect(body.campaignId).toBe(123456)
		expect(body.recipientEmail).toBe("to@test.com")
		expect(body.dataFields).toEqual({
			subject: "Hi",
			from: "Acme <from@test.com>",
			html: "<p>x</p>",
			text: "x",
			name: "To",
		})
		expect(body.sendAt).toBe("2030-01-01 10:00:00")
		expect(result).toEqual({ msg: "Email sent", code: "Success", params: null })
	})

	it("merges constructor data fields, uses the EU host, and reads a non-Success code", async () => {
		fetch.mockResolvedValue(respond({ json: { msg: "ok", code: "Success" } }))
		await new Iterable({
			api_key: "k",
			campaign_id: 1,
			region: "eu",
			data_fields: { plan: "pro", subject: "ignored" },
		}).send({ to: "to@test.com", subject: "Hi", body: "x" })
		expect(sent_url()).toBe("https://api.eu.iterable.com/api/email/target")
		expect(sent_json().dataFields).toMatchObject({ plan: "pro", subject: "Hi" })

		const single = await caught(mail().send({ to: ["a@test.com", "b@test.com"], body: "x" }))
		expect(single.code).toBe("single_recipient")

		fetch.mockResolvedValue(respond({ json: { msg: "Campaign not found", code: "BadParams" } }))
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("iterable")
		expect(error.message).toBe("Campaign not found")
		expect(error.code).toBe("BadParams")
	})
})

describe("JetEmail", () => {
	const mail = () => new JetEmail({ api_key: "jet_key", default: { from: "from@test.com" } })

	it("maps a send, giving a bare sender its local part as a name", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "jet_1", response: "queued" } }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			reply_to: ["reply@test.com", "extra@test.com"],
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			idempotency_key: "idem-1",
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://api.jetemail.com/email")
		expect(sent_init().headers).toMatchObject({
			Authorization: "Bearer jet_key",
			"Idempotency-Key": "idem-1",
		})
		const body = sent_json()
		expect(body.from).toBe("from <from@test.com>")
		expect(body.to).toEqual(["To <to@test.com>"])
		expect(body.cc).toEqual(["cc@test.com"])
		expect(body.reply_to).toEqual(["reply@test.com", "extra@test.com"])
		expect(body.html).toBe("<p>x</p>")
		expect(body.text).toBe("x")
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.attachments).toEqual([{ filename: "doc.pdf", data: b64("filedata") }])
		expect(result).toEqual({ id: "jet_1", response: "queued" })
	})

	it("keeps a named sender, and reads an error", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "jet_2" } }))
		await mail().send({ to: "to@test.com", from: "Acme <from@test.com>", body: "x" })
		expect(sent_json().from).toBe("Acme <from@test.com>")

		fetch.mockResolvedValue(
			respond({ ok: false, status: 422, json: { error: "from domain is not verified" } })
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("jetemail")
		expect(error.message).toBe("from domain is not verified")
	})
})

describe("Lettr", () => {
	const mail = () => new Lettr({ api_key: "lettr_key", default: { from: "Acme <from@test.com>" } })
	const accepted = { data: { request_id: "req_1", accepted: 2, rejected: 0 } }

	it("splits names from addresses and sends bare recipients", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			reply_to: "Support <reply@test.com>",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Campaign": "spring" },
			tags: ["welcome", "second"],
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://app.lettr.com/api/emails")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer lettr_key" })
		const body = sent_json()
		expect(body.from).toBe("from@test.com")
		expect(body.from_name).toBe("Acme")
		expect(body.to).toEqual(["to@test.com"])
		expect(body.cc).toEqual(["cc@test.com"])
		expect(body.reply_to).toBe("reply@test.com")
		expect(body.reply_to_name).toBe("Support")
		expect(body.tag).toBe("welcome")
		expect(body.headers).toEqual({ "X-Campaign": "spring" })
		expect(body.attachments).toEqual([
			{ filename: "doc.pdf", content: b64("filedata"), content_type: "application/pdf" },
		])
		expect(body.scheduled_at).toBeUndefined()
		expect(result).toEqual(accepted)
	})

	it("schedules through the scheduled endpoint, and treats nobody accepted as a refusal", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		await mail().send({ to: "to@test.com", body: "x", scheduled_at: "2030-01-01T10:00:00Z" })
		expect(sent_url()).toBe("https://app.lettr.com/api/emails/scheduled")
		expect(sent_json().scheduled_at).toBe("2030-01-01T10:00:00.000Z")

		fetch.mockResolvedValue(
			respond({ json: { data: { request_id: "r", accepted: 0, rejected: 1 } } })
		)
		let error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("lettr")
		expect(error.message).toContain("rejected every recipient")

		fetch.mockResolvedValue(
			respond({ ok: false, status: 401, json: { message: "Unauthenticated." } })
		)
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("Unauthenticated.")
	})
})

describe("Primitive", () => {
	const mail = () => new Primitive({ api_key: "prim_key", default: { from: "from@test.com" } })
	const accepted = {
		success: true,
		data: { id: "prim_1", status: "queued", accepted: ["to@test.com"], rejected: [] },
	}

	it("maps a single-recipient send", async () => {
		fetch.mockResolvedValue(respond({ json: accepted }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			idempotency_key: "idem-1",
			attachments: attachment(),
		})
		expect(sent_url()).toBe("https://api.primitive.dev/v1/send-mail")
		expect(sent_init().headers).toMatchObject({
			Authorization: "Bearer prim_key",
			"Idempotency-Key": "idem-1",
		})
		const body = sent_json()
		expect(body).toEqual({
			from: "from@test.com",
			to: "To <to@test.com>",
			subject: "Hi",
			body_text: "x",
			body_html: "<p>x</p>",
			attachments: [
				{ filename: "doc.pdf", content_base64: b64("filedata"), content_type: "application/pdf" },
			],
		})
		expect(result).toEqual(accepted)
	})

	it("refuses several recipients or a cc, and reads the error envelope", async () => {
		let error = await caught(mail().send({ to: "to@test.com", cc: "cc@test.com", body: "x" }))
		expect(error.code).toBe("single_recipient")
		expect(fetch).not.toHaveBeenCalled()

		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 400,
				json: { error: { code: "invalid_from", message: "Sender not verified" } },
			})
		)
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("primitive")
		expect(error.message).toBe("Sender not verified")
		expect(error.code).toBe("invalid_from")
	})
})

describe("review fixes", () => {
	it("primitive: an empty cc or bcc is no cc or bcc", async () => {
		fetch.mockResolvedValue(respond({ json: { success: true, data: { id: "p" } } }))
		const mail = new Primitive({ api_key: "k", default: { from: "from@test.com" } })
		await mail.send({ to: "to@test.com", cc: [], bcc: [], body: "x" })
		// The untouched `_cc` input: parse_form_data hands "" through, and "" is not an
		// address — reading it as one refuses a send nobody asked to copy anyone on.
		await mail.send({ to: "to@test.com", cc: "", bcc: "", body: "x" })
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it("klaviyo: the same empty cc, on the other provider that refuses one", async () => {
		fetch.mockResolvedValue(respond({ status: 202 }))
		await new Klaviyo({ api_key: "pk_key" }).send({ to: "to@test.com", cc: "", body: "x" })
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("one-switch tracking: on when either flag is, off only when both are, otherwise left alone", async () => {
		fetch.mockResolvedValue(respond({ json: { delivery_id: "d", queued_at: "t" } }))
		const mail = new CustomerIO({ api_key: "k", default: { from: "from@test.com" } })
		await mail.send({ to: "to@test.com", body: "x", tracking: { opens: false } })
		expect(sent_json().tracked).toBeUndefined()
		await mail.send({ to: "to@test.com", body: "x", tracking: { opens: false, clicks: false } })
		expect(sent_json().tracked).toBe(false)
		await mail.send({ to: "to@test.com", body: "x", tracking: { opens: false, clicks: true } })
		expect(sent_json().tracked).toBe(true)

		fetch.mockResolvedValue(
			respond({ json: { success: true, message: "ok", data: { reference_id: "r" } } })
		)
		await new Maileroo({ api_key: "k", default: { from: "from@test.com" } }).send({
			to: "to@test.com",
			body: "x",
			tracking: { clicks: false },
		})
		expect(sent_json().tracking).toBeUndefined()
	})

	it("name-keyed attachment maps keep two files that share a name", async () => {
		fetch.mockResolvedValue(respond({ json: { delivery_id: "d", queued_at: "t" } }))
		await new CustomerIO({ api_key: "k", default: { from: "from@test.com" } }).send({
			to: "to@test.com",
			body: "x",
			attachments: [
				new File(["one"], "scan.pdf", { type: "application/pdf" }),
				new File(["two"], "scan.pdf", { type: "application/pdf" }),
				new File(["three"], "notes", { type: "" }),
				new File(["four"], "notes", { type: "" }),
			],
		})
		expect(sent_json().attachments).toEqual({
			"scan.pdf": b64("one"),
			"scan (2).pdf": b64("two"),
			notes: b64("three"),
			"notes (2)": b64("four"),
		})
	})

	it("an attachment with no known type goes out as octet-stream everywhere", async () => {
		fetch.mockResolvedValue(
			respond({ json: { success: true, message: "ok", data: { reference_id: "r" } } })
		)
		await new Maileroo({ api_key: "k", default: { from: "from@test.com" } }).send({
			to: "to@test.com",
			body: "x",
			attachments: new File(["bytes"], "blob", { type: "" }),
		})
		expect(sent_json().attachments[0].content_type).toBe("application/octet-stream")
	})

	it("mime: quotes, backslashes and non-ASCII in a filename never break the header, and long subjects fold", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "m" } }))
		const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8")
		await new Gmail({ access_token: "byo", default: { from: "from@test.com" } }).send({
			to: "to@test.com",
			subject: "Ünterwegs ".repeat(30).trim(),
			body: "x",
			attachments: [
				new File(["a"], 'Q3 "final".pdf', { type: "application/pdf" }),
				new File(["b"], "résumé.pdf", { type: "application/pdf" }),
			],
		})
		const raw = decode(sent_json().raw)
		expect(raw).toContain('filename="Q3 \\"final\\".pdf"')
		expect(raw).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")
		for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998)
		const subject = raw.match(/^Subject: ([\s\S]*?)\r\n(?=\S)/m)![1]
		for (const word of subject.split("\r\n ")) expect(word.length).toBeLessThanOrEqual(75)
		const decoded = subject
			.split(/\s+/)
			.map((w) =>
				Buffer.from(w.slice("=?UTF-8?B?".length, -"?=".length), "base64").toString("utf8")
			)
			.join("")
		expect(decoded).toBe("Ünterwegs ".repeat(30).trim())
	})
})

describe("Netcore", () => {
	const mail = () => new Netcore({ api_key: "nc_key", default: { from: "Acme <from@test.com>" } })

	it("maps the send onto one personalization", async () => {
		fetch.mockResolvedValue(
			respond({ json: { status: "success", data: { total_count: 1, message_ids: [] } } })
		)
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			headers: { "X-Custom": "1" },
			tags: ["welcome"],
			tracking: { opens: true, clicks: false },
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://emailapi.netcorecloud.net/v5.1/mail/send")
		expect(sent_init().headers).toMatchObject({ api_key: "nc_key" })
		const body = sent_json()
		expect(body.from).toEqual({ email: "from@test.com", name: "Acme" })
		expect(body.subject).toBe("Hi")
		expect(body.content).toEqual([{ type: "html", value: "<p>x</p>" }])
		expect(body.personalizations).toEqual([
			{
				to: [{ email: "to@test.com", name: "To" }],
				cc: [{ email: "cc@test.com" }],
				bcc: [{ email: "bcc@test.com" }],
				attachments: [{ name: "doc.pdf", content: b64("filedata") }],
				"x-apiheader": { "X-Custom": "1" },
			},
		])
		expect(body.reply_to).toBe("reply@test.com")
		expect(body.tags).toEqual(["welcome"])
		expect(body.settings).toEqual({ open_track: true, click_track: false })
		expect(result).toEqual({ status: "success", data: { total_count: 1, message_ids: [] } })
	})

	it("sends a text-only body as the content block, and honours the EU host", async () => {
		fetch.mockResolvedValue(respond({ json: { status: "success" } }))
		await new Netcore({ api_key: "nc_key", region: "eu", default: { from: "from@test.com" } }).send(
			{ to: "to@test.com", subject: "Hi", text: "plain only" }
		)
		expect(sent_url()).toBe("https://apieu.netcorecloud.net/v5.1/mail/send")
		expect(sent_json().content).toEqual([{ type: "html", value: "plain only" }])
	})

	it("reads whatever shape the error envelope arrived in", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 400,
				json: { status: "error", error: [{ field: "from", message: "unverified domain" }] },
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("netcore")
		expect(error.message).toBe("from: unverified domain")

		fetch.mockResolvedValue(respond({ ok: false, status: 401, json: { status: "error" } }))
		expect((await caught(mail().send({ to: "to@test.com", body: "x" }))).message).toBe(
			"netcore rejected the send"
		)
	})
})

describe("Klaviyo", () => {
	const mail = () => new Klaviyo({ api_key: "pk_key", metric: "Password reset" })

	it("files the send as an event for the flow to send", async () => {
		fetch.mockResolvedValue(respond({ status: 202 }))
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			from: "Acme <from@test.com>",
			subject: "Hi {name}",
			body: "<p>x</p>",
			text: "x",
			idempotency_key: "idem-1",
		})

		expect(sent_url()).toBe("https://a.klaviyo.com/api/events")
		expect(sent_init().headers).toMatchObject({
			Authorization: "Klaviyo-API-Key pk_key",
			revision: "2026-07-15",
			"Content-Type": "application/vnd.api+json",
		})
		const attributes = sent_json().data.attributes
		expect(attributes.metric).toEqual({
			data: { type: "metric", attributes: { name: "Password reset" } },
		})
		expect(attributes.profile).toEqual({
			data: { type: "profile", attributes: { email: "to@test.com" } },
		})
		expect(attributes.properties).toEqual({
			subject: "Hi {name}",
			from: "Acme <from@test.com>",
			html: "<p>x</p>",
			text: "x",
			name: "To",
		})
		expect(attributes.unique_id).toBe("idem-1")
		// 202 with no body: the acceptance is the whole answer.
		expect(result).toEqual({ accepted: true })
	})

	it("needs no from, and refuses several recipients or a cc", async () => {
		fetch.mockResolvedValue(respond({ status: 202 }))
		await mail().send({ to: "to@test.com", subject: "Hi", body: "x" })
		expect(sent_json().data.attributes.properties.from).toBeUndefined()

		let error = await caught(mail().send({ to: ["a@test.com", "b@test.com"], body: "x" }))
		expect(error.code).toBe("single_recipient")
		error = await caught(mail().send({ to: "a@test.com", cc: "b@test.com", body: "x" }))
		expect(error.code).toBe("single_recipient")
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("reads the JSON:API error envelope", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 400,
				json: {
					errors: [
						{
							code: "invalid",
							title: "Invalid input.",
							detail: "The email address is not valid.",
							source: { pointer: "/data/attributes/profile" },
						},
					],
				},
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("klaviyo")
		expect(error.message).toBe("The email address is not valid. (/data/attributes/profile)")
		expect(error.code).toBe("invalid")
	})
})

describe("HubSpot", () => {
	const mail = () => new HubSpot({ api_key: "pat-key", email_id: "123456789" })

	it("maps the send onto the single-send shape", async () => {
		fetch.mockResolvedValue(
			respond({ json: { status: "COMPLETE", sendResult: "SENT", eventId: { id: "ev-1" } } })
		)
		const result = await mail().send({
			to: { address: "to@test.com", name: "To" },
			from: "Acme <from@test.com>",
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			idempotency_key: "idem-1",
		})

		expect(sent_url()).toBe("https://api.hubapi.com/marketing/v3/transactional/single-email/send")
		expect(sent_init().headers).toMatchObject({ Authorization: "Bearer pat-key" })
		const body = sent_json()
		expect(body.emailId).toBe(123456789)
		expect(body.message).toEqual({
			to: "to@test.com",
			from: "Acme <from@test.com>",
			cc: ["cc@test.com"],
			bcc: ["bcc@test.com"],
			replyTo: ["reply@test.com"],
			sendId: "idem-1",
		})
		expect(body.customProperties).toEqual({
			subject: "Hi",
			from: "Acme <from@test.com>",
			html: "<p>x</p>",
			text: "x",
			name: "To",
		})
		expect(result).toEqual({ status: "COMPLETE", sendResult: "SENT", eventId: { id: "ev-1" } })
	})

	it("throws on a refusal reported as a 200", async () => {
		fetch.mockResolvedValue(
			respond({ json: { status: "COMPLETE", sendResult: "INVALID_TO_ADDRESS" } })
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("hubspot")
		expect(error.code).toBe("INVALID_TO_ADDRESS")
	})

	// The retry the idempotency key was for: the mail went out on the first attempt, so the
	// send that provoked IDEMPOTENT_IGNORE succeeded too.
	it("treats the idempotent replay as the success it is", async () => {
		fetch.mockResolvedValue(
			respond({ json: { status: "COMPLETE", sendResult: "IDEMPOTENT_IGNORE" } })
		)
		const result = await mail().send({
			to: "to@test.com",
			body: "x",
			idempotency_key: "idem-1",
		})
		expect(result).toEqual({ status: "COMPLETE", sendResult: "IDEMPOTENT_IGNORE" })
	})

	it("reads HubSpot's own error envelope, and refuses several recipients", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 400,
				json: { status: "error", message: "Email 123 not found", category: "VALIDATION_ERROR" },
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("Email 123 not found")
		expect(error.code).toBe("VALIDATION_ERROR")

		expect((await caught(mail().send({ to: ["a@test.com", "b@test.com"], body: "x" }))).code).toBe(
			"single_recipient"
		)
	})
})

describe("OneSignal", () => {
	const mail = () =>
		new OneSignal({
			api_key: "os_key",
			app_id: "app-1",
			preheader: "A peek",
			default: { from: "Acme <from@test.com>" },
		})

	it("maps the send onto an email message", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "n-1", recipients: 2 } }))
		const result = await mail().send({
			to: "to@test.com",
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "reply@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			scheduled_at: new Date("2026-01-01T09:00:00.000Z"),
			tracking: { clicks: false },
		})

		expect(sent_url()).toBe("https://api.onesignal.com/notifications")
		expect(sent_init().headers).toMatchObject({ Authorization: "Key os_key" })
		const body = sent_json()
		expect(body.app_id).toBe("app-1")
		expect(body.target_channel).toBe("email")
		// No cc on OneSignal — a copy each, rather than a copy silently lost.
		expect(body.email_to).toEqual(["to@test.com", "cc@test.com"])
		expect(body.email_bcc).toEqual(["bcc@test.com"])
		expect(body.email_subject).toBe("Hi")
		expect(body.email_body).toBe("<p>x</p>")
		expect(body.email_from_name).toBe("Acme")
		expect(body.email_from_address).toBe("from@test.com")
		expect(body.email_reply_to_address).toBe("reply@test.com")
		expect(body.email_preheader).toBe("A peek")
		expect(body.include_unsubscribed).toBe(true)
		expect(body.disable_email_click_tracking).toBe(true)
		expect(body.send_after).toBe("2026-01-01T09:00:00.000Z")
		expect(result).toEqual({ id: "n-1", recipients: 2 })
	})

	it("respects the list when include_unsubscribed is turned off", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "n-2" } }))
		await new OneSignal({ api_key: "os_key", app_id: "app-1", include_unsubscribed: false }).send({
			to: "to@test.com",
			subject: "Hi",
			body: "x",
		})
		expect(sent_json().include_unsubscribed).toBe(false)
	})

	it("throws on the 200 that reached nobody, and on an errors array", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "", recipients: 0 } }))
		let error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("onesignal")
		expect(error.message).toMatch(/reached no recipients/)

		fetch.mockResolvedValue(
			respond({ ok: false, status: 400, json: { errors: ["Invalid app_id format"] } })
		)
		error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.message).toBe("Invalid app_id format")
	})

	// An empty list is not the map form: it is an accepted send with nothing to complain of.
	it("lets an empty errors list through as the success it is", async () => {
		fetch.mockResolvedValue(respond({ json: { id: "n-3", recipients: 1, errors: [] } }))
		const result = await mail().send({ to: "to@test.com", body: "x" })
		expect(result).toEqual({ id: "n-3", recipients: 1, errors: [] })
	})
})

describe("Alibaba Cloud Direct Mail", () => {
	const mail = () =>
		new AlibabaDirectMail({
			access_key_id: "LTAIEXAMPLE",
			access_key_secret: "secret",
			region: "ap-southeast-1",
			default: { from: "Acme <from@test.com>" },
		})

	/** The form body Direct Mail was posted, as a plain object. */
	function sent_form(): Record<string, string> {
		const init = fetch.mock.calls.at(-1)![1] as RequestInit
		return Object.fromEntries(new URLSearchParams(init.body as string))
	}

	it("maps the send onto SingleSendMail parameters", async () => {
		fetch.mockResolvedValue(respond({ json: { EnvId: "env-1", RequestId: "req-1" } }))
		const result = await mail().send({
			to: "to@test.com",
			cc: "cc@test.com",
			bcc: "bcc@test.com",
			reply_to: "Support <reply@test.com>",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			tags: ["welcome", "ignored"],
			tracking: { clicks: true },
		})

		expect(sent_url()).toBe("https://dm.ap-southeast-1.aliyuncs.com/")
		expect(sent_init().headers).toMatchObject({
			"Content-Type": "application/x-www-form-urlencoded",
		})
		const form = sent_form()
		expect(form.Action).toBe("SingleSendMail")
		expect(form.AccountName).toBe("from@test.com")
		expect(form.FromAlias).toBe("Acme")
		expect(form.AddressType).toBe("1")
		// No cc or bcc of its own: every address becomes a recipient.
		expect(form.ToAddress).toBe("to@test.com,cc@test.com,bcc@test.com")
		expect(form.Subject).toBe("Hi")
		expect(form.HtmlBody).toBe("<p>x</p>")
		expect(form.TextBody).toBe("x")
		expect(form.ReplyToAddress).toBe("true")
		expect(form.ReplyAddress).toBe("reply@test.com")
		expect(form.ReplyAddressAlias).toBe("Support")
		expect(form.TagName).toBe("welcome")
		expect(form.ClickTrace).toBe("1")
		expect(form.Version).toBe("2015-11-23")
		expect(form.RegionId).toBe("ap-southeast-1")
		expect(form.SignatureMethod).toBe("HMAC-SHA1")
		expect(form.Timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
		expect(result).toEqual({ EnvId: "env-1", RequestId: "req-1" })
	})

	it("signs the request the way Alibaba's RPC scheme says", async () => {
		fetch.mockResolvedValue(respond({ json: { EnvId: "env-1" } }))
		await mail().send({ to: "to@test.com", subject: "It's here (now)", body: "<p>x</p>" })

		const form = sent_form()
		const { Signature, ...params } = form
		// Recomputed independently of the provider: ordering, the encoding of the awkward
		// characters, the `POST&%2F&` prefix and the trailing `&` on the key all matter.
		const encode = (v: string) =>
			encodeURIComponent(v).replace(
				/[!'()*]/g,
				(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
			)
		const canonical = Object.keys(params)
			.sort()
			.map((k) => `${encode(k)}=${encode(params[k])}`)
			.join("&")
		const expected = createHmac("sha1", "secret&")
			.update(`POST&${encode("/")}&${encode(canonical)}`)
			.digest("base64")
		expect(Signature).toBe(expected)
	})

	it("reads the RPC error envelope", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 400,
				json: {
					RequestId: "req-1",
					HostId: "dm.aliyuncs.com",
					Code: "InvalidMailAddress.NotFound",
					Message: "The specified mail address does not exist.",
				},
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("alibaba")
		expect(error.message).toBe("The specified mail address does not exist.")
		expect(error.code).toBe("InvalidMailAddress.NotFound")
	})
})

describe("Yandex Cloud Postbox", () => {
	const mail = () =>
		new YandexPostbox({
			access_key_id: "YCAJEEXAMPLE",
			secret_access_key: "secret",
			default: { from: "from@test.com" },
		})

	it("speaks the SES v2 wire format against Postbox's endpoint", async () => {
		fetch.mockResolvedValue(respond({ json: { MessageId: "yc-1" } }))
		const result = await mail().send({
			to: "to@test.com",
			cc: "cc@test.com",
			subject: "Hi",
			body: "<p>x</p>",
			text: "x",
			attachments: attachment(),
		})

		expect(sent_url()).toBe("https://postbox.cloud.yandex.net/v2/email/outbound-emails")
		// Signed as `ses` in ru-central1 — Postbox implements Amazon's API, credentials and all.
		expect(sent_init().headers.Authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=YCAJEEXAMPLE\/\d{8}\/ru-central1\/ses\/aws4_request, /
		)
		const body = sent_json()
		expect(body.FromEmailAddress).toBe("from@test.com")
		expect(body.Destination).toEqual({
			ToAddresses: ["to@test.com"],
			CcAddresses: ["cc@test.com"],
		})
		expect(body.Content.Simple.Body).toEqual({ Html: { Data: "<p>x</p>" }, Text: { Data: "x" } })
		expect(body.Content.Simple.Attachments).toEqual([
			{
				RawContent: b64("filedata"),
				FileName: "doc.pdf",
				ContentType: "application/pdf",
				ContentDisposition: "ATTACHMENT",
			},
		])
		expect(result).toEqual({ MessageId: "yc-1" })
	})

	it("reads the shared error shape, attributed to yandex", async () => {
		fetch.mockResolvedValue(
			respond({
				ok: false,
				status: 400,
				json: { message: "Sender address is not verified" },
				headers: { "x-amzn-errortype": "MessageRejected:" },
			})
		)
		const error = await caught(mail().send({ to: "to@test.com", body: "x" }))
		expect(error.provider).toBe("yandex")
		expect(error.message).toBe("Sender address is not verified")
		expect(error.code).toBe("MessageRejected")
	})
})
