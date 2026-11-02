import { expect, test } from "vitest"
import { parseDocument, DomUtils } from "htmlparser2"
import { campaign_body_format, html_document, markdown_body } from "./campaign_document.js"
test("formats are explicit and Markdown uses a maintained parser", function () {
	expect(campaign_body_format(undefined)).toBe("blocks")
	for (const value of [[], {}, "html", true])
		expect(() => campaign_body_format(value)).toThrow("Choose blocks")
	const html = markdown_body(
		"# News\n\n**Welcome** [read more](https://example.test)\n\n- One\n- Two\n\n| A | B |\n| - | - |\n| 1 | 2 |"
	)
	expect(html).toContain("<h1>News</h1>")
	expect(html).toContain("<strong>Welcome</strong>")
	expect(html).toContain("<table>")
})
test("complete HTML retains ordinary email layout/CSS and inserts trusted fragments into the real body", function () {
	const output = html_document(
		'<!doctype html><html lang="en"><head><style>td { color: #123; padding: 12px; }</style></head><body bgcolor="#ffffff"><!-- Fake closing body: </body> --><table width="600" role="presentation"><tr><td style="font-family:Arial;color:#123">News</td></tr></table></body></html>',
		{
			prepend: '<div id="preheader">Preview</div>',
			append: '<div id="footer"><a href="https://postboi.app/unsubscribe">Unsubscribe</a></div>',
		}
	)
	expect(output).toContain("td { color: #123; padding: 12px; }")
	expect(output).toContain('width="600"')
	expect(output).toContain('style="font-family:Arial;color:#123"')
	const body = DomUtils.findOne((node) => node.name === "body", parseDocument(output).children)!
	expect(body.children[0]).toMatchObject({ name: "div", attribs: { id: "preheader" } })
	expect(body.children.at(-1)).toMatchObject({ name: "div", attribs: { id: "footer" } })
	expect(output).not.toContain("Fake closing body")
})
test("active content and scripting URLs cannot survive a source document", function () {
	const output = html_document(
		'<html><head><meta http-equiv="refresh" content="0;https://bad.example"><script>evil()</script><base href="https://bad.example"></head><body onload="evil()"><form><input name="password"></form><iframe srcdoc="evil"></iframe><a href="java&#x0a;script:evil()" onclick="evil()">Safe text</a><img src="https://example.test/logo.png" onerror="evil()"></body></html>'
	)
	for (const value of [
		"<script",
		"onload",
		"onclick",
		"onerror",
		"<form",
		"<input",
		"<iframe",
		"<base",
		"http-equiv",
		"javascript:",
	])
		expect(output).not.toContain(value)
	expect(output).toContain("Safe text")
	expect(output).toContain("https://example.test/logo.png")
})
test("unsupported source layouts refuse clearly before any partial layout is used", function () {
	for (const source of [
		"<p>A fragment</p>",
		"<html><body>One</body><body>Two</body></html>",
		"<html><body><!--[if mso]><table><![endif]--></body></html>",
		"<html><body><v:rect>Outlook</v:rect></body></html>",
		'<html><body><img src="https://example.test/a" srcset="https://example.test/b 2x"></body></html>',
		'<html><body><div style="background:expre/**/ssion(alert(1))">Unsafe</div></body></html>',
		"<html><body><style>a {background:url(j\\61vascript:evil)}</style></body></html>",
	])
		expect(() => html_document(source)).toThrow()
	expect(() =>
		html_document(`<html><body>${"<div>".repeat(110)}News${"</div>".repeat(110)}</body></html>`)
	).toThrow("nested layers")
})

test("multi-node preheader/footer fragments retain every sibling in order", function () {
	const output = html_document("<html><body><p>Authored</p></body></html>", {
		prepend: "<p>First</p><p>Second</p>",
		append: "<p>Postal</p><p>Preferences</p><p>Footnote</p>",
	})
	const body = DomUtils.findOne((node) => node.name === "body", parseDocument(output).children)!
	expect(body.children.map((node) => DomUtils.textContent(node))).toEqual([
		"First",
		"Second",
		"Authored",
		"Postal",
		"Preferences",
		"Footnote",
	])
})

test("serialization growth is bounded before an expanded document can be stored", function () {
	expect(() => html_document(`<html><body>${"&".repeat(130000)}</body></html>`)).toThrow("600 KB")
})
