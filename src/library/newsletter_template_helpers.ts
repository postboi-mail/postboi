// Pure date/filter rules aligned with the hosted newsletter renderer.
/**
 * The filters and helpers a `{placeholder}` can carry, and the one place they are
 * described — the drawer that documents them is drawn from these tables, so the help
 * cannot drift from what the engine does.
 *
 * Two additions to `{key}`:
 *
 *   {form|lower}                a filter: the value, put through something
 *   {$date|format:D MMM YYYY}   a helper: a value the service supplies
 *
 * **A segment after `|` is a filter when its name is one, and the fallback otherwise.**
 * That is the whole rule, and it is what lets `{name|there}` keep meaning "there when
 * there is no name" while `{form|lower}` means "the form's name, lower-cased". They can
 * be chained and mixed — `{name|there|title}` — because a fallback is a value and a
 * filter is something done to one. The cost is that a fallback that happens to spell a
 * filter's name is read as the filter; the names are listed here and in the drawer, and
 * a trailing bar is the way out — `{name|first}` is the filter, `{name|first|}` is the
 * word.
 *
 * **Helpers are `$`-prefixed** so they can never collide with a form's own field names.
 * A visitor can type anything into a form and a team can call a field anything; `$` is
 * not a character `\w` matches, so no submission can shadow one of these.
 *
 * Pure, dependency-free and client-safe, like the engine it serves: a date is formatted
 * through `Intl` in a named zone rather than through a date library, because `Intl` is
 * in every runtime this ships to and already knows the calendar.
 */

/** The moment a fill is read at, and the clock it is read on. */
export interface FillContext {
	/** What "now" means — passed in so a test, a preview and a send can share one. */
	now: Date
	/** An IANA zone name. UTC unless the caller knows better. */
	zone: string
}

export function fill_context(options: Partial<FillContext> = {}): FillContext {
	return { now: options.now ?? new Date(), zone: options.zone || "UTC" }
}

/** Every date this engine writes is en-GB, the way `#library/dates.ts` settled it. */
const LOCALE = "en-GB"

/**
 * One formatter per zone, built once. Constructing an `Intl.DateTimeFormat` resolves
 * locale data, which is the expensive half; a body with six dates in it would otherwise
 * pay for that six times.
 */
const NUMERIC = new Map<string, Intl.DateTimeFormat>()
const NAMES = new Map<string, Intl.DateTimeFormat>()

function numeric_parts(date: Date, zone: string): Record<string, string> {
	let formatter = NUMERIC.get(zone)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(LOCALE, {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			// h23 and not `hour12: false`: the latter renders midnight as "24" in some
			// engines, which is a real hour nobody writes.
			hourCycle: "h23",
		})
		NUMERIC.set(zone, formatter)
	}
	const parts: Record<string, string> = {}
	for (const part of formatter.formatToParts(date)) parts[part.type] = part.value
	return parts
}

function named_parts(date: Date, zone: string): Record<string, string> {
	let formatter = NAMES.get(zone)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(LOCALE, {
			timeZone: zone,
			weekday: "long",
			month: "long",
		})
		NAMES.set(zone, formatter)
	}
	const parts: Record<string, string> = {}
	for (const part of formatter.formatToParts(date)) parts[part.type] = part.value
	return parts
}

/** 1 → 1st, 2 → 2nd, 11 → 11th. dayjs spells this `Do`. */
function ordinal(day: number): string {
	if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`
	return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`
}

/**
 * The tokens, longest first — `YYYY` has to be tried before `YY`, and `Do` before `D`,
 * or the shorter one eats the start of the longer. `[literal]` is dayjs's escape, for
 * the day someone wants the letter and not the token.
 */
const TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|Do|D|HH|H|hh|h|mm|m|ss|s|A|a/g

