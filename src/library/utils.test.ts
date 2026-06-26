import { describe, it, expect } from "vitest"
import { capitalize, title, html_to_text } from "$library/utils.js"

describe("capitalize", () => {
	it("capitalises the first letter and lower-cases the rest", () => {
		expect(capitalize("hELLO")).toBe("Hello")
		expect(capitalize("world")).toBe("World")
		expect(capitalize("ABC")).toBe("Abc")
	})

	it("handles single characters", () => {
		expect(capitalize("a")).toBe("A")
		expect(capitalize("Z")).toBe("Z")
	})

	it("returns an empty string for empty/nullish input", () => {
		expect(capitalize("")).toBe("")
		expect(capitalize(null)).toBe("")
		expect(capitalize(undefined)).toBe("")
	})
})

describe("title", () => {
	it("title-cases space separated words", () => {
		expect(title("hello world")).toBe("Hello World")
	})

	it("splits snake_case", () => {
		expect(title("first_name")).toBe("First Name")
		expect(title("va_va_boom")).toBe("Va Va Boom")
		expect(title("reply_to")).toBe("Reply To")
	})

	it("splits kebab-case", () => {
		expect(title("root-hook")).toBe("Root Hook")
	})

	it("splits dotted paths", () => {
		expect(title("user.name")).toBe("User Name")
	})

	it("splits camelCase on capital boundaries", () => {
		expect(title("queryItems")).toBe("Query Items")
		expect(title("HelloWorld")).toBe("Hello World")
	})

	it("splits mixed separators and casing", () => {
		expect(title("createControl-Item")).toBe("Create Control Item")
	})

	it("treats each capital as a word boundary", () => {
		expect(title("ABCTest")).toBe("A B C Test")
	})

	it("leaves digits attached to their word", () => {
		expect(title("foo123bar")).toBe("Foo123bar")
	})

	it("collapses surrounding and repeated whitespace", () => {
		expect(title("  spaced  out ")).toBe("Spaced Out")
	})

	it("title-cases a single word", () => {
		expect(title("contact")).toBe("Contact")
		expect(title("a")).toBe("A")
	})

	it("returns an empty string for empty/nullish input", () => {
		expect(title("")).toBe("")
		expect(title(null)).toBe("")
		expect(title(undefined)).toBe("")
	})
})

describe("html_to_text", () => {
	it("turns block-level tags into line breaks", () => {
		expect(html_to_text("<p>Hello</p><p>World</p>")).toBe("Hello\nWorld")
	})

	it("converts <br> to newlines", () => {
		expect(html_to_text("Line one<br>Line two")).toBe("Line one\nLine two")
	})

	it("strips inline tags and keeps the text", () => {
		expect(html_to_text("<strong>Bold</strong> and <em>italic</em>")).toBe("Bold and italic")
	})

	it("drops style and script blocks entirely", () => {
		expect(html_to_text("<style>p{color:red}</style><p>Hi</p>")).toBe("Hi")
		expect(html_to_text("<script>alert(1)</script><p>Hi</p>")).toBe("Hi")
	})

	it("decodes common HTML entities", () => {
		expect(html_to_text("<p>Tom &amp; Jerry &lt;3</p>")).toBe("Tom & Jerry <3")
	})

	it("collapses excess whitespace and blank lines", () => {
		expect(html_to_text("<p>One</p><p></p><p>Two</p>")).toBe("One\n\nTwo")
	})
})
