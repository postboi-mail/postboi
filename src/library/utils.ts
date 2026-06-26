/**
 * Small, dependency-free string helpers used when rendering FormData into the
 * email body. Kept internal to the library so Postboi ships with zero runtime
 * dependencies.
 */

/**
 * Capitalise the first character of a string and lower-case the rest.
 *
 * @example
 * capitalize("hELLO") // => "Hello"
 * capitalize("world") // => "World"
 */
export function capitalize(str: string | null | undefined): string {
	if (!str) return ""
	const lower = str.toLowerCase()
	return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Convert a string to Title Case.
 *
 * Words are split on camelCase boundaries as well as on spaces, dots, hyphens
 * and underscores, then each word is capitalised and joined with single spaces.
 *
 * @example
 * title("first_name")         // => "First Name"
 * title("queryItems")         // => "Query Items"
 * title("createControl-Item") // => "Create Control Item"
 * title("va_va_boom")         // => "Va Va Boom"
 */
export function title(str: string | null | undefined): string {
	if (!str) return ""
	return str
		.split(/(?=[A-Z])|[\s._-]/)
		.map((word) => word.trim())
		.filter(Boolean)
		.map(capitalize)
		.join(" ")
}

/**
 * Derive a readable plain-text body from an HTML string. Drops `<style>`/`<script>`
 * blocks, turns block-level tags and `<br>` into line breaks, strips remaining tags,
 * decodes the common HTML entities and collapses excess whitespace.
 *
 * @example
 * html_to_text("<p>Hello</p><p>World</p>") // => "Hello\nWorld"
 */
export function html_to_text(html: string): string {
	return html
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
		.replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|table)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, " ")
		.split("\n")
		.map((line) => line.trim())
		.filter((line, i, lines) => line !== "" || lines[i - 1] !== "")
		.join("\n")
		.trim()
}
