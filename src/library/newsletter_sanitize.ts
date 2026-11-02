import sanitize from "sanitize-html"

/**
 * HTML sanitiser for composed email bodies, built on `sanitize-html` — a vetted,
 * allowlist-based sanitiser with a real parser (htmlparser2). It's pure JS, so it
 * runs on the Cloudflare Workers runtime (with nodejs_compat) and is covered by
 * `bun test`, unlike DOMPurify which needs a browser DOM.
 *
 * The allowlist matches what the tiptap editor emits, so anything exotic — pasted
 * or typed in source mode — is stripped before we send or store it. Styles never
 * survive: the ones an email needs are added afterwards by `#library/email_render.ts`,
 * from the data attributes listed below.
 */

const options: sanitize.IOptions = {
	allowedTags: [
		"p",
		"br",
		"hr",
		"strong",
		"b",
		"em",
		"i",
		"u",
		"s",
		"strike",
		"mark",
		"sub",
		"sup",
		"h1",
		"h2",
		"h3",
		"ul",
		"ol",
		"li",
		"blockquote",
		"code",
		"pre",
		"span",
		"div",
		"a",
		"img",
		"table",
		"thead",
		"tbody",
		"tr",
		"th",
		"td",
		"colgroup",
		"col",
	],
	allowedAttributes: {
		a: ["href", "target", "rel"],
		// `data-dark-src` is the picture for a dark ground — a logo drawn in paper. The
		// renderer believes only an http(s) address there, since schemes are checked on
		// `src` and not on a data attribute.
		img: ["src", "alt", "title", "width", "height", "data-align", "data-dark-src"],
		th: ["colspan", "rowspan"],
		td: ["colspan", "rowspan"],
		// The editor's block vocabulary rides on data attributes — #library/email_render
		// turns them into inline styles at send time, and strips them.
		p: ["data-align"],
		h1: ["data-align"],
		h2: ["data-align"],
		h3: ["data-align"],
		div: ["data-button", "data-align", "data-spacer", "data-section", "data-outside", "data-inset"],
		// A run of text in one of the brand's colours. The carrier, never a `style` —
		// #library/brand is what decides whether the value is a colour at all, and it is
		// the renderer that turns it into one.
		span: ["data-colour"],
	},
	// Only these URL schemes survive on href/src; javascript:, vbscript:, etc. are dropped.
	allowedSchemes: ["http", "https", "mailto", "tel"],
	// Inline images (the composer offers data-URI images) are allowed on <img> only.
	allowedSchemesByTag: { img: ["http", "https", "data"] },
	allowProtocolRelative: false,
	// New-tab links can't reach back into the opener.
	transformTags: {
		a(tag_name, attribs) {
			if (attribs.target === "_blank") attribs.rel = "noopener noreferrer"
			return { tagName: tag_name, attribs }
		},
	},
}

/** Return a sanitised copy of `input`, safe to drop into an email body or stored payload. */
export function sanitize_html(input: string): string {
	return sanitize(input, options)
}
