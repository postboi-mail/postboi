import { expect, it } from "vitest"
import { parseDocument, DomUtils } from "htmlparser2"
import { create_newsletter_dev } from "./newsletter_dev.js"
import { create_inbox_store } from "./inbox_server.js"
function fixture() {
	const store = create_inbox_store(100),
		dev = create_newsletter_dev(store)
	function request(path: string, method = "GET", body?: unknown) {
		return structuredClone(
			dev.handle(
				path.split("?")[0],
				method,
				body,
				new URL("http://localhost/__postboi/api/newsletter" + path)
			).body
		)
	}
	const list = request("/v1/lists", "POST", { name: "News" }) as { id: string }
	request("/v1/newsletters", "POST", {
		list_id: list.id,
		slug: "independent-formats",
		postal_address: "Original Road",
		public_signup: true,
	})
	request(`/v1/lists/${list.id}/recipients`, "POST", [
		{
			email: "first@example.invalid",
			name: "Original reader",
			data: { code: "original-code" },
			status: "subscribed",
		},
		{ email: "second@example.invalid", name: "Other reader", status: "subscribed" },
	])
	return { request, store, list }
}
it("local HTML launch freezes source, mode, contact values and postal details while opt-outs remain fresh", () => {
	const f = fixture(),
		source =
			"<html><head><style>td { color: navy }</style></head><body><table><tr><td>Hello {name|upper}, {code}</td></tr></table></body></html>",
		draft = f.request("/v1/campaigns", "POST", {
			name: "HTML news",
			list_id: f.list.id,
			subject: "News",
			sender: "news@example.invalid",
			body_format: "html_document",
			body: source,
		}) as { id: string; revision: number }
	f.request(`/v1/campaigns/${draft.id}/launch`, "POST", {
		revision: draft.revision,
		timezone: "UTC",
	})
	f.request(`/v1/lists/${f.list.id}/recipients`, "POST", [
		{
			email: "first@example.invalid",
			name: "Changed reader",
			data: { code: "changed-code" },
			status: "subscribed",
		},
		{ email: "second@example.invalid", status: "unsubscribed" },
	])
	f.request("/v1/newsletters", "POST", {
		list_id: f.list.id,
		slug: "independent-formats",
		postal_address: "Changed Road",
		public_signup: true,
	})
	f.request(`/v1/campaigns/${draft.id}/run`, "POST", {})
	expect(f.store.list()).toHaveLength(1)
	const capture = f.store.list()[0]
	expect(capture.html).toContain("ORIGINAL READER")
	expect(capture.html).toContain("original-code")
	expect(capture.html).not.toContain("changed-code")
	expect(capture.html).toContain("Original Road")
	expect(capture.html).not.toContain("Changed Road")
	expect(capture.html).toContain("td { color: navy }")
	expect(capture.html).toContain("Manage subscription")
})
it("local invalid HTML saves cannot overwrite the original source or advance its revision", () => {
	const f = fixture(),
		source = "<html><body><p>Original body</p></body></html>",
		draft = f.request("/v1/campaigns", "POST", {
			name: "HTML",
			list_id: f.list.id,
			subject: "News",
			sender: "news@example.invalid",
			body_format: "html_document",
			body: source,
		}) as { id: string; revision: number; body: string }
	expect(() =>
		f.request(`/v1/campaigns/${draft.id}`, "PUT", { ...draft, body: "", revision: draft.revision })
	).toThrow()
	expect(f.request(`/v1/campaigns/${draft.id}`)).toMatchObject({
		revision: draft.revision,
		body: draft.body,
		body_format: "html_document",
	})
	expect(f.store.list()).toHaveLength(0)
})
it("local Markdown captures resolve a personalized URL and image instead of encoded template syntax", () => {
	const f = fixture(),
		portal = "https://members.example.test/profile",
		avatar = "https://images.example.test/avatar.png"
	f.request(`/v1/lists/${f.list.id}/recipients`, "POST", [
		{
			email: "first@example.invalid",
			data: { portal_url: portal, avatar_url: avatar },
			status: "subscribed",
		},
		{ email: "second@example.invalid", status: "unsubscribed" },
	])
	const draft = f.request("/v1/campaigns", "POST", {
		name: "Markdown",
		list_id: f.list.id,
		subject: "News",
		sender: "news@example.invalid",
		body_format: "markdown",
		body: "[Manage]({portal_url})\n\n![Portrait]({avatar_url})",
	}) as { id: string; revision: number }
	f.request(`/v1/campaigns/${draft.id}/launch`, "POST", {
		revision: draft.revision,
		timezone: "UTC",
	})
	f.request(`/v1/campaigns/${draft.id}/run`, "POST", {})
	expect(f.store.list()).toHaveLength(1)
	const tree = parseDocument(f.store.list()[0].html!),
		anchor = DomUtils.findAll((node) => node.name === "a", tree.children).find(
			(node) => DomUtils.textContent(node) === "Manage"
		)!,
		image = DomUtils.findAll((node) => node.name === "img", tree.children).find(
			(node) => node.attribs.alt === "Portrait"
		)!
	expect(anchor.attribs.href).toBe(portal)
	expect(image.attribs.src).toBe(avatar)
})
