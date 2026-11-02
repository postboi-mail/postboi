import { expect, test } from "vitest"
import { create_inbox_store } from "./inbox_server.js"
import { create_newsletter_dev, DevNewsletterError } from "./newsletter_dev.js"

test("local automation bounds expanded content and still captures the next valid reader", function () {
	const captures = create_inbox_store(),
		local = create_newsletter_dev(captures)
	function request<T = Record<string, unknown>>(path: string, method = "GET", input?: unknown): T {
		return local.handle(path, method, input, new URL("http://127.0.0.1" + path)).body as T
	}
	const list = request("/v1/lists", "POST", { name: "Review" })
	request("/v1/newsletters", "POST", {
		list_id: list.id,
		slug: "review",
		postal_address: "1 Test Street",
		public_signup: true,
	})
	request(`/v1/lists/${list.id}/recipients`, "POST", [
		{ email: "large@example.test", status: "subscribed", data: { bio: "x".repeat(1000) } },
		{ email: "valid@example.test", status: "subscribed", data: { bio: "ok" } },
	])
	const readers = request<{ contacts: Array<{ id: string }> }>(
		`/v1/newsletters/${list.id}/audience`
	).contacts
	const tag = request(`/v1/newsletters/${list.id}/tags`, "POST", { name: "Trigger" })
	const rule = request(`/v1/newsletters/${list.id}/rules`, "POST", {
		name: "Expanded",
		trigger_tag_id: tag.tag_id,
		subject: "Hello",
		body: "<p>" + "{bio}".repeat(2000) + "</p>",
		sender: "news@example.test",
	})
	request(`/v1/newsletters/${list.id}/rules/${rule.id}/enable`, "POST", {
		revision: 1,
		confirm: true,
	})
	request(`/v1/newsletters/${list.id}/tags`, "POST", {
		name: "Trigger",
		contact_ids: readers.map((reader: { id: string }) => reader.id),
	})
	expect(() =>
		request(`/v1/newsletters/${list.id}/rules/${rule.id}/preview`, "POST", {
			sample_contact_id: readers[0].id,
		})
	).toThrow(DevNewsletterError)
	expect(captures.list()).toHaveLength(0)
	const result = request(`/v1/newsletters/${list.id}/rules/${rule.id}/run`, "POST", {})
	expect(result).toMatchObject({ captured: 1, blocked: 1, pending: 0 })
	expect(captures.list()).toHaveLength(1)
	expect(captures.list()[0].to[0].address).toBe("valid@example.test")
})
