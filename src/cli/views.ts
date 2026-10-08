import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, extname, join, resolve } from "node:path"
import { stdin, stdout } from "node:process"
import { pathToFileURL } from "node:url"
import { load_config } from "../library/config.js"
import type { ViewConfig, ViewProvider } from "../library/config.js"
import { PostboiError } from "../library/errors.js"
import { tokenize } from "../library/inspect/html.js"
import { views as views_sdk, type ParamSpec, type View, type ViewStats } from "../library/views.js"
import {
	api,
	api_file,
	ApiCommandError,
	json_output,
	respond,
	say,
	slug as slugify,
	table,
	take_flags,
} from "./api.js"
import { cloud_base, open_browser } from "./postboi.js"
import { bold, create_prompts, cyan, dim, green, yellow } from "./prompts.js"

/**
 * `postboi views`: hosted web versions of emails. `publish` reads the email's Liquid,
 * decides what each variable is (static context, a public typed param, a private feed
 * field, or a sender's system variable that must never reach the web), uploads it, and
 * prints the link in the sender's own merge syntax.
 */

export const VIEW_PROVIDERS: Array<ViewProvider> = [
	"onesignal",
	"braze",
	"iterable",
	"customerio",
	"klaviyo",
	"mailchimp",
	"sendgrid",
	"none",
]

const PROVIDER_NAME: Record<ViewProvider, string> = {
	onesignal: "OneSignal",
	braze: "Braze",
	iterable: "Iterable",
	customerio: "Customer.io",
	klaviyo: "Klaviyo",
	mailchimp: "Mailchimp",
	sendgrid: "SendGrid",
	none: "any sender",
}

// ── Detecting variables ─────────────────────────────────────────────────────

/** A variable indexing into another, `a.b[week]`: `by` is what the template wrote inside. */
export interface IndexUse {
	collection: string
	by: string
}

export interface Detected {
	/** Every path the template reads, locals included, first-seen order. */
	paths: Array<string>
	/** Names the template binds itself (`assign`, `capture`, `for`, `connected_content :save`). */
	locals: Set<string>
	/** `{% assign week = user.tags.pregnancy_week %}`: local → the path it copies. */
	aliases: Map<string, string>
	indexes: Array<IndexUse>
}

const KEYWORDS = new Set([
	"and",
	"or",
	"not",
	"contains",
	"in",
	"true",
	"false",
	"nil",
	"null",
	"empty",
	"blank",
	"with",
	"as",
	"reversed",
	"forloop",
	"tablerowloop",
])

/** One expression's tokens: strings, a pipe, a path (with the `:` after it), or anything else. */
const EXPRESSION =
	/"[^"]*"|'[^']*'|(\|)|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[[^\]]*\])*)(\s*:)?|[^\s"'|A-Za-z_]+/g

/** `{{ … }}` outputs and `{% … %}` tags, whitespace control included. */
const LIQUID = /\{\{-?([\s\S]*?)-?\}\}|\{%-?\s*([\s\S]*?)\s*-?%\}/g
/** Blocks whose insides aren't Liquid. */
const OPAQUE = /\{%-?\s*(raw|comment)\s*-?%\}[\s\S]*?\{%-?\s*end\1\s*-?%\}/g
/**
 * Braze's `${first_name}` and `custom_attribute.${week}`, read as plain paths. The same
 * shape the server's `normalise_braze` reads, so both see the same variables.
 */
const BRAZE_ATTRIBUTE = /\$\{([A-Za-z0-9_]+)\}/g

/** Paths an expression reads: filter names, named-argument keys and keywords aren't. */
function scan(expression: string, found: Detected): void {
	let after_pipe = false
	for (const match of expression.matchAll(EXPRESSION)) {
		if (match[1]) {
			after_pipe = true
			continue
		}
		const path = match[2]
		if (!path) continue
		const skip = after_pipe || match[3] !== undefined || KEYWORDS.has(path.split(/[.[]/)[0])
		after_pipe = false
		if (skip) continue
		const base = path.split("[")[0]
		found.paths.push(base)
		// Whatever indexes it is read too, and `a.b[week]` is how a param picks from context.
		for (const index of path.matchAll(/\[([^\]]*)\]/g)) {
			const inner = index[1].trim()
			if (!/^[A-Za-z_][\w.-]*$/.test(inner)) continue
			found.paths.push(inner)
			found.indexes.push({ collection: base, by: inner })
		}
	}
}

