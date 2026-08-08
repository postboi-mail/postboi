import { describe, it, expect } from "vitest"
import { to_e164, dialling_code, segments, is_gsm7 } from "./phone.js"
import { PostboiError } from "../errors.js"

describe("to_e164", () => {
	it("passes through international numbers regardless of country", () => {
		expect(to_e164("+447788223344")).toBe("+447788223344")
		expect(to_e164("+1 (555) 000-1111")).toBe("+15550001111")
		expect(to_e164("+44 7788 223344", "US")).toBe("+447788223344")
	})

	it("treats a 00 prefix as international", () => {
		expect(to_e164("00447788223344")).toBe("+447788223344")
		expect(to_e164("00 44 7788 223344")).toBe("+447788223344")
	})

	it("strips the trunk prefix from a national number", () => {
		expect(to_e164("07788223344", "GB")).toBe("+447788223344")
		expect(to_e164("07788 223344", "GB")).toBe("+447788223344")
	})

	it("keeps the leading zero for Italy, where it is part of the number", () => {
		// +39 02… is a Milan landline; stripping the zero reaches nobody.
		expect(to_e164("02 1234 5678", "IT")).toBe("+390212345678")
		expect(to_e164("021234 5678", "+39")).toBe("+390212345678")
	})

	it("accepts a dialling code as the country, with or without the plus", () => {
		expect(to_e164("07788223344", "+44")).toBe("+447788223344")
		expect(to_e164("07788223344", "44")).toBe("+447788223344")
	})

	it("prepends the country code to a national number with no trunk prefix", () => {
		expect(to_e164("5550001111", "US")).toBe("+15550001111")
	})

	// The case that motivated the whole helper: `to: 447788223344` as a bare number.
	it("does not double the country code when the digits already carry it", () => {
		expect(to_e164(447788223344, "GB")).toBe("+447788223344")
		expect(to_e164("447788223344", "GB")).toBe("+447788223344")
	})

	it("still treats a short number starting with the dialling code as national", () => {
		// 8 digits under GB: stripping "44" leaves 6, below the plausible-subscriber floor,
		// so it reads as national rather than a plus-less international number.
		expect(to_e164("44123456", "GB")).toBe("+4444123456")
	})

	it("throws rather than guessing when no country is configured", () => {
		expect(() => to_e164("07788223344")).toThrow(PostboiError)
		try {
			to_e164("07788223344")
		} catch (error) {
			expect((error as PostboiError).code).toBe("ambiguous_number")
			expect((error as PostboiError).channel).toBe("sms")
			// The message has to name both escape routes, or it isn't actionable.
			expect((error as PostboiError).message).toContain("+447788223344")
			expect((error as PostboiError).message).toContain("POSTBOI_SMS_COUNTRY")
		}
	})

	it("rejects numbers outside the E.164 length bounds", () => {
		expect(() => to_e164("+4477")).toThrow(/8 to 15 digits/)
		expect(() => to_e164("+1234567890123456")).toThrow(/8 to 15 digits/)
	})

	it("rejects an unknown country rather than falling back", () => {
		try {
			to_e164("07788223344", "ZZ")
		} catch (error) {
			expect((error as PostboiError).code).toBe("unknown_country")
			expect((error as PostboiError).message).toContain("dialling code")
		}
	})

	it("rejects junk", () => {
		expect(() => to_e164("not a number", "GB")).toThrow(PostboiError)
		expect(() => to_e164("", "GB")).toThrow(PostboiError)
	})
})

describe("dialling_code", () => {
	it("resolves ISO codes case-insensitively", () => {
		expect(dialling_code("GB")).toBe("44")
		expect(dialling_code("gb")).toBe("44")
		expect(dialling_code("US")).toBe("1")
	})

	it("passes dialling codes straight through", () => {
		expect(dialling_code("+353")).toBe("353")
		expect(dialling_code("353")).toBe("353")
	})
})

describe("segments", () => {
	it("counts a short GSM-7 message as one segment", () => {
		const result = segments("Your code is 4291")
		expect(result).toEqual({ count: 1, encoding: "gsm7", units: 17 })
	})

	it("splits GSM-7 at 160 characters, then 153 per segment", () => {
		expect(segments("a".repeat(160)).count).toBe(1)
		expect(segments("a".repeat(161)).count).toBe(2)
		expect(segments("a".repeat(306)).count).toBe(2)
		expect(segments("a".repeat(307)).count).toBe(3)
	})

	it("charges extension characters two septets", () => {
		// A single "€" is in the GSM extension table, so it costs two units.
		expect(segments("€").units).toBe(2)
		expect(segments("a".repeat(159) + "€").count).toBe(2)
	})

	it("drops to UCS-2 for anything outside GSM-7, at 70 then 67", () => {
		expect(segments("naïve 😀")).toMatchObject({ encoding: "ucs2", count: 1 })
		expect(segments("😀".repeat(35)).count).toBe(1)
		expect(segments("😀".repeat(36)).count).toBe(2)
	})

	it("never reports zero segments for an empty body", () => {
		expect(segments("").count).toBe(1)
	})
})

describe("is_gsm7", () => {
	it("accepts the basic alphabet and the extension table", () => {
		expect(is_gsm7("Hello, world! £100 @ 50% — no")).toBe(false) // em dash is not GSM
		expect(is_gsm7("Hello, world! £100 @ 50%")).toBe(true)
		expect(is_gsm7("costs €5 [maybe]")).toBe(true)
	})

	it("rejects emoji and accented characters outside the table", () => {
		expect(is_gsm7("😀")).toBe(false)
		expect(is_gsm7("naïve")).toBe(false)
	})
})
