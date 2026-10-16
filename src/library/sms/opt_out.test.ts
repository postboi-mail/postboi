import { describe, it, expect } from "vitest"
import {
	is_opt_out,
	sms_keyword,
	OPT_OUT_KEYWORDS,
	OPT_IN_KEYWORDS,
	HELP_KEYWORDS,
} from "./opt_out.js"

describe("is_opt_out", () => {
	it("matches every keyword, in any case, with trailing punctuation", () => {
		for (const keyword of OPT_OUT_KEYWORDS) {
			expect(is_opt_out(keyword), keyword).toBe(true)
			expect(is_opt_out(keyword.toLowerCase()), keyword).toBe(true)
			expect(is_opt_out(`  ${keyword}. `), keyword).toBe(true)
		}
		expect(is_opt_out("Stop!")).toBe(true)
		expect(is_opt_out("ARRÊT")).toBe(true)
	})

	it("is a whole-message test — a sentence containing the word is not an opt-out", () => {
		expect(is_opt_out("Please stop texting me")).toBe(false)
		expect(is_opt_out("STOP STOP")).toBe(false)
		expect(is_opt_out("unsubscribed")).toBe(false)
		expect(is_opt_out("")).toBe(false)
		expect(is_opt_out(undefined)).toBe(false)
	})
})

describe("sms_keyword", () => {
	it("names each list's keywords, in any case, with trailing punctuation", () => {
		for (const keyword of OPT_OUT_KEYWORDS) expect(sms_keyword(keyword), keyword).toBe("stop")
		for (const keyword of OPT_IN_KEYWORDS) expect(sms_keyword(keyword), keyword).toBe("start")
		for (const keyword of HELP_KEYWORDS) expect(sms_keyword(keyword), keyword).toBe("help")
		expect(sms_keyword(" unstop! ")).toBe("start")
		expect(sms_keyword("Help?")).toBe("help")
		expect(sms_keyword("arrêt")).toBe("stop")
	})

	it("leaves YES alone, which is how people answer a confirmation", () => {
		expect(sms_keyword("YES")).toBeUndefined()
	})

	it("is a whole-message test", () => {
		expect(sms_keyword("Can you help?")).toBeUndefined()
		expect(sms_keyword("start the order")).toBeUndefined()
		expect(sms_keyword("")).toBeUndefined()
		expect(sms_keyword(null)).toBeUndefined()
	})
})