/** One `{% tag … %}`. */
function scan_tag(body: string, found: Detected): void {
	const [, name = "", rest = ""] = /^(\w+)\s*([\s\S]*)$/.exec(body) ?? []
	if (name === "liquid") {
		for (const line of rest.split("\n")) if (line.trim()) scan_tag(line.trim(), found)
		return
	}
	if (name === "assign") {
		const [, target, value = ""] = /^([\w-]+)\s*=\s*([\s\S]*)$/.exec(rest) ?? []
		if (!target) return
		found.locals.add(target)
		const copy = /^\s*([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*(?:\||$)/.exec(value)
		if (copy && !KEYWORDS.has(copy[1])) found.aliases.set(target, copy[1])
		return scan(value, found)
	}
	if (name === "capture" || name === "increment" || name === "decrement") {
		const target = /^[\w-]+/.exec(rest)?.[0]
		if (target) found.locals.add(target)
		return
	}
	if (name === "for" || name === "tablerow") {
		const [, target, collection = ""] = /^([\w-]+)\s+in\s+([\s\S]*)$/.exec(rest) ?? []
		if (target) found.locals.add(target)
		return scan(collection, found)
	}
	if (["if", "elsif", "unless", "case", "when", "echo", "cycle"].includes(name)) {
		return scan(rest, found)
	}
	// Anything else (`render`, `connected_content`, a sender's own tags) is read for the
	// outputs inside it and for what it saves.
	const saved = /:save\s+([\w-]+)/.exec(rest)?.[1]
	if (saved) found.locals.add(saved)
	for (const inner of rest.matchAll(/\{\{-?([\s\S]*?)-?\}\}/g)) scan(inner[1], found)
}

/**
 * Every variable path the email's Liquid reads, with the names it binds itself and how
 * it indexes. A tokenizer, not a parser: enough to classify, and it never throws.
 */
export function detect_variables(html: string): Detected {
	const found: Detected = { paths: [], locals: new Set(), aliases: new Map(), indexes: [] }
	const source = html.replace(OPAQUE, "").replace(BRAZE_ATTRIBUTE, "$1")
	for (const match of source.matchAll(LIQUID)) {
		if (match[1] !== undefined) scan(match[1], found)
		else scan_tag(match[2], found)
	}
	found.paths = [...new Set(found.paths)]
	return found
}

/** Does the template read this path as reader data, rather than a name it bound itself? */
function is_local(found: Detected, path: string): boolean {
	return found.locals.has(path.split(".")[0])
}

/**
 * A sender's own per-recipient variable: unsubscribe links and OneSignal's subscription
 * and message ids. Postboi never fills these, so a forwarded page can't act for the reader.
 */
export function is_system_path(path: string): boolean {
	const root = path.split(".")[0]
	return root === "subscription" || path === "message.id" || /unsub/i.test(path)
}

// ── System variables ────────────────────────────────────────────────────────

/** Where each sender writes its per-recipient system variables, in its own syntax. */
const SYSTEM_PATTERNS: Array<{ provider: ViewProvider; pattern: RegExp }> = [
	{ provider: "onesignal", pattern: /\{\{-?\s*(?:subscription\.[\w.]+|message\.id)\b[^}]*\}\}/g },
	{ provider: "braze", pattern: /\$\{[^}]*unsubscribe[^}]*\}/gi },
	{ provider: "customerio", pattern: /\{[{%]-?\s*unsubscribe_url\b[^}%]*[}%]\}/g },
	{
		provider: "klaviyo",
		pattern: /\{[{%]-?\s*(?:unsubscribe_link|unsubscribe|manage_preferences_link)\b[^}%]*[}%]\}/g,
	},
	{ provider: "mailchimp", pattern: /\*\|(?:UNSUB|UPDATE_PROFILE)\|\*/g },
	{
		provider: "iterable",
		pattern: /\{\{\s*(?:unsubscribeUrl|unsubscribeMessageTypeUrl|hostedUnsubscribeUrl)\s*\}\}/g,
	},
	{ provider: "sendgrid", pattern: /<%\s*asm_\w+\s*%>|\{\{\{?\s*unsubscribe\s*\}?\}\}/g },
]

export interface Element {
	name: string
	/** Offset of the `<` of its open tag. */
	start: number
	/** Offset just past the `>` of its open tag. */
	end: number
	line: number
	/** The open tag as written, shortened for printing. */
	tag: string
	hidden: boolean
}

export interface SystemVariable {
	provider: ViewProvider
	match: string
	index: number
	element?: Element
}

const VOID = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
])

const OPEN_TAG = /<[a-zA-Z][^\s/>]*(?:"[^"]*"|'[^']*'|[^"'>])*>/y

function tag_end(html: string, start: number): number {
	OPEN_TAG.lastIndex = start
	const match = OPEN_TAG.exec(html)
	return match ? start + match[0].length : start + 1
}

function element_at(html: string, start: number, name: string, hidden: boolean): Element {
	const end = tag_end(html, start)
	const tag = html.slice(start, end).replace(/\s+/g, " ")
	return {
		name,
		start,
		end,
		line: html.slice(0, start).split("\n").length,
		tag: tag.length > 100 ? `${tag.slice(0, 97)}…` : tag,
		hidden,
	}
}

/**
 * The innermost element holding `index`: the tag it sits inside (an `href`), else the
 * open element around it. Email HTML closes things out of order, so a closing tag pops
 * back to its own name and is ignored when nothing open matches.
 */
export function containing_element(html: string, index: number): Element | undefined {
	const stack: Array<{ name: string; start: number; hidden: boolean }> = []
	for (const tag of tokenize(html).tags) {
		if (tag.position > index) break
		if (tag.closing) {
			const at = stack.findLastIndex((open) => open.name === tag.name)
			if (at !== -1) stack.length = at
			continue
		}
		const hidden = "data-web-hide" in tag.attrs || (stack.at(-1)?.hidden ?? false)
		if (tag_end(html, tag.position) > index) return element_at(html, tag.position, tag.name, hidden)
		const self_closing = html[tag_end(html, tag.position) - 2] === "/"
		if (!VOID.has(tag.name) && !self_closing)
			stack.push({ name: tag.name, start: tag.position, hidden })
	}
	const open = stack.at(-1)
	return open && element_at(html, open.start, open.name, open.hidden)
}

/** Every sender system variable in the HTML, with the element holding it. */
export function find_system_variables(html: string): Array<SystemVariable> {
	const found: Array<SystemVariable> = []
	for (const { provider, pattern } of SYSTEM_PATTERNS) {
		for (const match of html.matchAll(pattern)) {
			found.push({
				provider,
				match: match[0],
				index: match.index,
				element: containing_element(html, match.index),
			})
		}
	}
	// `{{ unsubscribe }}` is both Klaviyo's and SendGrid's: report the spot once.
	const by_index = new Map(found.map((s) => [s.index, s] as const))
	return [...by_index.values()].sort((a, b) => a.index - b.index)
}

