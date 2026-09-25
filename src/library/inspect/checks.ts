/**
 * The static checks — everything {@link analyze} knows that isn't the client
 * support matrix. Each check is a pure function from the gathered document to
 * zero or more findings, so a check is testable on its own and adding one is
 * appending to a list.
 */

import type { Tokenized } from "./html.js"
import type { AnalyzeInput, Finding, ImageInfo, LinkInfo } from "./types.js"

/** Gmail truncates messages whose HTML exceeds ~102KB, hiding everything below the fold. */
export const GMAIL_CLIP_BYTES = 102 * 1024

export interface CheckContext {
	input: AnalyzeInput
	tokens: Tokenized
	links: Array<LinkInfo>
	images: Array<ImageInfo>
	html_bytes: number
}

type Check = (context: CheckContext) => Finding | undefined

const kb = (bytes: number) => `${Math.round(bytes / 102.4) / 10}KB`

const gmail_clip: Check = ({ html_bytes }) => {
	if (html_bytes <= GMAIL_CLIP_BYTES) return
	return {
		id: "gmail_clip",
		severity: "warning",
		message: `The HTML body is ${kb(html_bytes)}. Gmail clips messages over ${kb(GMAIL_CLIP_BYTES)}, hiding the rest behind a "View entire message" link`,
	}
}

/** Where big mail starts bouncing: Gmail and Outlook refuse messages around 25MB. */
export const MESSAGE_SIZE_LIMIT = 25 * 1024 * 1024

const message_size: Check = ({ input }) => {
	if (!input.size_bytes || input.size_bytes <= MESSAGE_SIZE_LIMIT) return
	return {
		id: "message_size",
		severity: "warning",
		message: `The whole message is ${Math.round(input.size_bytes / 1024 / 1024)} MB. Gmail and Outlook refuse mail around 25 MB, and most other servers are close behind`,
	}
}

const missing_plain_text: Check = ({ input }) => {
	// Bare HTML has nowhere to carry a text part — absence proves nothing there.
	if (input.source === "html" && !input.text) return
	if (!input.html || input.text?.trim()) return
	return {
		id: "missing_plain_text",
		severity: "warning",
		message:
			"No plain-text alternative. Spam filters distrust HTML-only email, and text-only clients show nothing",
	}
}

const missing_list_unsubscribe: Check = ({ input }) => {
	if (!input.headers || "list-unsubscribe" in input.headers) return
	return {
		id: "missing_list_unsubscribe",
		severity: "info",
		message:
			"No List-Unsubscribe header. Bulk senders need one to keep Gmail and Yahoo happy; transactional mail can ignore this",
	}
}

const missing_one_click_unsubscribe: Check = ({ input }) => {
	if (!input.headers?.["list-unsubscribe"] || "list-unsubscribe-post" in input.headers) return
	return {
		id: "missing_one_click_unsubscribe",
		severity: "info",
		message:
			"List-Unsubscribe without List-Unsubscribe-Post. One-click unsubscribe (RFC 8058) needs both, and Gmail requires it for bulk senders",
	}
}

const missing_lang: Check = ({ tokens }) => {
	const root = tokens.tags.find((tag) => !tag.closing && tag.name === "html")
	if (!root || tag_lang(root.attrs.lang)) return
	return {
		id: "missing_lang",
		severity: "info",
		message:
			"The <html> tag has no lang attribute, so screen readers fall back to guessing the language",
	}
}

const tag_lang = (value: string | undefined) => value !== undefined && value.trim() !== ""

const images_missing_alt: Check = ({ images }) => {
	// alt="" is fine — that is how a decorative image opts out. Missing entirely is not.
	const missing = images.filter(({ alt }) => alt === undefined).length
	if (!missing) return
	return {
		id: "images_missing_alt",
		severity: "warning",
		message: `${missing} image${missing === 1 ? " has" : "s have"} no alt text. With images blocked (Outlook's default) the reader sees nothing`,
		occurrences: missing,
	}
}

const image_no_dimensions: Check = ({ tokens }) => {
	// Either surface counts, but only both dimensions together settle the layout.
	const sized = (tag: { attrs: Record<string, string> }, dimension: "width" | "height") =>
		tag.attrs[dimension] !== undefined ||
		new RegExp(`(?:^|[;\\s])${dimension}\\s*:`, "i").test(tag.attrs.style ?? "")
	const undimensioned = tokens.tags.filter(
		(tag) => !tag.closing && tag.name === "img" && !(sized(tag, "width") && sized(tag, "height"))
	).length
	if (!undimensioned) return
	return {
		id: "image_no_dimensions",
		severity: "info",
		message: `${undimensioned} image${undimensioned === 1 ? " has" : "s have"} no declared dimensions. Layouts jump while images load, and Outlook renders them at natural size`,
		occurrences: undimensioned,
	}
}

const insecure_links: Check = ({ links }) => {
	const insecure = links.filter(({ scheme }) => scheme === "http").length
	if (!insecure) return
	return {
		id: "insecure_links",
		severity: "warning",
		message: `${insecure} link${insecure === 1 ? " uses" : "s use"} plain http:. Spam filters read that as a signal, and browsers warn on the landing page`,
		occurrences: insecure,
	}
}

const empty_links: Check = ({ tokens }) => {
	const empty = tokens.tags.filter(
		(tag) =>
			!tag.closing &&
			tag.name === "a" &&
			// An href-less <a> carrying name/id is an anchor *target* — the portable way
			// to do in-email jump links — not a dead tap.
			!(
				tag.attrs.href === undefined &&
				(tag.attrs.name !== undefined || tag.attrs.id !== undefined)
			) &&
			(tag.attrs.href === undefined ||
				tag.attrs.href.trim() === "" ||
				tag.attrs.href.trim() === "#" ||
				tag.attrs.href.trim().toLowerCase().startsWith("javascript:"))
	).length
	if (!empty) return
	return {
		id: "empty_links",
		severity: "warning",
		message: `${empty} link${empty === 1 ? " goes" : "s go"} nowhere (missing, "#" or javascript: href). They are dead taps for the reader, and script schemes are stripped anyway`,
		occurrences: empty,
	}
}

const subject_length: Check = ({ input }) => {
	if (input.subject === undefined) return
	if (input.subject.trim() === "")
		return {
			id: "subject_missing",
			severity: "warning",
			message: "The subject is empty: a classic spam signal, and the inbox shows “(no subject)”",
		}
	if (input.subject.length > 78)
		return {
			id: "subject_length",
			severity: "info",
			message: `The subject is ${input.subject.length} characters. Most inboxes truncate around 50–78, so the end will be cut off`,
		}
	return
}

const CHECKS: Array<Check> = [
	gmail_clip,
	message_size,
	missing_plain_text,
	missing_list_unsubscribe,
	missing_one_click_unsubscribe,
	missing_lang,
	images_missing_alt,
	image_no_dimensions,
	insecure_links,
	empty_links,
	subject_length,
]

/** Run every static check over one gathered document. */
export function run_checks(context: CheckContext): Array<Finding> {
	const findings: Array<Finding> = []
	for (const check of CHECKS) {
		const finding = check(context)
		if (finding) findings.push(finding)
	}
	return findings
}
