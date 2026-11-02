// Flat campaign personalization, aligned with the hosted newsletter renderer.
import { escape_html } from "./utils.js"
import {
	apply_filter,
	fill_context,
	helper_value,
	is_filter,
	type FillContext,
} from "./newsletter_template_helpers.js"

/**
 * The notification template language — pure and dependency-free so both the server
 * (cron dispatch) and the browser (live preview in the notifications editor) render
 * with the exact same engine. `fill_template`'s `{key}` semantics plus dotted paths
 * (`{subscriber.email}`, `{new_subscribers.length}`) and Svelte-style blocks:
 *
 *     {#if new_subscribers}…{:else}…{/if}
 *     {#each new_subscribers as subscriber}…{/each}
 */

/** How a fill is read: the moment, the clock, and whether values are text or markup. */
export interface FillOptions extends Partial<FillContext> {
	/**
	 * Escape the resolved value, for a fill whose values were written by a stranger
	 * and whose result is HTML. Done here, after the filters, rather than to the vars
	 * on the way in: `upper` over a pre-escaped `&amp;` gives `&AMP;`, which is not an
	 * entity and renders as itself. A fill that puts a value inside an href — a
	 * confirmation's `{confirm_url}` — leaves this off, which is why it is an option
	 * and not the rule.
	 */
	escape?: boolean
	/** Bound expanded UTF-8 output while placeholders are being resolved. */
	max_bytes?: number
}

/**
 * One placeholder: a key, optionally `$`-prefixed, and any number of `|` segments.
 * `[^{}|]*` for a segment so a format pattern with spaces in it works and a stray brace
 * can't run a placeholder into the next one.
 */
const PLACEHOLDER = /\{(\$?\w+)((?:\|[^{}|]*)*)\}/g

/**
 * Replace flat `{key}` placeholders — the broadcast/confirmation/response dialect.
 *
 * `{key|fallback}` prints the fallback when the key is missing or blank, so a greeting
 * written for a list still reads when the address was typed by hand: "Hi {name|there},"
 * never becomes "Hi ,".
 *
 * A segment is a **filter** when it names one (`#library/template_helpers.ts` holds them
 * and their documentation) and the **fallback** otherwise, which is the whole of how
 * `{form|lower}` and `{name|there}` coexist. Both can appear: the fallback supplies a
 * value, the filters are done to whichever value there turned out to be, left to right.
 * A `$key` is a helper the service supplies rather than anything the caller passed —
 * `$` is not a `\w`, so no field a stranger types into a form can shadow one.
 */
export class TemplateLimitError extends Error {}

export function fill_template(
	text: string,
	vars: Record<string, string>,
	options: FillOptions = {}
): string {
	const ctx = fill_context(options)
	let bytes = 0,
		previous = 0
	function measure(value: string) {
		if (options.max_bytes === undefined) return
		bytes += new TextEncoder().encode(value).byteLength
		if (bytes > options.max_bytes)
			throw new TemplateLimitError("The expanded template exceeds the supported payload size.")
	}
	// The literal document is also bounded before replace can copy it.
	if (
		options.max_bytes !== undefined &&
		new TextEncoder().encode(text).byteLength > options.max_bytes
	)
		throw new TemplateLimitError("The template exceeds the supported payload size.")
	const result = text.replace(
		PLACEHOLDER,
		(whole: string, key: string, rest: string, offset: number) => {
			measure(text.slice(previous, offset))
			previous = offset + whole.length
			let value = key.startsWith("$") ? (helper_value(key, ctx) ?? "") : vars[key] || ""
			const filters: Array<[string, string]> = []
			let fallback: string | undefined
			// `rest` is "" or "|a|b"; the leading empty piece is the split's own.
			const segments = rest ? rest.slice(1).split("|") : []
			// A trailing empty segment escapes the one before it, so a fallback that happens
			// to spell a filter's name can still be written: `{name|first|}` is the word
			// "first" when there is no name, where `{name|first}` is the filter.
			const escaped = segments.length > 1 && segments.at(-1) === "" ? segments.length - 2 : -1
			for (const [index, segment] of segments.entries()) {
				const colon = segment.indexOf(":")
				const name = colon === -1 ? segment : segment.slice(0, colon)
				if (index !== escaped && is_filter(name)) {
					filters.push([name, colon === -1 ? "" : segment.slice(colon + 1)])
				} else if (fallback === undefined) fallback = segment
			}
			if (!value && fallback !== undefined) value = fallback
			for (const [name, arg] of filters) value = apply_filter(name, value, arg, ctx)
			const resolved = options.escape ? escape_html(value) : value
			measure(resolved)
			return resolved
		}
	)
	measure(text.slice(previous))
	return result
}