/** A date in dayjs's own format vocabulary, read on the context's clock. */
export function format_date(date: Date, pattern: string, zone: string): string {
	const n = numeric_parts(date, zone)
	const named = named_parts(date, zone)
	const hour = Number(n.hour)
	const twelve = hour % 12 === 0 ? 12 : hour % 12
	return pattern.replace(TOKENS, (token, literal: string | undefined) => {
		if (literal !== undefined) return literal
		switch (token) {
			case "YYYY":
				return n.year
			case "YY":
				return n.year.slice(-2)
			case "MMMM":
				return named.month
			case "MMM":
				return named.month.slice(0, 3)
			case "MM":
				return n.month
			case "M":
				return String(Number(n.month))
			case "dddd":
				return named.weekday
			case "ddd":
				return named.weekday.slice(0, 3)
			case "DD":
				return n.day
			case "Do":
				return ordinal(Number(n.day))
			case "D":
				return String(Number(n.day))
			case "HH":
				return n.hour
			case "H":
				return String(hour)
			case "hh":
				return String(twelve).padStart(2, "0")
			case "h":
				return String(twelve)
			case "mm":
				return n.minute
			case "m":
				return String(Number(n.minute))
			case "ss":
				return n.second
			case "s":
				return String(Number(n.second))
			case "A":
				return hour < 12 ? "AM" : "PM"
			case "a":
				return hour < 12 ? "am" : "pm"
			default:
				return token
		}
	})
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** The spans `relative` counts in, longest first — the first one it fits is the one. */
const SPANS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	["year", 365 * DAY],
	["month", 30 * DAY],
	["week", WEEK],
	["day", DAY],
	["hour", HOUR],
	["minute", MINUTE],
	["second", SECOND],
]

const RELATIVE = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" })

/** "in 3 days", "2 hours ago", "yesterday" — the coarsest unit that still fits. */
export function relative_time(date: Date, now: Date): string {
	const diff = date.getTime() - now.getTime()
	for (const [unit, span] of SPANS) {
		if (Math.abs(diff) >= span || unit === "second") {
			return RELATIVE.format(Math.round(diff / span), unit)
		}
	}
	return ""
}

/** The units `add` and `subtract` take, in dayjs's own spelling. */
const UNITS: Record<string, number> = {
	s: SECOND,
	second: SECOND,
	seconds: SECOND,
	m: MINUTE,
	minute: MINUTE,
	minutes: MINUTE,
	h: HOUR,
	hour: HOUR,
	hours: HOUR,
	d: DAY,
	day: DAY,
	days: DAY,
	w: WEEK,
	week: WEEK,
	weeks: WEEK,
}

/** Months and years are calendar steps, not a number of days, so they move separately. */
const CALENDAR: Record<string, "month" | "year"> = {
	M: "month",
	month: "month",
	months: "month",
	y: "year",
	year: "year",
	years: "year",
}

/**
 * `2d`, `3 weeks`, `-1M`. Months and years step the calendar (the 31st of January plus
 * a month is the 28th of February, as every date library settles it); everything else is
 * a fixed span of milliseconds. The step is taken on the instant rather than on the
 * zone's wall clock, so an hour can slip across a daylight-saving boundary — a
 * difference worth knowing about and not worth a calendar implementation to avoid.
 */
export function shift_date(date: Date, amount: string, sign: 1 | -1): Date {
	const match = /^\s*([+-]?\d+)\s*([A-Za-z]+)\s*$/.exec(amount)
	if (!match) return date
	const count = Number(match[1]) * sign
	const unit = match[2]
	if (UNITS[unit]) return new Date(date.getTime() + count * UNITS[unit])
	const calendar = CALENDAR[unit]
	if (!calendar) return date
	const shifted = new Date(date.getTime())
	if (calendar === "year") shifted.setUTCFullYear(shifted.getUTCFullYear() + count)
	else {
		const day = shifted.getUTCDate()
		shifted.setUTCDate(1)
		shifted.setUTCMonth(shifted.getUTCMonth() + count)
		// Clamp: the 31st of a month that has 30 days is that month's last day.
		const last = new Date(
			Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)
		).getUTCDate()
		shifted.setUTCDate(Math.min(day, last))
	}
	return shifted
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** The shape this engine writes a readable date in, so it can read one back. */
const READABLE = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?$/

/**
 * A value read as a moment, or nothing — an unparseable date fills blank, the way an
 * unknown key does, rather than printing "Invalid Date" into somebody's email.
 *
 * "22 Sep 2026" is parsed here rather than handed to `new Date`, because that form is
 * one *this* engine writes: `{$date}` produces it and `{$date|add:2d}` has to read it
 * back. Date parsing outside ISO is explicitly implementation-defined, and a chain that
 * works in one runtime and returns Invalid Date in another is the kind of thing that
 * only shows up in somebody's inbox.
 */
