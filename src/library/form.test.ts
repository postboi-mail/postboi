import { describe, it, expect } from "vitest"
import {
	activate_captcha,
	ensure_captcha_script,
	honeypot_style,
	honeypot_style_object,
	remote_scope,
	scope_captcha_fields,
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
		// Path-legal so SvelteKit remote forms accept it (their names must be valid JS paths).
		expect(HONEYPOT_FIELD).toBe("_honey")
	})
})

describe("remote form scope", () => {
	it("is the suffix a remote form puts on its field names", () => {
		expect(remote_scope("?/remote=l12zoe%2Fcontact")).toBe("/l12zoe/contact")
	})

	it("leaves out a .for() instance key, which field names don't carry", () => {
		expect(remote_scope("?/remote=l12zoe%2Fcontact%2F%22enquire%22")).toBe("/l12zoe/contact")
		expect(remote_scope("?/remote=l12zoe%2Fcontact%2F42")).toBe("/l12zoe/contact")
	})

	it("reads the action when the page URL already had a query", () => {
		expect(remote_scope("?page=2&/remote=l12zoe%2Fcontact")).toBe("/l12zoe/contact")
	})

	it("is empty for a form that isn't a remote form", () => {
		expect(remote_scope("/?/contact")).toBe("")
		expect(remote_scope(null)).toBe("")
	})

	it("is inert without a DOM (SSR)", () => {
		expect(scope_captcha_fields(undefined)).toBeUndefined()
	})
})
