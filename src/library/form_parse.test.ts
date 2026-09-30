import { describe, it, expect } from "vitest"
import {
	parse_form,
	SPECIAL_FIELDS,
	FORM_ADDRESSING,
	HONEYPOT_FIELDS,
	CAPTCHA_FIELDS,
} from "$library/postboi.js"
import Mock from "$library/mock.js"

function post(entries: Array<[string, string | File]>) {
	const form = new FormData()
	for (const [key, value] of entries) form.append(key, value)
	return form
}

describe("parse_form from the package root", () => {
	it("renders a post exactly as a send does", async () => {
		const entries: Array<[string, string]> = [
			["_subject", "Quote"],
			["_form", "Contact"],
			["contact→name", "Ada <b>"],
			["message", "line one\nline two"],
			["interest", "web"],
			["interest", "print"],
		]
		const parsed = parse_form(post(entries))
		expect(parsed.options.subject).toBe("Quote")
		expect(parsed.options.form).toBe("Contact")
		expect(parsed.fields).toEqual(entries.slice(2))

		const provider = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		await provider.send({ body: post(entries) })
		expect(provider.last?.html).toBe(parsed.options.body)
	})

	it("takes its own escaping and limits", () => {
		const file = new File(["x"], "a.txt")
		const parsed = parse_form(
			post([
				["name", "Ada <b>"],
				["message", "x".repeat(10)],
				["extra", "dropped"],
				["one", file],
				["two", file],
			]),
			{
				escape_value: (value) => value.replace(/</g, "&lt;").toUpperCase(),
				max_fields: 2,
				max_value_length: 4,
				max_files: 1,
			}
		)
		expect(parsed.fields).toEqual([
			["name", "Ada "],
			["message", "xxxx"],
		])
		expect(parsed.options.body).toContain("ADA ")
		expect(parsed.options.body).not.toContain("dropped")
		expect(parsed.attachments).toHaveLength(1)
	})

	it("names the fields it treats specially", () => {
		expect(SPECIAL_FIELDS).toContain("_form")
		expect(FORM_ADDRESSING).toEqual(["_to", "_cc", "_bcc", "_from"])
		expect(HONEYPOT_FIELDS).toEqual(["_honey"])
		expect(CAPTCHA_FIELDS).toEqual(["cf-turnstile-response", "_captcha"])
	})
})
