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
