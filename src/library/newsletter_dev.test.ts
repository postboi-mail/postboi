import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import Postboi from "./postboi_provider.js"
import { mail } from "./mail.js"
import { create_inbox_store, inbox_middleware } from "./inbox_server.js"
import { create_newsletter_dev, DevNewsletterError } from "./newsletter_dev.js"

let server: Server, root: string, client: Postboi, captures: ReturnType<typeof create_inbox_store>
const real_fetch = globalThis.fetch
beforeEach(async () => {
	captures = create_inbox_store(500)
	const middleware = inbox_middleware(captures)
	server = createServer((req, res) =>
		middleware(req, res, () => {
			res.statusCode = 404
			res.end()
		})
	)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (!address || typeof address === "string") throw Error("No local server")
	root = `http://127.0.0.1:${address.port}`
	vi.stubEnv("POSTBOI_INBOX", String(address.port))
	vi.stubEnv("NODE_ENV", "development")
	vi.stubEnv("POSTBOI_TOKEN", "pb_must_never_leave_this_test")
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			if (!["localhost", "127.0.0.1"].includes(url.hostname) || Number(url.port) !== address.port)
				throw Error(`Hosted transport was attempted: ${url.origin}`)
			if (new Headers(init?.headers).get("authorization")?.includes("pb_must_never"))
				throw Error("A hosted token was forwarded to the inbox")
			return real_fetch(input, init)
		})
	)
	client = new Postboi({ newsletter_local: true, token: "pb_must_never_leave_this_test" })
})
afterEach(async () => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	await new Promise<void>((resolve) => server.close(() => resolve()))
})
async function fixture(count = 1) {
	const list = await client.lists.create("Weekly news")
	await client.newsletters.configure({
		list_id: list.id,
		slug: "weekly-news",
		postal_address: "1 Example Road",
		public_signup: true,
	})
	await client.recipients.add(
		list.id,
		Array.from({ length: count }, (_, i) => ({
			email: `reader${i}@example.test`,
			name: i === 0 ? "<Ada>" : `Reader ${i}`,
		})),
		{ status: "subscribed" }
	)
	const draft = await client.campaigns.create({
		name: "November",
		list_id: list.id,
		sender: "news@example.test",
		subject: "Hello {name|there}",
		body: "<h1>Hello {name|there}</h1><p>The news.</p>",
	})
	return { list, draft }
}
async function local(path: string, method = "GET", body?: unknown) {
	return fetch(root + "/__postboi/api/newsletter" + path, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

describe("newsletter rehearsal through the real dev inbox HTTP surface", () => {
	it("preserves revision, draft review, recipient preview and explicit test routing without hosted transport", async () => {
		const { list, draft } = await fixture()
		expect((await client.campaigns.review(draft.id)).blocking).toEqual([])
		const saved = await client.campaigns.update(draft.id, {
			...draft,
			name: "Edited",
			revision: 1,
			letterhead: true,
			tracking_opens: false,
			tracking_clicks: false,
		})
		expect(saved.revision).toBe(2)
		await expect(
			client.campaigns.update(draft.id, { name: "Stale", list_id: list.id, revision: 1 })
		).rejects.toMatchObject({ code: "revision_conflict" })
		const audience = await client.newsletters.audience(list.id)
		await client.campaigns.test(draft.id, "reviewer@example.test", {
			sample_contact_id: audience.contacts[0].id,
		})
		expect(captures.list()).toHaveLength(1)
		expect(captures.list()[0].to).toEqual([{ address: "reviewer@example.test" }])
		expect(captures.list()[0].html).toContain("&lt;Ada&gt;")
		expect(await client.campaigns.preview(draft.id)).toContain("#local-preview")
		expect(captures.list()).toHaveLength(1)
		await expect(client.campaigns.launch(draft.id, { revision: 1 })).rejects.toMatchObject({
			code: "revision_conflict",
		})
	})
	it("captures bounded due pages once, respects pause and new opt-outs, and never calls capture a delivery", async () => {
		const { list, draft } = await fixture(205)
		await client.campaigns.launch(draft.id, { revision: 1, timezone: "Europe/London" })
		await client.campaigns.pause(draft.id)
		expect((await (await local(`/v1/campaigns/${draft.id}/run`, "POST", {})).json()).accepted).toBe(
			0
		)
		await client.recipients.set_status(list.id, "reader0@example.test", "unsubscribed")
		await client.campaigns.resume(draft.id)
		const first = await (await local(`/v1/campaigns/${draft.id}/run`, "POST", {})).json()
		expect(first).toMatchObject({
			captured: 99,
			accepted: 99,
			excluded: 1,
			delivered: 0,
			opened: 0,
		})
		const second = await (await local(`/v1/campaigns/${draft.id}/run`, "POST", {})).json()
		expect(second).toMatchObject({ captured: 100, accepted: 199 })
		await local(`/v1/campaigns/${draft.id}/run`, "POST", {})
		await local(`/v1/campaigns/${draft.id}/run`, "POST", {})
		expect(captures.list()).toHaveLength(204)
		expect((await client.campaigns.get(draft.id)).status).toBe("completed")
		expect(await client.campaigns.report(draft.id)).toMatchObject({
			accepted: 204,
			excluded: 1,
			delivered: 0,
		})
		await expect(client.campaigns.resend(draft.id, "retry")).rejects.toMatchObject({
			code: "local_delivery_unobserved",
		})
	})
	it("future schedules remain pending, cancellation cannot be resumed and launched content is immutable", async () => {
		const { list, draft } = await fixture()
		await client.campaigns.launch(draft.id, {
			revision: 1,
			scheduled_at: "2099-01-01T10:00:00Z",
			timezone: "UTC",
		})
		await local(`/v1/campaigns/${draft.id}/run`, "POST", {})
		expect(captures.list()).toHaveLength(0)
		await expect(
			client.campaigns.update(draft.id, { name: "Changed", list_id: list.id, revision: 1 })
		).rejects.toMatchObject({ code: "campaign_immutable" })
		await client.campaigns.cancel(draft.id)
		await expect(client.campaigns.resume(draft.id)).rejects.toMatchObject({ code: "invalid_state" })
		expect((await client.campaigns.report(draft.id)).canceled).toBe(1)
	})
	it("signup captures a confirmation; GET and purpose swapping never subscribe, POST consumes it once", async () => {
		const { list } = await fixture()
		await expect(
			client.newsletters.signup(list.id, { email: "new@example.test", consent: false as true })
		).rejects.toMatchObject({ code: "consent_required" })
		expect(captures.list()).toHaveLength(0)
		await client.newsletters.signup(list.id, {
			email: "new@example.test",
			name: "New",
			consent: true,
		})
		const message = captures.list()[0],
			match = message.text!.match(/\/__postboi\/api\/newsletter\/confirm\?token=[\w-]+/)!
		const confirm = root + match[0]
		const confirmation_page = await real_fetch(confirm)
		expect(confirmation_page.status).toBe(200)
		expect(confirmation_page.headers.get("referrer-policy")).toBe("same-origin")
		expect(
			(
				await real_fetch(confirm, {
					method: "POST",
					headers: { origin: "https://foreign.example" },
				})
			).status
		).toBe(403)
		expect(
			(await real_fetch(confirm, { method: "POST", headers: { origin: "null" } })).status
		).toBe(403)
		expect(
			(await client.newsletters.audience(list.id, { search: "new@" })).contacts[0].status
		).toBe("pending")
		expect(
			(await real_fetch(confirm.replace("/confirm?", "/preferences?"), { method: "POST" })).status
		).toBe(410)
		expect((await real_fetch(confirm, { method: "POST" })).status).toBe(200)
		expect((await real_fetch(confirm, { method: "POST" })).status).toBe(410)
		expect(
			(await client.newsletters.audience(list.id, { search: "new@" })).contacts[0].status
		).toBe("subscribed")
	})
	it("CSV dry runs do not send or change audiences; page retries preserve unsubscribe and suppress cleaned contacts globally", async () => {
		const { list } = await fixture()
		await client.recipients.set_status(list.id, "reader0@example.test", "unsubscribed")
		const input = {
			csv: "Email Address,Email Marketing Status,First Name\nreader0@example.test,subscribed,Ada\nclean@example.test,cleaned,Clean\nfresh@example.test,subscribed,Fresh",
			filename: "audience.csv",
			default_status: "pending" as const,
			consent_confirmed: true,
		}
		const preview = await client.newsletters.imports.preview(list.id, input)
		expect(captures.list()).toHaveLength(0)
		expect((await client.newsletters.audience(list.id)).total).toBe(1)
		await client.newsletters.imports.apply(list.id, preview.import.id)
		await client.newsletters.imports.apply(list.id, preview.import.id)
		expect((await client.newsletters.imports.preview(list.id, input)).import.id).toBe(
			preview.import.id
		)
		expect(
			(await client.newsletters.audience(list.id)).contacts.map((reader) => [
				reader.email,
				reader.status,
			])
		).toEqual([
			["reader0@example.test", "unsubscribed"],
			["clean@example.test", "unsubscribed"],
			["fresh@example.test", "subscribed"],
		])
		expect(captures.list()).toHaveLength(0)
	})
	it("local preferences revoke only that list, and captured signed links do not mutate on GET", async () => {
		const { list, draft } = await fixture()
		await client.campaigns.launch(draft.id, { revision: 1 })
		await local(`/v1/campaigns/${draft.id}/run`, "POST", {})
		const html = captures.list()[0].html!,
			path = html.match(/href="([^"]+\/preferences\?token=[\w-]+)"/)![1]
		await real_fetch(root + path)
		expect((await client.newsletters.audience(list.id)).contacts[0].status).toBe("subscribed")
		await real_fetch(root + path, { method: "POST" })
		expect((await client.newsletters.audience(list.id)).contacts[0].status).toBe("unsubscribed")
	})
	it("does not forward credentials or fall back to hosted services when the inbox is off or gone", async () => {
		vi.stubEnv("POSTBOI_INBOX", "off")
		const spy = vi.mocked(globalThis.fetch)
		spy.mockClear()
		await expect(client.campaigns.all()).rejects.toMatchObject({ code: "local_inbox_unavailable" })
		expect(spy).not.toHaveBeenCalled()
		await expect(mail.campaigns.all()).rejects.toMatchObject({ code: "local_inbox_unavailable" })
		expect(spy).not.toHaveBeenCalled()
	})
	it("guards browser mutations, escapes local reader profiles and exposes the newsletter workspace", async () => {
		const { list } = await fixture()
		const bad = await real_fetch(
			root + `/__postboi/api/newsletter/v1/newsletters/${list.id}/signups`,
			{
				method: "POST",
				headers: { origin: "https://other.example", "content-type": "application/json" },
				body: JSON.stringify({ email: "bad@example.test", consent: true }),
			}
		)
		expect(bad.status).toBe(403)
		const workspace = await real_fetch(root + "/__postboi/newsletters")
		expect(await workspace.text()).toContain("Launch reviewed revision locally")
		expect(captures.list()).toHaveLength(0)
	})
})

it("rejects invalid draft size and does not manufacture delivery reports", () => {
	const store = create_inbox_store(),
		dev = create_newsletter_dev(store)
	const request = (path: string, method: string, body?: unknown) =>
		dev.handle(path, method, body, new URL("http://localhost"))
	const list = request("/v1/lists", "POST", { name: "Example" }).body as { id: string }
	expect(() =>
		request("/v1/campaigns", "POST", {
			name: "Too big",
			list_id: list.id,
			body: "a".repeat(200001),
		})
	).toThrow(DevNewsletterError)
	expect(store.list()).toHaveLength(0)
})

it("captures only future explicit rule triggers, with revision approval, inert preview and pause cancellation", async () => {
	const { list } = await fixture()
	const reader = (await client.newsletters.audience(list.id)).contacts[0]
	const trigger = await client.newsletters.tags.create(list.id, "Event ready")
	const completion = await client.newsletters.tags.create(list.id, "Event complete")
	const input = {
		name: "Event follow-up",
		trigger_tag_id: trigger.tag_id,
		completion_tag_id: completion.tag_id,
		sender: "news@example.test",
		subject: "Hello {name|there}",
		body: "<p>Thank you. {preferences_url}</p>",
	}
	const rule = await client.newsletters.rules.create(list.id, input)
	expect(rule.enabled).toBe(0)
	await client.newsletters.tags.create(list.id, "Event ready", {
		contact_ids: [reader.id],
		event_id: "before-enable",
	})
	expect(
		(await (await local(`/v1/newsletters/${list.id}/rules/${rule.id}/run`, "POST", {})).json())
			.captured
	).toBe(0)
	const preview = await client.newsletters.rules.preview(list.id, rule.id, {
		sample_contact_id: reader.id,
	})
	expect(preview.html).toContain("#local-preview")
	expect(captures.list()).toHaveLength(0)
	await expect(
		client.newsletters.rules.enable(list.id, rule.id, { revision: 99, confirm: true })
	).rejects.toMatchObject({ code: "revision_conflict" })
	expect(
		(await local(`/v1/newsletters/${list.id}/rules/${rule.id}/enable`, "POST", { revision: 1 }))
			.status
	).toBe(400)
	expect((await client.newsletters.rules.review(list.id, rule.id)).ready).toBe(true)
	await client.newsletters.rules.enable(list.id, rule.id, { revision: 1, confirm: true })
	await expect(
		client.newsletters.rules.update(list.id, rule.id, { ...input, revision: 1 })
	).rejects.toMatchObject({ code: "rule_enabled" })
	await client.newsletters.tags.remove(list.id, trigger.tag_id, reader.id)
	await client.newsletters.tags.create(list.id, "Event ready", {
		contact_ids: [reader.id],
		event_id: "paused-intent",
	})
	await client.newsletters.rules.pause(list.id, rule.id, { revision: 1 })
	await client.newsletters.rules.enable(list.id, rule.id, { revision: 1, confirm: true })
	expect(
		(await (await local(`/v1/newsletters/${list.id}/rules/${rule.id}/run`, "POST", {})).json())
			.captured
	).toBe(0)
	await client.newsletters.tags.remove(list.id, trigger.tag_id, reader.id)
	await client.newsletters.tags.create(list.id, "Event ready", {
		contact_ids: [reader.id],
		event_id: "fresh-intent",
	})
	const report = await (
		await local(`/v1/newsletters/${list.id}/rules/${rule.id}/run`, "POST", {})
	).json()
	expect(report).toMatchObject({ local: true, captured: 1, blocked: 1, delivered: 0, opened: 0 })
	expect(captures.list()).toHaveLength(1)
	expect((await client.newsletters.audience(list.id)).contacts[0].tag_ids).toContain(
		completion.tag_id
	)
	expect(
		(await (await local(`/v1/newsletters/${list.id}/rules/${rule.id}/run`, "POST", {})).json())
			.captured
	).toBe(0)
	await client.newsletters.rules.pause(list.id, rule.id, { revision: 1 })
	const changed = await client.newsletters.rules.update(list.id, rule.id, {
		...input,
		revision: 1,
		subject: "Edited",
	})
	expect(changed).toMatchObject({ revision: 2, enabled: 0, reviewed_revision: null })
	await expect(
		client.newsletters.rules.enable(list.id, rule.id, { revision: 1, confirm: true })
	).rejects.toMatchObject({ code: "revision_conflict" })
})
it("confirmed signup triggers once, imports remain inert and fresh unsubscribe blocks queued automation", async () => {
	const { list } = await fixture()
	const tag = await client.newsletters.tags.create(list.id, "Signup")
	const rule = await client.newsletters.rules.create(list.id, {
		name: "Welcome",
		trigger_tag_id: tag.tag_id,
		on_signup: true,
		sender: "news@example.test",
		subject: "Welcome",
		body: "<p>Welcome</p>",
	})
	await client.newsletters.rules.enable(list.id, rule.id, { revision: 1, confirm: true })
	const staged = await client.newsletters.imports.preview(list.id, {
		csv: "email,status,tags\nimported@example.test,subscribed,Signup",
		filename: "audience.csv",
		default_status: "pending",
		consent_confirmed: true,
	})
	await client.newsletters.imports.apply(list.id, staged.import.id)
	expect(
		(await (await local(`/v1/newsletters/${list.id}/rules/${rule.id}/run`, "POST", {})).json())
			.captured
	).toBe(0)
	await client.newsletters.signup(list.id, { email: "new@example.test", consent: true })
	expect(captures.list()).toHaveLength(1)
	const state = await (await local("/state")).json()
	await fetch(
		root +
			state.pending.find((item: { email: string }) => item.email === "new@example.test")
				.confirm_url,
		{ method: "POST" }
	)
	const response = await (
		await local(`/v1/newsletters/${list.id}/rules/${rule.id}/run`, "POST", {})
	).json()
	expect(response.captured).toBe(1)
	await client.newsletters.signup(list.id, { email: "new@example.test", consent: true })
	const fresh = await (await local("/state")).json()
	await fetch(
		root +
			fresh.pending.find((item: { email: string }) => item.email === "new@example.test")
				.confirm_url,
		{ method: "POST" }
	)
	expect(
		(await (await local(`/v1/newsletters/${list.id}/rules/${rule.id}/run`, "POST", {})).json())
			.captured
	).toBe(0)
	const reader = (await client.newsletters.audience(list.id)).contacts.find(
		(contact) => contact.email === "new@example.test"
	)!
	await client.newsletters.tags.create(list.id, "Signup", {
		contact_ids: [reader.id],
		event_id: "fresh-tag",
	})
	await local(`/v1/lists/${list.id}/recipients`, "PATCH", {
		email: reader.email,
		status: "unsubscribed",
	})
	expect(
		await (await local(`/v1/newsletters/${list.id}/rules/${rule.id}/run`, "POST", {})).json()
	).toMatchObject({ captured: 0, blocked: 1 })
})
it("local rules reject foreign tags, foreign samples and implicit enable fields", async () => {
	const { list } = await fixture()
	const other = await client.lists.create("Other")
	await client.newsletters.configure({
		list_id: other.id,
		slug: "other",
		postal_address: "2 Example Road",
	})
	const tag = await client.newsletters.tags.create(other.id, "Foreign")
	const input = {
		name: "Rule",
		trigger_tag_id: tag.tag_id,
		sender: "news@example.test",
		subject: "Hello",
		body: "<p>Hello</p>",
	}
	await expect(client.newsletters.rules.create(list.id, input)).rejects.toMatchObject({
		code: "invalid_rule",
	})
	const valid_tag = await client.newsletters.tags.create(list.id, "Valid")
	const rule = await client.newsletters.rules.create(list.id, {
		...input,
		trigger_tag_id: valid_tag.tag_id,
	})
	expect(
		(
			await local(`/v1/newsletters/${list.id}/rules`, "POST", {
				...input,
				trigger_tag_id: valid_tag.tag_id,
				enabled: true,
			})
		).status
	).toBe(400)
	await expect(client.newsletters.rules.get(other.id, rule.id)).rejects.toMatchObject({
		code: "not_found",
	})
	await expect(
		client.newsletters.rules.preview(list.id, rule.id, { sample_contact_id: "foreign" })
	).rejects.toMatchObject({ code: "not_found" })
})

it("uses the same source profiles locally and refuses unknown opt-outs or silent tag loss", async () => {
	const { list } = await fixture()
	const staged = await client.newsletters.imports.preview(list.id, {
		csv: "email,name,subscribed_to_emails,status,labels\nblocked@example.test,Blocked,false,paid,News",
		filename: "ghost.csv",
		source_profile: "ghost",
		default_status: "subscribed",
		consent_confirmed: false,
	})
	expect(JSON.parse(staged.import.summary)).toMatchObject({
		source_profile: "ghost",
		counts: { unsubscribed: 1 },
	})
	await client.newsletters.imports.apply(list.id, staged.import.id)
	const reader = (await client.newsletters.audience(list.id)).contacts.find(
		(contact) => contact.email === "blocked@example.test"
	)!
	expect(reader.status).toBe("unsubscribed")
	expect(JSON.parse(reader.provenance!)).toMatchObject({
		source_profile: "ghost",
		source_fields: { subscribed_to_emails: "false", status: "paid" },
	})
	const pending = await client.newsletters.imports.preview(list.id, {
		csv: "email,status,Event Opt Out\nuncertain@example.test,subscribed,not sure",
		filename: "review.csv",
		source_profile: "generic",
		default_status: "subscribed",
		consent_confirmed: false,
		mapping: { topic_opt_out: "Event Opt Out" },
	})
	expect(JSON.parse(pending.import.summary).counts.pending).toBe(1)
	await expect(
		client.newsletters.imports.preview(list.id, {
			csv: `email,status,tags\nreader0@example.test,unsubscribed,"${Array.from({ length: 51 }, (_, i) => `tag${i}`).join(",")}"`,
			filename: "too-many-tags.csv",
			source_profile: "kit",
			default_status: "pending",
		})
	).rejects.toMatchObject({ code: "invalid_import" })
	expect(captures.list()).toHaveLength(0)
})