function as_date(value: string): Date | undefined {
	const trimmed = value.trim()
	if (!trimmed) return undefined
	const readable = READABLE.exec(trimmed)
	if (readable) {
		const month = MONTHS.indexOf(readable[2].slice(0, 3).toLowerCase())
		if (month < 0) return undefined
		return new Date(
			Date.UTC(
				Number(readable[3]),
				month,
				Number(readable[1]),
				readable[4] === undefined ? 12 : Number(readable[4]),
				Number(readable[5] ?? 0)
			)
		)
	}
	// A bare day is a day, not an instant: "2026-09-22" parsed as UTC midnight is the
	// 21st for anyone west of Greenwich, so it is anchored at midday instead.
	const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
		? new Date(`${trimmed}T12:00:00Z`)
		: new Date(trimmed)
	return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * The clock a parsed value is written back on. A value that carried a time is an
 * instant, so it is read on the caller's zone. A value that was only ever a day is a
 * *civil* date, which `as_date` anchors at UTC midday — re-reading that on a zone at
 * UTC+12 or further east (Auckland, Suva, Apia) rolls it past midnight and returns
 * tomorrow, so `{$date|date}` would move a form's dates a day on every fill. A day is a
 * day: it goes back out on the clock it was anchored on.
 */
function read_zone(value: string, ctx: FillContext): string {
	return /[T:]/.test(value) ? ctx.zone : "UTC"
}

/**
 * What a moved date comes back as. A value that carried a time keeps its precision (an
 * instant, so a later `|time` is exact); a value that was only ever a day comes back a
 * day, so `{$date|add:2d}` on its own reads "24 Sep 2026" and not an ISO timestamp
 * nobody wants in an email. Both shapes go back through `as_date`, so either can chain.
 */
function same_shape(moved: Date, input: string, ctx: FillContext): string {
	return /[T:]/.test(input)
		? moved.toISOString()
		: format_date(moved, "D MMM YYYY", read_zone(input, ctx))
}

/** Words, for the filters that work on them. */
function words(value: string): Array<string> {
	return value.trim().split(/\s+/).filter(Boolean)
}

export interface Filter {
	name: string
	/** What goes after the colon, when something does — for the drawer's signature. */
	takes?: string
	summary: string
	example: string
	apply(value: string, arg: string, ctx: FillContext): string
}

/**
 * Every filter, in the order the drawer lists them: what you do to text first, then what
 * you do to a date. Each carries its own one-line description and a worked example,
 * because the drawer renders this array and nothing else.
 */
export const FILTERS: Array<Filter> = [
	{
		name: "lower",
		summary: "All lower case.",
		example: "{form|lower} → contact form",
		apply: (value) => value.toLowerCase(),
	},
	{
		name: "upper",
		summary: "ALL UPPER CASE.",
		example: "{form|upper} → CONTACT FORM",
		apply: (value) => value.toUpperCase(),
	},
	{
		name: "title",
		summary: "Every Word Capitalised.",
		example: "{name|title} → Ada Lovelace",
		apply: (value) =>
			value.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()),
	},
	{
		name: "sentence",
		summary: "First letter capitalised, the rest left alone.",
		example: "{message|sentence} → Hello there",
		apply: (value) => value.charAt(0).toUpperCase() + value.slice(1),
	},
	{
		name: "trim",
		summary: "Space off both ends.",
		example: "{name|trim}",
		apply: (value) => value.trim(),
	},
	{
		name: "first",
		summary: "The first word: a first name out of a full one.",
		example: "{name|first} → Ada",
		apply: (value) => words(value)[0] ?? "",
	},
	{
		name: "last",
		summary: "The last word.",
		example: "{name|last} → Lovelace",
		apply: (value) => words(value).at(-1) ?? "",
	},
	{
		name: "initials",
		summary: "One letter per word.",
		example: "{name|initials} → AL",
		apply: (value) =>
			words(value)
				.map((word) => word.charAt(0).toUpperCase())
				.join(""),
	},
	{
		name: "domain",
		summary: "What follows the @ of an address.",
		example: "{email|domain} → example.com",
		apply: (value) => value.split("@")[1]?.trim() ?? "",
	},
	{
		name: "truncate",
		takes: "length",
		summary: "Cut to a length, with an ellipsis when it was cut.",
		example: "{message|truncate:40}",
		apply: (value, arg) => {
			const limit = Math.max(1, Number(arg) || 60)
			return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value
		},
	},
	{
		name: "format",
		takes: "pattern",
		summary: "A date, written out. YYYY MM DD dddd MMMM HH mm A. [text] stays put.",
		example: "{$date|format:dddd D MMMM} → Tuesday 22 September",
		apply: (value, arg, ctx) => {
			const date = as_date(value)
			return date ? format_date(date, arg || "D MMM YYYY", read_zone(value, ctx)) : ""
		},
	},
	{
		name: "date",
		summary: "A date, the way the dashboard writes one.",
		example: "{$date|date} → 22 Sep 2026",
		apply: (value, _arg, ctx) => {
			const date = as_date(value)
			return date ? format_date(date, "D MMM YYYY", read_zone(value, ctx)) : ""
		},
	},
	{
		name: "time",
		summary: "A clock time.",
		example: "{$now|time} → 14:35",
		apply: (value, _arg, ctx) => {
			const date = as_date(value)
			return date ? format_date(date, "HH:mm", read_zone(value, ctx)) : ""
		},
	},
	{
		name: "relative",
		summary: "How far off it is, in words.",
		example: "{appointment|relative} → in 3 days",
		apply: (value, _arg, ctx) => {
			const date = as_date(value)
			return date ? relative_time(date, ctx.now) : ""
		},
	},
	{
		name: "add",
		takes: "2d",
		summary: "Move a date forward. s m h d w for spans, M y for calendar steps.",
		example: "{$date|add:2d} → 24 Sep 2026",
		apply: (value, arg, ctx) => {
			const date = as_date(value)
			return date ? same_shape(shift_date(date, arg, 1), value, ctx) : ""
		},
	},
	{
		name: "subtract",
		takes: "1w",
		summary: "Move a date back, in the same units as add.",
		example: "{$date|subtract:1w|format:dddd}",
		apply: (value, arg, ctx) => {
			const date = as_date(value)
			return date ? same_shape(shift_date(date, arg, -1), value, ctx) : ""
		},
	},
]

