import { expect, test } from "vitest"
import { create_inbox_store } from "./inbox_server.js"
import { create_newsletter_dev } from "./newsletter_dev.js"

test("local Markdown refuses scripting URLs after reader personalization", function () {
	const captures = create_inbox_store(),
		local = create_newsletter_dev(captures)
	function request<T = Record<string, unknown>>(path: string, method = "GET", input?: unknown): T {
		return local.handle(path, method, input, new URL("http://127.0.0.1" + path)).body as T
	}
	const list = request("/v1/lists", "POST", { name: "Security review" })
	request("/v1/newsletters", "POST", {
		list_id: list.id,
		slug: "security-review",
		postal_address: "1 Test Street",
		public_signup: true,
	})
	request(`/v1/lists/${list.id}/recipients`, "POST", [
		{ email: "reader@example.test", status: "subscribed", data: { url: "javascript:alert(1)" } },
	])
	const readers = request<{ contacts: Array<{ id: string }> }>(
		`/v1/newsletters/${list.id}/audience`
	).contacts
	const draft = request("/v1/campaigns", "POST", {
		list_id: list.id,
		name: "Security",
		subject: "Review",
		sender: "news@example.test",
		body_format: "markdown",
		body: '# News\n\n<a href="{url}">Read the story</a>',
	})
	request(`/v1/campaigns/${draft.id}/test`, "POST", {
		email: "reviewer@example.test",
		sample_contact_id: readers[0].id,
	})
	expect(captures.list()).toHaveLength(1)
	expect(captures.list()[0].html).not.toMatch(/href="javascript:/i)
	expect(captures.list()[0].html).toContain("Read the story")
})
