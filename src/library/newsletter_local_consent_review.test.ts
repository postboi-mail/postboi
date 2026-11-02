import { describe, expect, it } from "vitest"
import { create_newsletter_dev } from "./newsletter_dev.js"
import { create_inbox_store } from "./inbox_server.js"

function fixture(configure = true) {
	const store = create_inbox_store(100)
	const dev = create_newsletter_dev(store)
	function request(path: string, method = "GET", body?: unknown) {
		return dev.handle(
			path.split("?")[0],
			method,
			body,
			new URL(`http://localhost/__postboi/api/newsletter${path}`)
		)
	}
	const list = request("/v1/lists", "POST", { name: "Example audience" }).body as { id: string }
	if (configure)
		request("/v1/newsletters", "POST", {
			list_id: list.id,
			slug: "example-audience",
			postal_address: "1 Example Road",
			public_signup: true,
		})
	const path = `/v1/lists/${list.id}/recipients`
	request(path, "POST", [{ email: "reader@example.test", name: "Reader", status: "subscribed" }])
	function status() {
		return (
			request(`/v1/newsletters/${list.id}/audience`).body as { contacts: Array<{ status: string }> }
		).contacts[0]?.status
	}
	function signup() {
		request(`/v1/newsletters/${list.id}/signups`, "POST", {
			email: "reader@example.test",
			consent: true,
		})
		const match = store.list()[0].text?.match(/\/__postboi\/api\/newsletter\/confirm\?token=[\w-]+/)
		if (!match) throw Error("No confirmation capture")
		return match[0].replace("/__postboi/api/newsletter", "")
	}
	function preferences() {
		const campaign = request("/v1/campaigns", "POST", {
			name: "Review",
			list_id: list.id,
			sender: "news@example.test",
			subject: "Hello",
			body: "<p>Example update</p>",
		}).body as { id: string; revision: number }
		request(`/v1/campaigns/${campaign.id}/launch`, "POST", {
			revision: campaign.revision,
			timezone: "UTC",
		})
		request(`/v1/campaigns/${campaign.id}/run`, "POST", {})
		const match = store
			.list()[0]
			.html?.match(/\/__postboi\/api\/newsletter\/preferences\?token=[\w-]+/)
		if (!match) throw Error("No preference capture")
		return match[0].replace("/__postboi/api/newsletter", "")
	}
	return { request, list, path, status, signup, preferences, store }
}

