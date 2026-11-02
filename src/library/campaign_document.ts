import { parseDocument, DomUtils } from "htmlparser2"
import { marked } from "marked"
export const EMPTY_HTML_DOCUMENT =
	'<!doctype html><html><head><meta charset="utf-8"><title></title></head><body><p></p></body></html>'
export type CampaignBodyFormat = "blocks" | "markdown" | "html_document"
export class CampaignDocumentError extends Error {
	readonly code = "invalid_campaign_document"
}
export function campaign_body_format(value: unknown): CampaignBodyFormat {
	if (value === undefined) return "blocks"
	if (value !== "blocks" && value !== "markdown" && value !== "html_document")
		throw new CampaignDocumentError("Choose blocks, markdown or html_document for body_format.")
	return value
}
export function markdown_body(value: string): string {
	const prefix = `PBT${crypto.randomUUID().replaceAll("-", "")}`
	const placeholders: Array<string> = []
	const source = value.replace(/\{\$?\w+(?:\|[^{}|]*)*\}/g, (whole) => {
		placeholders.push(whole)
		return `${prefix}${placeholders.length - 1}X`
	})
	return marked
		.parse(source, { async: false, gfm: true })
		.replace(
			new RegExp(`${prefix}(\\d+)X`, "g"),
			(_whole, index: string) => placeholders[Number(index)]
		)
}
const active_tags = new Set([
	"script",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"applet",
	"form",
	"input",
	"button",
	"textarea",
	"select",
	"option",
	"video",
	"audio",
	"source",
	"track",
	"template",
	"base",
])
function safe_url(value: string, image = false) {
	// eslint-disable-next-line no-control-regex -- URL scheme checks ignore browser whitespace/control characters.
	const normalized = value.replace(/[\u0000-\u0020\u007f]/g, "")
	if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return true
	if (/^https?:/i.test(normalized)) return true
	if (!image && /^(?:mailto|tel):/i.test(normalized)) return true
	return image && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(normalized)
}
function css_check(value: string) {
	// eslint-disable-next-line no-control-regex -- Detect CSS scripting even when hidden by whitespace/control characters.
	const plain = value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/[\u0000-\u0020\u007f]/g, "")
	if (
		value.includes("\\") ||
		/expression\(|(?:javascript|vbscript):|(?:^|[;{])(?:behavior|-moz-binding):/i.test(plain)
	)
		throw new CampaignDocumentError(
			"This document uses unsafe or escaped CSS. Remove scripting expressions, behavior bindings and CSS escapes before saving."
		)
}
/** A real document tree keeps body insertion out of comments, CSS strings and nested markup. */
export function html_document(
	input: string,
	options: {
		prepend?: string
		append?: string
		url?: (value: string, image: boolean) => string | null
		text?: (value: string) => string
	} = {}
): string {
	if (input.length > 600000)
		throw new CampaignDocumentError("This HTML document exceeds the supported size.")
	const document = parseDocument(input)
	const html_nodes = DomUtils.findAll((node) => node.name === "html", document.children)
	const bodies = DomUtils.findAll((node) => node.name === "body", document.children)
	if (
		html_nodes.length !== 1 ||
		bodies.length !== 1 ||
		html_nodes[0].parent !== document ||
		bodies[0].parent !== html_nodes[0] ||
		document.children.some(
			(node) =>
				node.type !== "comment" &&
				node.type !== "directive" &&
				!(node.type === "text" && !node.data.trim()) &&
				node !== html_nodes[0]
		)
	)
		throw new CampaignDocumentError(
			"Use one complete HTML document with an explicit html element and body element."
		)
	const stack = document.children.map((node) => ({ node, depth: 0 }))
	let count = 0
	while (stack.length) {
		const { node, depth } = stack.pop()!
		if (++count > 30000 || depth > 100)
			throw new CampaignDocumentError(
				"This document has too many elements or nested layers. Simplify its layout before saving."
			)
		if (node.type === "comment") {
			if (/^\s*(?:\[if\b|<!\[endif)/i.test(node.data))
				throw new CampaignDocumentError(
					"Outlook conditional comments and VML are not supported in this source format yet. Use a version with standard HTML tables and CSS rather than losing that layout silently."
				)
			DomUtils.removeElement(node)
			continue
		}
		if (node.type === "text") {
			if (options.text) node.data = options.text(node.data)
			continue
		}
		if (!("name" in node) || !("attribs" in node)) continue
		if (
			["plaintext", "xmp", "listing", "noembed", "noframes", "noscript", "isindex"].includes(
				node.name
			)
		)
			throw new CampaignDocumentError(
				"Legacy raw-text elements are unsupported because they can hide required newsletter links. Use ordinary paragraphs, tables or preformatted blocks."
			)
		if (node.name.includes(":") || ["svg", "math"].includes(node.name))
			throw new CampaignDocumentError(
				"VML, inline SVG and MathML are unsupported. Use standard email tables and hosted image files."
			)
		if (
			active_tags.has(node.name) ||
			(node.name === "meta" && node.attribs["http-equiv"]) ||
			(node.name === "link" && node.attribs.rel?.toLowerCase() !== "stylesheet")
		) {
			DomUtils.removeElement(node)
			continue
		}
		for (const [name, value] of Object.entries(node.attribs)) {
			if (
				name.startsWith("on") ||
				[
					"srcdoc",
					"formaction",
					"action",
					"ping",
					"contenteditable",
					"manifest",
					"dynsrc",
					"lowsrc",
				].includes(name) ||
				name.includes(":")
			) {
				delete node.attribs[name]
				continue
			}
			if (name === "srcset")
				throw new CampaignDocumentError(
					"Responsive srcset images are unsupported in this source format. Supply a single image src instead."
				)
			if (name === "style") {
				if (options.text) node.attribs[name] = options.text(value)
				css_check(node.attribs[name])
			}
			if (["href", "src", "background", "poster"].includes(name)) {
				const image = name !== "href",
					next = options.url ? options.url(value, image) : value
				if (next === null || !safe_url(next, image)) delete node.attribs[name]
				else node.attribs[name] = next
			} else if (options.text && ["alt", "title"].includes(name))
				node.attribs[name] = options.text(value)
		}
		if (node.name === "style") css_check(DomUtils.textContent(node))
		for (const child of node.children) stack.push({ node: child, depth: depth + 1 })
	}
	for (const node of parseDocument(options.prepend ?? "")
		.children.slice()
		.reverse())
		DomUtils.prependChild(bodies[0], node)
	for (const node of parseDocument(options.append ?? "").children.slice())
		DomUtils.appendChild(bodies[0], node)
	const output = DomUtils.getOuterHTML(document)
	if (new TextEncoder().encode(output).byteLength > 600000)
		throw new CampaignDocumentError(
			"The serialized HTML document exceeds 600 KB. Shorten the source or recipient fields before saving or rendering."
		)
	return output
}

export function html_body(input: string): string {
	const body = DomUtils.findOne((node) => node.name === "body", parseDocument(input).children)
	return body ? DomUtils.getInnerHTML(body) : ""
}

/** Presence of authored content, excluding CSS, metadata and comments that readers cannot read. */
export function has_html_content(input: string): boolean {
	const stack = parseDocument(input).children.slice()
	while (stack.length) {
		const node = stack.pop()!
		if (node.type === "text" && node.data.trim()) return true
		if (!("name" in node) || !("children" in node)) continue
		if (node.name === "img") return true
		if (["style", "script", "head", "title", "template", "noscript"].includes(node.name)) continue
		for (const child of node.children) stack.push(child)
	}
	return false
}
