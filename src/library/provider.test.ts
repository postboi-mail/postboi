import { describe, it, expect } from "vitest"
import {
	ProviderBase,
	type SendOptions,
	type MailAttachment,
	type RequestSpec,
} from "$library/index.js"

/**
 * Minimal concrete provider that exposes the protected helpers of ProviderBase
 * so the shared parsing/normalisation core can be unit-tested directly, without
 * going through a specific provider's HTTP layer.
 */
class TestProvider extends ProviderBase {
	protected readonly provider = "test"

	protected build_request(): RequestSpec {
		throw new Error("not used in these tests")
	}
	protected parse_response() {
		throw new Error("not used in these tests")
	}

	email(email: Parameters<TestProvider["parse_email_address"]>[0]) {
		return this.parse_email_address(email)
	}
	addresses(addresses: Parameters<TestProvider["parse_addresses"]>[0]) {
		return this.parse_addresses(addresses)
	}
	decode(str: string) {
		return this.decode_value(str)
	}
	form(form_data: FormData, formatter?: SendOptions["formatter"]) {
		return this.parse_form_data(form_data, formatter)
	}
	attachments(files: File | Array<File>) {
		return this.parse_attachments(files)
	}
	prepare(options: SendOptions) {
		return this.prepare_send(options)
	}
}

const b64 = (str: string) => Buffer.from(str).toString("base64")