const BY_NAME = new Map(FILTERS.map((filter) => [filter.name, filter]))

/** Whether a segment after `|` names a filter — if it doesn't, it is the fallback. */
export function is_filter(name: string): boolean {
	return BY_NAME.has(name)
}

export function apply_filter(name: string, value: string, arg: string, ctx: FillContext): string {
	return BY_NAME.get(name)?.apply(value, arg, ctx) ?? value
}

export interface Helper {
	name: string
	summary: string
	example: string
	value(ctx: FillContext): string
}

/**
 * The values the service supplies, all of them the one moment the fill is happening at.
 * `$now` is that instant in full, so it is what the date filters chain off; the rest are
 * the readable spellings people actually want in a sentence.
 */
export const HELPERS: Array<Helper> = [
	{
		name: "$now",
		summary: "This moment, in full. What the date filters read.",
		example: "{$now|format:HH:mm on dddd}",
		value: (ctx) => ctx.now.toISOString(),
	},
	{
		name: "$date",
		summary: "Today.",
		example: "{$date} → 22 Sep 2026",
		value: (ctx) => format_date(ctx.now, "D MMM YYYY", ctx.zone),
	},
	{
		name: "$time",
		summary: "The time now.",
		example: "{$time} → 14:35",
		value: (ctx) => format_date(ctx.now, "HH:mm", ctx.zone),
	},
	{
		name: "$day",
		summary: "The day of the week.",
		example: "{$day} → Tuesday",
		value: (ctx) => format_date(ctx.now, "dddd", ctx.zone),
	},
	{
		name: "$month",
		summary: "The month.",
		example: "{$month} → September",
		value: (ctx) => format_date(ctx.now, "MMMM", ctx.zone),
	},
	{
		name: "$year",
		summary: "The year.",
		example: "{$year} → 2026",
		value: (ctx) => format_date(ctx.now, "YYYY", ctx.zone),
	},
]

const HELPERS_BY_NAME = new Map(HELPERS.map((helper) => [helper.name, helper]))

/** A `$name`'s value, or undefined when nothing by that name is supplied. */
export function helper_value(name: string, ctx: FillContext): string | undefined {
	return HELPERS_BY_NAME.get(name)?.value(ctx)
}
