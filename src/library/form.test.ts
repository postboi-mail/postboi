import { describe, it, expect } from "vitest"
import {
	activate_captcha,
	ensure_captcha_script,
	honeypot_style,
	honeypot_style_object,
} from "$library/form.js"
import { captcha_key } from "$library/register.js"
import { HONEYPOT_FIELD } from "$library/captcha.js"

describe("Captcha component plumbing", () => {
	it("is inert without a DOM (SSR)", () => {
		expect(() => ensure_captcha_script("pk_test")).not.toThrow()
		expect(() => activate_captcha(undefined, "pk_test")).not.toThrow()
		expect(() => activate_captcha(null)).not.toThrow()
	})

	it("ships with no baked key — sync generates it into the installed package", () => {
		expect(captcha_key).toBeUndefined()
	})

	it("hides the honeypot without display: none", () => {
		expect(honeypot_style).toContain("position:absolute")
		expect(honeypot_style).not.toContain("display")
		expect(honeypot_style_object.position).toBe("absolute")
		expect(HONEYPOT_FIELD).toBe("🍯")
	})
})