describe("ProviderBase", () => {
	const provider = new TestProvider()

	describe("parse_email_address", () => {
		it("parses a plain string address", () => {
			expect(provider.email("darby@uilo.co")).toEqual({ address: "darby@uilo.co" })
		})

		it("trims surrounding whitespace", () => {
			expect(provider.email("  darby@uilo.co  ")).toEqual({ address: "darby@uilo.co" })
		})

		it("parses display-name format: Name <email>", () => {
			expect(provider.email("Darby Manning <darby@uilo.co>")).toEqual({
				address: "darby@uilo.co",
				name: "Darby Manning",
			})
		})

		it("parses quoted display-name format", () => {
			expect(provider.email('"Darby Manning" <darby@uilo.co>')).toEqual({
				address: "darby@uilo.co",
				name: "Darby Manning",
			})
		})

		it("passes through an object with name", () => {
			expect(provider.email({ address: "darby@uilo.co", name: "Darby" })).toEqual({
				address: "darby@uilo.co",
				name: "Darby",
			})
		})

		it("passes through an object without name", () => {
			expect(provider.email({ address: "darby@uilo.co" })).toEqual({ address: "darby@uilo.co" })
		})
	})

	describe("parse_addresses", () => {
		it("wraps a single string in an array", () => {
			expect(provider.addresses("a@test.com")).toEqual([{ address: "a@test.com" }])
		})

		it("maps an array of mixed string/object values", () => {
			expect(provider.addresses(["a@test.com", { address: "b@test.com", name: "B" }])).toEqual([
				{ address: "a@test.com" },
				{ address: "b@test.com", name: "B" },
			])
		})

		it("splits a comma-separated string into multiple addresses", () => {
			expect(provider.addresses("a@test.com, b@test.com ,c@test.com")).toEqual([
				{ address: "a@test.com" },
				{ address: "b@test.com" },
				{ address: "c@test.com" },
			])
		})

		it("drops empty segments from a comma-separated string", () => {
			expect(provider.addresses("a@test.com,,b@test.com,")).toEqual([
				{ address: "a@test.com" },
				{ address: "b@test.com" },
			])
		})
	})

	describe("decode_value", () => {
		it("returns non-base64 strings unchanged", () => {
			expect(provider.decode("custom@test.com")).toBe("custom@test.com")
		})

		it("decodes a base64 encoded value", () => {
			expect(provider.decode(b64("hello@test.com"))).toBe("hello@test.com")
		})
	})

	describe("parse_attachments", () => {
		it("converts a single File into a base64 attachment", async () => {
			const file = new File(["content"], "note.txt", { type: "text/plain" })
			const result = await provider.attachments(file)
			expect(result).toHaveLength(1)
			expect(result[0]).toEqual<MailAttachment>({
				name: "note.txt",
				content: b64("content"),
				mime_type: "text/plain",
			})
		})

		it("converts an array of Files", async () => {
			const files = [
				new File(["one"], "a.txt", { type: "text/plain" }),
				new File(["two"], "b.txt", { type: "text/plain" }),
			]
			const result = await provider.attachments(files)
			expect(result.map((a) => a.name)).toEqual(["a.txt", "b.txt"])
			expect(result[1].content).toBe(b64("two"))
		})
	})

	describe("parse_form_data", () => {
		it("extracts special header fields and removes them from the body", async () => {
			const form = new FormData()
			form.append("_to", "to@test.com")
			form.append("_from", "from@test.com")
			form.append("_reply_to", "reply@test.com")
			form.append("_cc", "cc@test.com")
			form.append("_bcc", "bcc@test.com")
			form.append("_subject", "Hello")

			const { options } = await provider.form(form)
			expect(options.to).toBe("to@test.com")
			expect(options.from).toBe("from@test.com")
			expect(options.reply_to).toBe("reply@test.com")
			expect(options.cc).toBe("cc@test.com")
			expect(options.bcc).toBe("bcc@test.com")
			expect(options.subject).toBe("Hello")
			// no non-special fields -> no rendered body
			expect(options.body).toBeUndefined()
		})

		it("decodes base64 encoded special fields", async () => {
			const form = new FormData()
			form.append("_to", b64("encoded@test.com"))
			form.append("_subject", b64("Encoded Subject"))

			const { options } = await provider.form(form)
			expect(options.to).toBe("encoded@test.com")
			expect(options.subject).toBe("Encoded Subject")
		})

		it("renders ungrouped fields into an HTML table with title-cased labels", async () => {
			const form = new FormData()
			form.append("first_name", "Darby")

			const { options } = await provider.form(form)
			expect(options.body).toContain("<table")
			// the built-in `title` helper turns "first_name" into "First Name"
			expect(options.body).toContain("First Name")
			expect(options.body).toContain("Darby")
		})

		it("groups fieldset→field keys under a header row", async () => {
			const form = new FormData()
			form.append("contact→name", "Darby")
			form.append("contact→email", "darby@uilo.co")

			const { options } = await provider.form(form)
			const body = options.body as string
			expect(body).toContain("Contact") // fieldset header (title-cased)
			expect(body).toContain("Name")
			expect(body).toContain("Email")
			expect(body).toContain("darby@uilo.co")
			// header row spans two columns
			expect(body).toContain('colspan="2"')
		})

		it("renders repeated keys as a list", async () => {
			const form = new FormData()
			form.append("interests", "svelte")
			form.append("interests", "typescript")
			form.append("interests", "oxc")

			const { options } = await provider.form(form)
			const body = options.body as string
			expect(body).toContain("<ul")
			expect(body).toContain("<li>svelte</li>")
			expect(body).toContain("<li>typescript</li>")
			expect(body).toContain("<li>oxc</li>")
		})

		it("collects non-empty file inputs as attachments", async () => {
			const form = new FormData()
			form.append("resume", new File(["pdf-bytes"], "resume.pdf", { type: "application/pdf" }))

			const { attachments } = await provider.form(form)
			expect(attachments).toHaveLength(1)
			expect(attachments[0].name).toBe("resume.pdf")
		})

		it("ignores empty file inputs", async () => {
			const form = new FormData()
			form.append("resume", new File([], "", { type: "application/octet-stream" }))

			const { attachments } = await provider.form(form)
			expect(attachments).toHaveLength(0)
		})

		it("applies custom fieldset and name formatters", async () => {
			const form = new FormData()
			form.append("contact→name", "Darby")

			const { options } = await provider.form(form, {
				fieldset: (label) => label.toUpperCase(),
				name: (label) => `[${label}]`,
			})
			const body = options.body as string
			expect(body).toContain("CONTACT")
			expect(body).toContain("[name]")
		})

		it("disables all formatting when formatter is false", async () => {
			const form = new FormData()
			form.append("contact→first_name", "Darby")

			const { options } = await provider.form(form, false)
			const body = options.body as string
			// raw, un-title-cased labels
			expect(body).toContain("contact")
			expect(body).toContain("first_name")
			expect(body).not.toContain("First Name")
		})
	})

	describe("prepare_send", () => {
		const with_defaults = new TestProvider({
			default: { from: "default-from@test.com", to: "default-to@test.com" },
		})

		it("applies default to/from when omitted", async () => {
			const result = await with_defaults.prepare({ body: "hi" })
			expect(result.to).toBe("default-to@test.com")
			expect(result.from).toBe("default-from@test.com")
		})

		it("prefers explicit to/from over defaults", async () => {
			const result = await with_defaults.prepare({
				to: "explicit-to@test.com",
				from: "explicit-from@test.com",
				body: "hi",
			})
			expect(result.to).toBe("explicit-to@test.com")
			expect(result.from).toBe("explicit-from@test.com")
		})

		it("splits the html body out of `body`", async () => {
			const result = await provider.prepare({
				to: "to@test.com",
				from: "from@test.com",
				body: "<p>Hello</p>",
			})
			expect(result.html).toBe("<p>Hello</p>")
		})

		it("defaults the subject", async () => {
			const result = await provider.prepare({ to: "to@test.com", from: "from@test.com", body: "x" })
			expect(result.subject).toBe("Mail sent from website")
		})

		it("merges extracted FormData fields, rendering the html body and attachments", async () => {
			const form = new FormData()
			form.append("_to", "form-to@test.com")
			form.append("_from", "form-from@test.com")
			form.append("message", "Hello")
			form.append("file", new File(["x"], "x.txt", { type: "text/plain" }))

			const result = await provider.prepare({ body: form })
			expect(result.to).toBe("form-to@test.com")
			expect(result.from).toBe("form-from@test.com")
			expect(typeof result.html).toBe("string")
			expect(result.attachments).toBeDefined()
		})

		it("throws when no recipient is available", async () => {
			await expect(provider.prepare({ from: "from@test.com", body: "hi" })).rejects.toThrow(
				/recipient/
			)
		})

		it("throws when no sender is available", async () => {
			await expect(provider.prepare({ to: "to@test.com", body: "hi" })).rejects.toThrow(/sender/)
		})
	})
})