describe("independent local newsletter consent review", () => {
	it("an unused confirmation issued before a later opt-out cannot restore subscription", () => {
		const f = fixture(),
			preferences = f.preferences(),
			old = f.signup()
		f.request(preferences, "POST")
		expect(f.status()).toBe("unsubscribed")
		expect(() => f.request(old, "POST")).toThrow()
		expect(f.status()).toBe("unsubscribed")
	})
	it("a repeated explicit opt-out invalidates a fresh pending confirmation even when already unsubscribed", () => {
		const f = fixture(),
			preferences = f.preferences()
		f.request(preferences, "POST")
		const pending = f.signup()
		f.request(preferences, "POST")
		expect(() => f.request(pending, "POST")).toThrow()
		expect(f.status()).toBe("unsubscribed")
	})
	it("newsletter opt-out evidence survives removing and re-adding the email as subscribed or pending", () => {
		for (const status of ["subscribed", "pending"]) {
			const f = fixture(),
				preferences = f.preferences()
			f.request(preferences, "POST")
			f.request(`${f.path}?email=reader%40example.test`, "DELETE")
			f.request(f.path, "POST", [{ email: "READER@example.test", status }])
			expect(f.status()).toBe("unsubscribed")
		}
	})
	it("a fresh post-opt-out confirmation restores only its own newsletter, then becomes unusable", () => {
		const f = fixture(),
			preferences = f.preferences()
		f.request(preferences, "POST")
		const fresh = f.signup()
		f.request(fresh, "GET")
		expect(f.status()).toBe("unsubscribed")
		f.request(fresh, "POST")
		expect(f.status()).toBe("subscribed")
		f.request(preferences, "POST")
		expect(() => f.request(fresh, "POST")).toThrow()
		expect(f.status()).toBe("unsubscribed")
	})
	it("manual newsletter restoration is refused clearly while ordinary list manual status changes remain available", () => {
		const strict = fixture()
		strict.request(strict.path, "PATCH", { email: "reader@example.test", status: "unsubscribed" })
		expect(() =>
			strict.request(strict.path, "PATCH", { email: "reader@example.test", status: "subscribed" })
		).toThrowError(expect.objectContaining({ code: "newsletter_confirmation_required" }))
		expect(strict.status()).toBe("unsubscribed")
		const ordinary = fixture(false)
		ordinary.request(ordinary.path, "PATCH", {
			email: "reader@example.test",
			status: "unsubscribed",
		})
		const restored = ordinary.request(ordinary.path, "PATCH", {
			email: "reader@example.test",
			status: "subscribed",
		}).body
		expect(restored).toMatchObject({ status: "subscribed" })
	})
})
it("local captures use the launch-time recipient name and fields while still checking current consent", () => {
	const f = fixture()
	f.request(f.path, "POST", [
		{
			email: "reader@example.test",
			name: "Before",
			data: { house: "North" },
			status: "subscribed",
		},
	])
	const draft = f.request("/v1/campaigns", "POST", {
		name: "Snapshot",
		list_id: f.list.id,
		sender: "news@example.test",
		subject: "Hello {name}",
		body: "<p>{name}: {house}</p>",
	}).body as { id: string; revision: number }
	f.request(`/v1/campaigns/${draft.id}/launch`, "POST", {
		revision: draft.revision,
		timezone: "UTC",
	})
	f.request(f.path, "POST", [
		{ email: "reader@example.test", name: "After", data: { house: "South" }, status: "subscribed" },
	])
	f.request(`/v1/campaigns/${draft.id}/run`, "POST", {})
	expect(f.store.list()[0].subject).toBe("Hello Before")
	expect(f.store.list()[0].html).toContain("Before: North")
	expect(f.store.list()[0].html).not.toContain("After: South")
})
it("local personalization agrees with hosted filters, escaping and usable purpose-bound preferences URLs", () => {
	const f = fixture()
	f.request(f.path, "POST", [
		{ email: "reader@example.test", name: "Ada <Lane>", status: "subscribed" },
	])
	const draft = f.request("/v1/campaigns", "POST", {
		name: "Personalization",
		list_id: f.list.id,
		sender: "news@example.test",
		subject: "{name|first|upper}",
		body: '<p>{name|upper}</p><p>{missing|first|}</p><a href="{preferences_url}">Preferences</a>',
	}).body as { id: string; revision: number }
	f.request(`/v1/campaigns/${draft.id}/launch`, "POST", {
		revision: draft.revision,
		timezone: "UTC",
	})
	f.request(`/v1/campaigns/${draft.id}/run`, "POST", {})
	const capture = f.store.list()[0]
	expect(capture.subject).toBe("ADA")
	expect(capture.html).toContain("ADA &lt;LANE&gt;")
	expect(capture.html).toContain("<p>first</p>")
	const preferences = capture.html?.match(/href="([^"]*\/preferences\?token=[\w-]+)"/)?.[1]
	expect(preferences).toBeTruthy()
	expect(() =>
		f.request(
			preferences!.replace("/__postboi/api/newsletter", "").replace("/preferences?", "/confirm?"),
			"POST"
		)
	).toThrow()
	expect(f.status()).toBe("subscribed")
})
it("a test capture cannot issue a preference capability for the sampled reader", () => {
	const f = fixture(),
		audience = f.request(`/v1/newsletters/${f.list.id}/audience`).body as {
			contacts: Array<{ id: string }>
		}
	const draft = f.request("/v1/campaigns", "POST", {
		name: "Test",
		list_id: f.list.id,
		sender: "news@example.test",
		subject: "Hello {name}",
		body: "<p>Example update</p>",
	}).body as { id: string }
	f.request(`/v1/campaigns/${draft.id}/test`, "POST", {
		email: "reviewer@example.test",
		sample_contact_id: audience.contacts[0].id,
	})
	const captured = f.store.list()[0]
	expect(captured.to).toEqual([{ address: "reviewer@example.test" }])
	const preferences = captured.html?.match(
		/\/__postboi\/api\/newsletter\/preferences\?token=[\w-]+/
	)?.[0]
	if (preferences) {
		try {
			f.request(preferences.replace("/__postboi/api/newsletter", ""), "POST")
		} catch {
			/* A non-member test recipient has no local subscription to stop. */
		}
	}
	expect(f.status()).toBe("subscribed")
})
it("removing a subscribed reader does not invent an opt-out, including on ordinary lists", () => {
	for (const configured of [true, false]) {
		const f = fixture(configured)
		f.request(`${f.path}?email=reader%40example.test`, "DELETE")
		f.request(f.path, "POST", [{ email: "reader@example.test", status: "subscribed" }])
		const recipients = f.request(f.path).body as { recipients: Array<{ status: string }> }
		expect(recipients.recipients[0].status).toBe("subscribed")
	}
})
it("local newsletter addresses follow the exact hosted slug contract", () => {
	const f = fixture()
	expect(() =>
		f.request("/v1/newsletters", "POST", {
			list_id: f.list.id,
			slug: "a",
			postal_address: "1 Example Road",
		})
	).not.toThrow()
	expect(() =>
		f.request("/v1/newsletters", "POST", {
			list_id: f.list.id,
			slug: "bad-",
			postal_address: "1 Example Road",
		})
	).toThrow()
	expect(() =>
		f.request("/v1/newsletters", "POST", {
			list_id: f.list.id,
			slug: "a".repeat(65),
			postal_address: "1 Example Road",
		})
	).toThrow()
})
it("configuring an ordinary list preserves its current opt-out and immediately refuses manual newsletter restoration", () => {
	const f = fixture(false)
	f.request(f.path, "PATCH", { email: "reader@example.test", status: "unsubscribed" })
	f.request("/v1/newsletters", "POST", {
		list_id: f.list.id,
		slug: "converted",
		postal_address: "1 Example Road",
	})
	expect(() =>
		f.request(f.path, "PATCH", { email: "reader@example.test", status: "subscribed" })
	).toThrowError(expect.objectContaining({ code: "newsletter_confirmation_required" }))
	expect(f.status()).toBe("unsubscribed")
})
