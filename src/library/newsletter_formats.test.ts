import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { parseDocument, DomUtils } from "htmlparser2"
import Postboi from "./postboi_provider.js"
import { create_inbox_store, inbox_middleware } from "./inbox_server.js"
let server: Server, client: Postboi, store: ReturnType<typeof create_inbox_store>
const real_fetch = globalThis.fetch
beforeEach(async function () {
	store = create_inbox_store(20)
	const middleware = inbox_middleware(store)
	server = createServer((request, response) =>
		middleware(request, response, () => {
			response.statusCode = 404
			response.end()
		})
	)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (!address || typeof address === "string") throw Error("No local address")
	vi.stubEnv("POSTBOI_INBOX", String(address.port))
	vi.stubEnv("NODE_ENV", "development")
	vi.stubEnv("POSTBOI_TOKEN", "pb_never_hosted")
	vi.stubGlobal(
		"fetch",
		vi.fn(function (input: RequestInfo | URL, init?: RequestInit) {
			const url = new URL(input instanceof Request ? input.url : String(input))
			if (!["127.0.0.1", "localhost"].includes(url.hostname) || Number(url.port) !== address.port)
				throw Error("Hosted request in local format rehearsal")
			return real_fetch(input, init)
		})
	)
	client = new Postboi({ newsletter_local: true })
})
afterEach(async function () {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	await new Promise<void>((resolve) => server.close(() => resolve()))
})
async function fixture() {
	const list = await client.lists.create("News")
	await client.newsletters.configure({
		list_id: list.id,
		slug: "source-formats",
		postal_address: "1 Example Street",
		public_signup: true,
	})
	await client.recipients.add(list.id, [{ email: "reader@example.invalid", name: "<Ada>" }], {
		status: "subscribed",
	})
	return list
}
it("local source formats retain Markdown/CSS, protect revision/format, and capture mandatory choice links without a hosted fallback", async function () {
	const list = await fixture()
	for (const body_format of ["markdown", "html_document"] as const) {
		const source =
			body_format === "markdown"
				? "# News\n\n**Hello** {name|there}\n\n<script>bad()</script>"
				: '<!doctype html><html><head><style>td {color:#123;padding:12px}</style></head><body><!-- </body> --><table width="600"><tr><td>Hello {name|upper}</td></tr></table></body></html>'
		const draft = await client.campaigns.create({
			name: "News",
			list_id: list.id,
			subject: "News",
			sender: "news@example.invalid",
			body: source,
			body_format,
			preheader: "Preview {name}",
			footnote: "Footer {name}",
		})
		expect(draft.body_format).toBe(body_format)
		if (body_format === "html_document") expect(draft.letterhead).toBe(0)
		const { body_format: _format, ...without_format } = draft
		const saved = await client.campaigns.update(draft.id, {
			...without_format,
			revision: draft.revision,
		})
		expect(saved.body_format).toBe(body_format)
		await expect(
			client.campaigns.update(draft.id, { ...saved, body_format: "blocks" })
		).rejects.toMatchObject({ code: "body_format_fixed" })
		await client.campaigns.test(draft.id, "reviewer@example.invalid")
		const capture = store.list()[0]
		expect(capture.html).not.toContain("bad()")
		expect(capture.html).toContain("1 Example Street")
		expect(capture.html).toContain("Manage subscription")
		expect(capture.html).toContain("Footer")
		if (body_format === "html_document") {
			expect(capture.html).toContain('width="600"')
			expect(capture.html).toContain("td {color:#123;padding:12px}")
			expect(capture.html).toContain("display:none")
		} else expect(capture.html).toContain("<strong>Hello</strong>")
		expect((await client.campaigns.duplicate(draft.id)).body_format).toBe(body_format)
	}
})
it("local HTML drafts and unsupported source refuse honestly before capture", async function () {
	const list = await fixture(),
		draft = await client.campaigns.create({
			name: "HTML",
			list_id: list.id,
			subject: "News",
			sender: "news@example.invalid",
			body_format: "html_document",
		})
	expect((await client.campaigns.review(draft.id)).blocking).toContain("Write the email body.")
	await expect(
		client.campaigns.create({
			name: "Bad",
			list_id: list.id,
			body_format: "html_document",
			body: "<html><body><!--[if mso]>VML<![endif]--></body></html>",
		})
	).rejects.toMatchObject({ code: "invalid_campaign_document" })
	expect(store.list()).toHaveLength(0)
})

it("custom dark HTML keeps its document and adds a readable independent paper footer", async function () {
	const list = await fixture(),
		draft = await client.campaigns.create({
			name: "Dark source",
			list_id: list.id,
			subject: "News",
			sender: "news@example.invalid",
			body_format: "html_document",
			body: '<html><head><style>p,a {color:#ffffff}</style></head><body style="background:#101010;color:#ffffff"><p>Dark editorial content</p></body></html>',
		})
	await client.campaigns.test(draft.id, "reviewer@example.invalid")
	const html = store.list()[0].html!,
		tree = parseDocument(html)
	expect(html).toContain('style="background:#101010;color:#ffffff"')
	const footer = DomUtils.findAll(
		(node) => node.name === "table" && node.attribs.bgcolor === "#f4efe5",
		tree.children
	)[0]
	expect(footer).toBeDefined()
	const link = DomUtils.findAll((node) => node.name === "a", footer.children).find(
		(node) => DomUtils.textContent(node) === "Manage subscription"
	)!
	expect(link.attribs.style).toContain("color:#161c30")
	for (const paragraph of DomUtils.findAll((node) => node.name === "p", footer.children))
		expect(paragraph.attribs.style).toContain("color:#161c30")
})
