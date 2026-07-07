import { describe, it, expect } from "vitest"
import { special_fields, ensure_captcha_script, honeypot_style } from "$library/form.js"
import { HONEYPOT_FIELD } from "$library/captcha.js"

describe("MailForm plumbing", () => {
	it("maps set field props to hidden-input pairs, skipping unset ones", () => {
		expect(
			special_fields({ subject: "Contact", reply_to: "ada@example.com", to: "", cc: undefined })
		).toEqual([
			["_subject", "Contact"],
			["_reply_to", "ada@example.com"],
		])
		expect(special_fields({})).toEqual([])
	})

	it("orders every supported field consistently", () => {
		const names = special_fields({
			subject: "s",
			to: "t",
			from: "f",
			reply_to: "r",
			cc: "c",
			bcc: "b",
		}).map(([name]) => name)
		expect(names).toEqual(["_subject", "_to", "_from", "_reply_to", "_cc", "_bcc"])
	})

	it("ensure_captcha_script is a no-op without a DOM (SSR)", () => {
		expect(() => ensure_captcha_script("pk_test")).not.toThrow()
	})

	it("hides the honeypot without display: none", () => {
		expect(honeypot_style).toContain("position:absolute")
		expect(honeypot_style).not.toContain("display")
		expect(HONEYPOT_FIELD).toBe("🍯")
	})
})