/** Mark elements `data-web-hide`, leaving every other byte of the file as it was. */
export function add_web_hide(html: string, elements: Array<Element>): string {
	const starts = [...new Set(elements.filter((e) => !e.hidden).map((e) => e.start))]
	for (const start of starts.sort((a, b) => b - a)) {
		const name_end = start + 1 + /^<([^\s/>]+)/.exec(html.slice(start))![1].length
		html = `${html.slice(0, name_end)} data-web-hide${html.slice(name_end)}`
	}
	return html
}

// ── Placing the link ────────────────────────────────────────────────────────

export interface LinkTarget {
	rule: "marker" | "text"
	element: Element
}

function text_of(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/\s+/g, " ")
		.trim()
}

/**
 * The anchor the link goes in: the element marked `data-postboi-view-link` (or the first
 * anchor inside it), else the anchor reading "View in browser".
 */
export function find_link_target(html: string): LinkTarget | undefined {
	const tags = tokenize(html).tags
	const marker = tags.findIndex((t) => !t.closing && "data-postboi-view-link" in t.attrs)
	if (marker !== -1) {
		const open = tags[marker]
		let depth = 0
		for (const tag of tags.slice(marker)) {
			if (tag.name === open.name) depth += tag.closing ? -1 : 1
			if (!tag.closing && tag.name === "a")
				return { rule: "marker", element: element_at(html, tag.position, "a", false) }
			if (depth === 0) break
		}
	}
	for (const [i, tag] of tags.entries()) {
		if (tag.closing || tag.name !== "a") continue
		const close = tags.slice(i + 1).find((t) => t.closing && t.name === "a")
		const end = tag_end(html, tag.position)
		if (close && text_of(html.slice(end, close.position)).toLowerCase() === "view in browser")
			return { rule: "text", element: element_at(html, tag.position, "a", false) }
	}
	return undefined
}

/** Set an anchor's `href`, touching nothing else in the file. */
export function set_href(html: string, element: Element, url: string): string {
	const tag = html.slice(element.start, element.end)
	const value = `href="${url.replace(/"/g, "&quot;")}"`
	const next = /\shref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(tag)
		? tag.replace(/(\s)href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, (_, space) => `${space}${value}`)
		: tag.replace(/^<a\b/i, `<a ${value}`)
	return html.slice(0, element.start) + next + html.slice(element.end)
}

// ── Links in each sender's syntax ───────────────────────────────────────────

/** One template path as the sender writes it on a URL, encoded. */
export function merge_expression(provider: ViewProvider, path: string): string {
	const nested = path.includes(".")
	switch (provider) {
		case "onesignal":
			return `{{ ${nested ? path : `user.tags.${path}`} | url_encode }}`
		case "braze": {
			// `custom_attribute.${week}`, `event_properties.${week}`: the last name is Braze's.
			const at = path.lastIndexOf(".")
			return `{{${path.slice(0, at + 1)}\${${path.slice(at + 1)}} | url_param_escape}}`
		}
		case "iterable":
			return `{{#urlEncode}}{{${path}}}{{/urlEncode}}`
		case "customerio":
			return `{{ ${nested ? path : `customer.${path}`} | url_encode }}`
		case "klaviyo":
			return nested && !path.startsWith("person.")
				? `{{ ${path}|urlencode }}`
				: `{{ person|lookup:'${path.replace(/^person\./, "")}'|urlencode }}`
		case "mailchimp":
			return `*|URL:${path.split(".").at(-1)!.toUpperCase()}|*`
		case "sendgrid":
			return `{{${path}}}`
		case "none":
			return `<${path.split(".").at(-1)}>`
	}
}

/** The name each feed-capable sender saves the feed's answer under, read in the email. */
const FEED_RESULT: Partial<Record<ViewProvider, string>> = {
	onesignal: "{{ data_feed.postboi_view.url }}",
	braze: "{{ postboi_view.url }}",
	iterable: "[[url]]",
}

export function supports_feed(provider: ViewProvider): boolean {
	return provider in FEED_RESULT
}

/**
 * The link to put in the email. With feed fields on a sender that can fetch, it starts
 * from the URL the feed answered (which already carries `?r=`); public params ride after,
 * then the reader's id as `u` when `reader` names its template path.
 */
export function view_link(
	provider: ViewProvider,
	url: string,
	params: Record<string, ParamSpec>,
	feed: boolean,
	reader?: string
): string {
	const query = Object.entries(params).map(
		([name, spec]) => `${encodeURIComponent(name)}=${merge_expression(provider, spec.path)}`
	)
	if (reader) query.push(`u=${merge_expression(provider, reader)}`)
	const base = feed && supports_feed(provider) ? FEED_RESULT[provider]! : url
	if (provider === "none" || query.length === 0) return base
	return `${base}${base === url ? "?" : "&"}${query.join("&")}`
}

/** What to paste into the sender so it asks Postboi for each reader's link at send time. */
export function feed_setup(
	provider: ViewProvider,
	api: string,
	slug: string,
	fields: Record<string, string>,
	key: string
): Array<string> | undefined {
	const endpoint = `${api}/v1/views/${slug}/link`
	// Braze JSON-encodes a `:body` of k=v pairs itself, so its values go in unescaped.
	// ponytail: a value holding `&` or `=` would split there; Braze's own examples accept that.
	const pairs = Object.entries(fields).map(
		([field, path]) =>
			`${encodeURIComponent(field)}=${provider === "braze" ? merge_expression(provider, path).replace(" | url_param_escape", "") : merge_expression(provider, path)}`
	)
	if (provider === "onesignal") {
		return [
			"OneSignal: Messages → Data Feeds → New Data Feed",
			`  Name     Postboi view link`,
			`  Alias    postboi_view`,
			`  Method   GET`,
			`  URL      ${endpoint}?${pairs.join("&")}`,
			`  Header   Authorization: Bearer ${key}`,
			"Then pick it as the template's data feed. The link reads it as data_feed.postboi_view.url.",
			"OneSignal skips a recipient whose feed call fails, so this feed now sits on the send path.",
		]
	}
	if (provider === "braze") {
		return [
			"Braze: put this at the top of the email's body (Connected Content):",
			`  {% connected_content ${endpoint} :method post :headers {"Authorization": "Bearer ${key}"} :body ${pairs.join("&")} :content_type application/json :save postboi_view %}`,
			"The link reads it as postboi_view.url.",
		]
	}
	if (provider === "iterable") {
		return [
			"Iterable: Content → Data Feeds → New Data Feed",
			`  Name     postboi_view`,
			`  URL      ${endpoint}?${pairs.join("&")}`,
			`  Format   JSON`,
			`  Header   Authorization: Bearer ${key}`,
			"Then turn it on in the template's settings (Data feeds). The link reads it as [[url]].",
		]
	}
	return undefined
}

/** A best guess at the sender from the merge syntax the email is written in. */
export function guess_provider(html: string): ViewProvider | undefined {
	if (/\{\{-?\s*(?:user\.tags\.|subscription\.|data_feed\.)/.test(html)) return "onesignal"
	if (/\$\{\s*[\w.]+\s*\}|connected_content|custom_attribute\./.test(html)) return "braze"
	if (/\*\|[A-Z_]+(?::[^|]*)?\|\*/.test(html)) return "mailchimp"
	if (/person\|lookup|\{\{\s*person\./.test(html)) return "klaviyo"
	if (/\{\{-?\s*customer\./.test(html)) return "customerio"
	return undefined
}

// ── Classifying ─────────────────────────────────────────────────────────────

/** Keys of the context object at `path`, the values an index into it can take. */
export function context_keys(context: unknown, path: string): Array<string> | undefined {
	let at: unknown = context
	for (const key of path.split(".")) {
		if (!at || typeof at !== "object") return undefined
		at = (at as Record<string, unknown>)[key]
	}
	if (!at || typeof at !== "object") return undefined
	return Object.keys(at).filter((key) => key !== "")
}

export interface Inferred {
	path: string
	name: string
	values: Array<string>
}

/**
 * The reader variables that pick from context by index, each an enum of that context's
 * keys: `dynamic_content.body[week]` with `assign week = user.tags.pregnancy_week` makes
 * `week` an enum over `body`'s keys, filling `user.tags.pregnancy_week`.
 */
export function infer_enums(found: Detected, context: unknown): Array<Inferred> {
	const out = new Map<string, Inferred>()
	for (const { collection, by } of found.indexes) {
		const path = found.aliases.get(by) ?? (is_local(found, by) ? undefined : by)
		const keys = path && context_keys(context, collection)
		if (!path || !keys?.length) continue
		const name = found.aliases.has(by) ? by : (path.split(".").at(-1) ?? path)
		const entry = out.get(path) ?? { path, name, values: [] }
		entry.values = [...new Set([...entry.values, ...keys])]
		out.set(path, entry)
	}
	return [...out.values()]
}

/**
 * The paths only a reader can fill: not bound by the template, not system, not in context,
 * and not OneSignal's `data_feed` (a feed's answer, like the link `--write` put in).
 */
export function reader_paths(found: Detected, context: unknown): Array<string> {
	const roots = context && typeof context === "object" ? Object.keys(context) : []
	return found.paths.filter((path) => {
		const root = path.split(".")[0]
		return (
			!is_local(found, path) &&
			!is_system_path(path) &&
			root !== "data_feed" &&
			!roots.includes(root)
		)
	})
}

const FREE_TEXT = new Set(["text", "string", "str", "free"])

/** A dotted template path, `user.external_id`, as `--reader` takes it. */
const TEMPLATE_PATH = /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/

/** `week:integer`, `week:enum`, `user.tags.week` → the variable and its type, if given. */
export function parse_public(value: string): Array<{ name: string; type?: string }> {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const [name, type] = part.split(":")
			return { name: name.trim(), type: type?.trim().toLowerCase() }
		})
}

function refuse_free_text(name: string, slug: string): never {
	throw new ApiCommandError(
		`${name} can't be a public param as free text: anyone can edit a URL, and the page would print whatever they typed. Make it an integer, a date or an enum, or leave it private so it comes through the feed (POST /v1/views/${slug}/link) or a sealed link.`,
		"free_text_param"
	)
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Errors from the views API, with a 404 that has no code read as "not deployed yet". */
async function views_api<T>(
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<T> {
	try {
		return await api<T>(path, init)
	} catch (error) {
		if (error instanceof ApiCommandError && error.code === "http_404") {
			throw new ApiCommandError(
				`This Postboi server doesn't have ${init.method ?? "GET"} ${path.split("?")[0]} yet: views are still rolling out. Nothing changed; try again after the next deploy.`,
				"views_unavailable"
			)
		}
		throw error
	}
}

/** The same refusal from the SDK's PostboiError, so `views open --data` reads like the rest. */
function from_sdk(error: unknown): never {
	if (error instanceof PostboiError) {
		throw new ApiCommandError(
			error.message,
			error.code === undefined ? undefined : String(error.code)
		)
	}
	throw error
}

async function read_context(file: string): Promise<Record<string, unknown>> {
	const path = resolve(file)
	let value: unknown
	try {
		if (extname(file) === ".json") value = JSON.parse(readFileSync(path, "utf8"))
		else {
			const mod = (await import(/* @vite-ignore */ pathToFileURL(path).href)) as {
				default?: unknown
			}
			value = mod.default ?? mod
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new ApiCommandError(`Could not read the context in ${file}: ${reason}`, "bad_context")
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ApiCommandError(
			`${file} should hold the context as an object (a .json file, or a module whose default export is it).`,
			"bad_context"
		)
	}
	return value as Record<string, unknown>
}

/** The knobs a test turns: the questions publish asks on a terminal. */
export const views_io = {
	interactive: () => Boolean(stdin.isTTY && stdout.isTTY),
	async confirm(question: string): Promise<boolean> {
		const prompts = create_prompts()
		try {
			return await prompts.confirm(question, true)
		} finally {
			prompts.close()
		}
	},
	async param_type(name: string): Promise<ParamSpec["type"] | "private"> {
		const prompts = create_prompts()
		try {
			return await prompts.select(`\n${bold(name)} is public. What can it be?`, [
				{ label: "A whole number", value: "integer" as const, hint: "?week=20" },
				{ label: "A date", value: "date" as const, hint: "YYYY-MM-DD" },
				{ label: "One of a fixed list", value: "enum" as const },
				{ label: "Keep it private", value: "private" as const, hint: "it comes through the feed" },
			])
		} finally {
			prompts.close()
		}
	},
	async enum_values(name: string): Promise<Array<string>> {
		const prompts = create_prompts()
		try {
			const answer = await prompts.ask(`The values ${bold(name)} can take, comma separated:`, {
				required: true,
			})
			return answer
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean)
		} finally {
			prompts.close()
		}
	},
}

const PUBLISH_USAGE = [
	"Usage: postboi views publish <file.html> [--slug <slug>] [--provider <sender>] [--context <file.json or .js>]",
	"         [--public <var[:integer, date or enum]>,… or --public all] [--reader <path> or off] [--write] [--yes] [--json]",
	`         senders: ${VIEW_PROVIDERS.join(", ")}`,
].join("\n")

/** A slug as the API takes it: `[a-z0-9-]`, up to 64. */
function view_slug(value: string): string {
	return slugify(value).slice(0, 64).replace(/-+$/, "")
}

async function publish(args: Array<string>): Promise<void> {
	const { flags, rest, on } = take_flags(
		args,
		["slug", "provider", "public", "context", "reader"],
		["write", "yes"]
	)
	const file = rest[0]
	if (!file || rest.length > 1) throw new ApiCommandError(PUBLISH_USAGE)
	if (flags.slug !== undefined && !/^[a-z0-9-]{1,64}$/.test(flags.slug)) {
		throw new ApiCommandError("A slug is up to 64 of a-z, 0-9 and -.", "invalid_slug")
	}
	const slug = flags.slug ?? view_slug(basename(file, extname(file)))
	let html = readFileSync(file, "utf8")
	const original = html
	const ask = !json_output() && views_io.interactive()

	const config = await load_config()
	const saved: ViewConfig = config.views?.[slug] ?? {}
	const provider = (flags.provider ??
		saved.provider ??
		guess_provider(html) ??
		(VIEW_PROVIDERS.includes(config.provider as ViewProvider)
			? config.provider
			: "none")) as ViewProvider
	if (!VIEW_PROVIDERS.includes(provider)) {
		throw new ApiCommandError(
			`Unknown sender "${provider}". One of: ${VIEW_PROVIDERS.join(", ")}.`,
			"unknown_provider"
		)
	}
	const context_file = flags.context ?? saved.context
	const context = context_file ? await read_context(context_file) : undefined

	// The last version's choices: a re-publish keeps them without being told again. Only
	// "no such view" (or no views route yet) means there are none: any other failure would
	// quietly drop them, the reader param included, so it stops the publish.
	const previous = await api<View>(`/v1/views/${slug}`).catch((error) => {
		if (error instanceof ApiCommandError && ["not_found", "http_404"].includes(error.code ?? ""))
			return undefined
		throw error
	})

	// The reader param: a path from the flag or the config. The server takes it per
	// publish and keeps only whether the last version had it on, so with neither, this
	// sends it on again and links without `u`.
	const reader_choice = flags.reader ?? saved.reader
	if (
		reader_choice !== undefined &&
		reader_choice !== "off" &&
		!TEMPLATE_PATH.test(reader_choice)
	) {
		throw new ApiCommandError(
			`--reader takes the template path of your sender's id for the reader, like user.external_id, or off.`,
			"invalid_reader"
		)
	}
	const reader_path = reader_choice === "off" ? undefined : reader_choice
	const reader = reader_choice ? reader_choice !== "off" : Boolean(previous?.reader)

	// A link --write put in earlier carries `u=` in merge syntax; that's the link, not a
	// variable the page reads, so it mustn't turn into a feed field on the next publish.
	// ponytail: only the current path's `u=`; a path changed since leaves the old one in.
	const found = detect_variables(
		reader_path ? html.replaceAll(`u=${merge_expression(provider, reader_path)}`, "") : html
	)
	const readers = reader_paths(found, context)
	const enums = infer_enums(found, context)

	// Params: the previous version's, then the config's (which win), kept while the path
	// is still read; then enums inferred from context, which are safe by construction.
	const params: Record<string, ParamSpec> = {}
	const name_of = (path: string) => Object.entries(params).find(([, s]) => s.path === path)?.[0]
	for (const [name, spec] of Object.entries({ ...previous?.params, ...saved.params })) {
		if (readers.includes(spec.path)) {
			const old = name_of(spec.path)
			if (old) delete params[old]
			params[name] = spec
		}
	}
	for (const inferred of enums) {
		if (readers.includes(inferred.path) && !name_of(inferred.path)) {
			params[inferred.name] = { path: inferred.path, type: "enum", values: inferred.values }
		}
	}

	if (flags.public) {
		const wanted =
			flags.public === "all"
				? readers.map((path) => ({ name: path, type: undefined as string | undefined }))
				: parse_public(flags.public)
		for (const { name, type } of wanted) {
			const path =
				params[name]?.path ??
				found.aliases.get(name) ??
				readers.find((p) => p === name || p.endsWith(`.${name}`))
			if (!path || !readers.includes(path)) {
				throw new ApiCommandError(
					`${file} has no reader variable "${name}". It reads: ${readers.join(", ") || "none"}.`,
					"unknown_variable"
				)
			}
			if (type && FREE_TEXT.has(type)) refuse_free_text(name, slug)
			const inferred = enums.find((e) => e.path === path)
			let param = name_of(path) ?? inferred?.name ?? path.split(".").at(-1)!
			if (params[param] && params[param].path !== path) param = path.replace(/\W+/g, "_")
			let chosen = type
			if (!chosen && name_of(path)) continue
			if (!chosen && inferred) chosen = "enum"
			if (!chosen) {
				if (!ask) {
					throw new ApiCommandError(
						`Say what ${param} can be: --public ${param}:integer, :date or :enum. Free text can't be public.`,
						"param_type_needed"
					)
				}
				chosen = await views_io.param_type(param)
				if (chosen === "private") continue
			}
			if (chosen === "integer" || chosen === "date") params[param] = { path, type: chosen }
			else if (chosen === "enum") {
				const values = inferred?.values ?? (ask ? await views_io.enum_values(param) : [])
				if (!values.length) {
					throw new ApiCommandError(
						`${param} reads no context by index, so its values can't be inferred. Pass --context, or set them in postboi.config.ts under views.${slug}.params.`,
						"enum_values_needed"
					)
				}
				params[param] = { path, type: "enum", values }
			} else {
				throw new ApiCommandError(
					`Unknown param type "${chosen}". Use integer, date or enum.`,
					"invalid_param_type"
				)
			}
		}
	}

	if (reader && "u" in params) {
		throw new ApiCommandError(
			`With the reader param on, u carries the reader's id, so no public param can be called u. Rename it in postboi.config.ts under views.${slug}.params, or pass --reader off.`,
			"reader_param_clash"
		)
	}
	// Without the path, --write would put back a link that has lost the `u=` it carries.
	const placed_before = on.has("write") ? find_link_target(original) : undefined
	if (
		reader &&
		!reader_path &&
		placed_before &&
		/[?&]u=/.test(original.slice(placed_before.element.start, placed_before.element.end))
	) {
		throw new ApiCommandError(
			`The link in ${file} carries u, and --write would rewrite it without: pass --reader <path> (or set views.${slug}.reader in postboi.config.ts), or --reader off.`,
			"reader_path_needed"
		)
	}

	// Feed fields: every other reader variable, under the name it had before.
	const fields: Record<string, string> = {}
	const known = { ...previous?.feed?.fields, ...saved.feed }
	for (const path of readers) {
		if (name_of(path)) continue
		let field = Object.entries(known).find(([, p]) => p === path)?.[0] ?? path.split(".").at(-1)!
		if (field in fields) field = path.replace(/\W+/g, "_")
		fields[field] = path
	}

	// System variables: hide what holds them, with --write.
	const system = find_system_variables(html)
	const unhidden = system.filter((s) => s.element && !s.element.hidden)
	const hide: Array<Element> = []
	if (on.has("write")) {
		for (const element of new Map(unhidden.map((s) => [s.element!.start, s.element!])).values()) {
			const ok =
				on.has("yes") ||
				(ask &&
					(await views_io.confirm(`Add data-web-hide to ${element.tag} (line ${element.line})?`)))
			if (ok) hide.push(element)
		}
		html = add_web_hide(html, hide)
	}
	const hidden = (element: Element | undefined) =>
		Boolean(element && (element.hidden || hide.some((e) => e.start === element.start)))

	const body = {
		slug,
		html,
		context,
		params,
		feed: Object.keys(fields).length ? { fields } : undefined,
		syntax: /\{\{|\{%/.test(html) ? "liquid" : "none",
		// Left out rather than false, so a server from before the reader param takes it.
		reader: reader || undefined,
	}
	const view = await views_api<View>("/v1/views", { method: "POST", body })
	const url = view.custom_url ?? view.url
	const has_feed = Object.keys(fields).length > 0
	const link = view_link(provider, url, params, has_feed, reader ? reader_path : undefined)

	let setup: Array<string> | undefined
	let key_note: string | undefined
	if (has_feed && supports_feed(provider)) {
		const key = await feed_key()
		key_note = key.note
		setup = feed_setup(provider, cloud_base(), slug, fields, key.key)
	}

	// Written once the publish went through, so a refused publish leaves the file alone.
	const placed = on.has("write") ? find_link_target(html) : undefined
	const written = placed ? set_href(html, placed.element, link) : html
	if (written !== original) writeFileSync(file, written)

	respond({
		view,
		provider,
		link,
		params,
		feed: fields,
		reader: reader ? (reader_path ?? true) : undefined,
		context: context ? Object.keys(context) : [],
		system: system.map((s) => ({
			provider: s.provider,
			match: s.match,
			line: s.element?.line,
			element: s.element?.tag,
			hidden: hidden(s.element),
		})),
		feed_setup: setup,
		link_written: placed ? { rule: placed.rule, line: placed.element.line } : undefined,
	})

	say(`${green("✓")} published ${bold(view.slug)} ${dim(`version ${view.version}`)}  ${cyan(url)}`)
	if (context) say(`  ${dim("context")}  ${Object.keys(context).join(", ")}`)
	for (const [name, spec] of Object.entries(params)) {
		const kind =
			spec.type === "enum"
				? `enum, ${spec.values.length} value${spec.values.length === 1 ? "" : "s"}`
				: spec.type
		say(`  ${dim("public")}   ${bold(name)} → ${spec.path} ${dim(`(${kind})`)}`)
	}
	for (const [field, path] of Object.entries(fields)) {
		say(`  ${dim("feed")}     ${bold(field)} → ${path}`)
	}
	if (reader) {
		say(
			`  ${dim("reader")}   ${bold("u")} → ${reader_path ?? dim("no path: pass --reader <path> to put it on the link")} ${dim("(anyone can edit it: a claim, not proof)")}`
		)
		if (view.reader === undefined) {
			say(
				yellow(
					"  ! This Postboi server doesn't read u yet, so views report no reader until it does."
				)
			)
		}
	}
	if (!flags.public && Object.keys(fields).length) {
		say(dim(`  (make one public with --public ${Object.keys(fields)[0]}:integer, :date or :enum)`))
	}

	// One line per element, however many of the sender's variables it holds.
	const groups = new Map<number, Array<SystemVariable>>()
	for (const s of system)
		groups.set(s.element?.start ?? -1, [...(groups.get(s.element?.start ?? -1) ?? []), s])
	for (const group of groups.values()) {
		const { element, provider } = group[0]
		const names = group.map((s) => s.match).join(", ")
		if (hidden(element)) {
			say(`  ${dim("hidden")}   ${names} ${dim("(data-web-hide)")}`)
			continue
		}
		const where = element ? `${element.tag} ${dim(`line ${element.line}`)}` : "outside any element"
		say(
			`  ${yellow("!")} ${names}: ${PROVIDER_NAME[provider]}'s own, per reader. Postboi leaves ${group.length === 1 ? "it" : "them"} empty, so hide what holds ${group.length === 1 ? "it" : "them"} on the web:`
		)
		say(`    add data-web-hide to ${where}${on.has("write") ? "" : dim(" (--write does it)")}`)
	}
	const uncovered = [...new Set(found.indexes.map((i) => i.collection))].filter((c) =>
		readers.includes(c)
	)
	if (uncovered.length) {
		say(
			yellow(
				`  ! ${uncovered.join(", ")} ${uncovered.length === 1 ? "is" : "are"} indexed like context, but no context covers ${uncovered.length === 1 ? "it" : "them"}. Pass --context, or set views.${slug}.context in postboi.config.ts so every publish has it.`
			)
		)
	}

	say()
	say(`${bold(`Link for ${PROVIDER_NAME[provider]}`)}`)
	say(`  ${link}`)
	if (provider === "none" && (Object.keys(params).length || reader)) {
		say(
			dim(
				`  personalise it with ${[...Object.keys(params), ...(reader ? ["u"] : [])]
					.map((name) => `?${name}=…`)
					.join(" ")} in your sender's merge syntax (--provider names one)`
			)
		)
	}
	if (placed) {
		say(`${green("✓")} wrote it into ${placed.element.tag} ${dim(`line ${placed.element.line}`)}`)
	} else if (on.has("write")) {
		say(
			yellow(
				`! no place for it in ${file}: mark an element data-postboi-view-link, or put it in an <a> reading "View in browser"`
			)
		)
	}

	if (has_feed) {
		say()
		if (setup) {
			for (const line of setup) say(line.startsWith("  ") ? line : bold(line))
			const other = provider === "onesignal" && /data_feed\.(?!postboi_view\b)\w+/.exec(original)
			if (other) {
				say(
					yellow(
						`! This email already reads ${other[0]}, and OneSignal allows one data feed per template. Make the fields public (--public), or have that feed's backend call Postboi and answer the url too.`
					)
				)
			}
			if (key_note) say(dim(key_note))
		} else {
			say(
				yellow(
					`! ${PROVIDER_NAME[provider]} can't call Postboi at send time, so the page shows the generic version for ${Object.keys(fields).join(", ")}. Make them public (--public), or mint sealed links from your own code (views.url).`
				)
			)
		}
	}
}

/** A feed key to show in the setup: a new one on first use, a placeholder after that. */
async function feed_key(): Promise<{ key: string; note?: string }> {
	const placeholder = "<your feed key, pbf_…>"
	try {
		const keys = await views_api<{ data: Array<{ kind: string }> }>("/v1/views/keys")
		if (keys.data.some((k) => k.kind === "feed")) {
			return {
				key: placeholder,
				note: "Feed keys are shown once. Use the one you saved, or mint another with `postboi views feed-key`.",
			}
		}
		const created = await views_api<{ key: string }>("/v1/views/keys", {
			method: "POST",
			body: { kind: "feed" },
		})
		return {
			key: created.key,
			note: "That feed key is shown once: it can only mint view links, never send or read.",
		}
	} catch (error) {
		if (!(error instanceof ApiCommandError) || error.code !== "views_unavailable") throw error
		return {
			key: placeholder,
			note: "Feed keys aren't on this Postboi server yet: fill it in once they are.",
		}
	}
}

async function open_view(args: Array<string>): Promise<void> {
	const query = new URLSearchParams()
	const rest_args: Array<string> = []
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--param") {
			rest_args.push(args[i])
			continue
		}
		const [key, ...value] = (args[++i] ?? "").split("=")
		if (!key || !value.length) throw new ApiCommandError("--param takes key=value.")
		query.append(key, value.join("="))
	}
	const { flags, rest } = take_flags(rest_args, ["data"])
	const slug = rest[0]
	if (!slug || rest.length > 1) {
		throw new ApiCommandError(
			"Usage: postboi views open <slug> [--data <json>] [--param key=value]"
		)
	}
	if (flags.data !== undefined) {
		let data: unknown
		try {
			data = JSON.parse(flags.data)
		} catch {
			// Refused below with the same words.
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			throw new ApiCommandError(
				'--data takes a JSON object, like \'{"first_name":"Ada"}\'.',
				"invalid_data"
			)
		}
		const url = await views_sdk.url(slug, data as Record<string, unknown>).catch(from_sdk)
		respond({ url })
		say(cyan(url))
		if (!json_output()) open_browser(url)
		return
	}
	const search = query.toString() ? `?${query}` : ""
	const page = await api_file(`/v1/views/${encodeURIComponent(slug)}/preview${search}`).catch(
		(error) => {
			if (error instanceof ApiCommandError && error.code === "http_404") {
				throw new ApiCommandError(
					`No preview for ${slug}: either it isn't published (\`postboi views\` lists them) or this server doesn't host views yet.`,
					"views_unavailable"
				)
			}
			throw error
		}
	)
	const path = join(tmpdir(), `postboi-view-${slug}.html`)
	writeFileSync(path, page.bytes)
	respond({ path })
	say(`${green("✓")} ${dim("preview of")} ${bold(slug)} ${dim("at")} ${path}`)
	if (!json_output()) open_browser(path)
}

async function keys(args: Array<string>): Promise<void> {
	if (args[0] === "rotate") {
		const key = await views_api<{ id: string; key: string }>("/v1/views/keys/rotate", {
			method: "POST",
		})
		say(`${green("✓")} new view key ${dim(`(${key.id})`)}`)
		say(`  ${key.key}`)
		return say(
			dim(
				"  The previous key keeps working for a grace period. `postboi sync` writes the new one to POSTBOI_VIEW_KEY."
			)
		)
	}
	if (args[0]) throw new ApiCommandError(`Unknown action: views keys ${args[0]}. Try rotate.`)
	const { data } = await views_api<{
		data: Array<{
			id: string
			kind: string
			hint?: string
			created_at?: string
			expires_at?: string
		}>
	}>("/v1/views/keys")
	if (data.length === 0)
		return say(dim("No view or feed keys yet. `postboi views feed-key` mints a feed key."))
	table(
		["KIND", "KEY", "CREATED", "EXPIRES", "ID"],
		data.map((k) => [
			k.kind,
			k.hint ?? "",
			(k.created_at ?? "").slice(0, 10),
			(k.expires_at ?? "").slice(0, 10),
			dim(k.id),
		])
	)
}

const STATS_USAGE = "Usage: postboi views stats <slug> [--days <1 to 365>] [--json]"

async function stats(args: Array<string>): Promise<void> {
	const { flags, rest } = take_flags(args, ["days"])
	const slug = rest[0]
	if (!slug || rest.length > 1) throw new ApiCommandError(STATS_USAGE)
	const days = flags.days === undefined ? undefined : Number(flags.days)
	if (days !== undefined && !(/^\d+$/.test(flags.days!) && days >= 1 && days <= 365)) {
		throw new ApiCommandError(
			`--days is a whole number from 1 to 365.\n${STATS_USAGE}`,
			"invalid_days"
		)
	}
	const query = days === undefined ? "" : `?days=${days}`
	const result = await views_api<ViewStats>(`/v1/views/${encodeURIComponent(slug)}/stats${query}`)
	const total = result.days.reduce((sum, d) => sum + d.views, 0)
	const span = `the last ${days ?? 30} day${days === 1 ? "" : "s"}`
	if (total === 0) return say(dim(`No views of ${slug} in ${span}.`))
	say(
		`${bold(slug)}  ${total} view${total === 1 ? "" : "s"} in ${span}, ${result.identified} identified`
	)
	say()
	table(
		["DAY", "VIEWS", "VISITORS"],
		// The server fills in every day of the window; a day nobody viewed is noise here.
		result.days.filter((d) => d.views > 0).map((d) => [d.day, String(d.views), String(d.visitors)])
	)
	say()
	table(
		["PARAMS", "VIEWS", "VISITORS"],
		result.params.map((p) => [p.params || dim("(none)"), String(p.views), String(p.visitors)])
	)
	say()
	say(dim("Visitors are counted per day, so they don't add up across days."))
}

/**
 * `postboi views`: list, publish, open, delete, and the keys behind sealed links and feeds.
 * A function declaration on purpose: api.ts imports this while this imports api.ts.
 */
export async function views(args: Array<string>): Promise<void> {
	const [action, ...rest] = args
	if (action === "publish") return publish(rest)
	if (action === "open") return open_view(rest)
	if (action === "keys") return keys(rest)
	if (action === "stats") return stats(rest)
	if (action === "feed-key") {
		const key = await views_api<{ id: string; key: string }>("/v1/views/keys", {
			method: "POST",
			body: { kind: "feed" },
		})
		say(`${green("✓")} new feed key ${dim(`(${key.id})`)}`)
		say(`  ${key.key}`)
		return say(dim("  Shown once. It can only mint view links for this team, never send or read."))
	}
	if (action === "delete") {
		const slug = rest[0]
		if (!slug) throw new ApiCommandError("Usage: postboi views delete <slug>")
		await views_api(`/v1/views/${encodeURIComponent(slug)}`, { method: "DELETE" })
		return say(`${green("✓")} deleted ${bold(slug)} ${dim("(its page is gone)")}`)
	}
	if (action) {
		throw new ApiCommandError(
			`Unknown action: views ${action}. Try publish, open, stats, delete, keys or feed-key.`
		)
	}
	const { data } = await views_api<{ data: Array<View> }>("/v1/views")
	if (data.length === 0) {
		return say(dim("No views yet. Publish one: postboi views publish email.html"))
	}
	table(
		["SLUG", "VERSION", "UPDATED", "URL"],
		data.map((v) => [
			v.disabled ? yellow(v.slug) : v.slug,
			String(v.version),
			(v.updated_at ?? "").slice(0, 10),
			cyan(v.custom_url ?? v.url),
		])
	)
}
