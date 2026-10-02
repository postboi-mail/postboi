import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import PostboiPush from "./postboi.js"
import WebPush from "./webpush.js"
import { PushProvider } from "./provider.js"
import { push } from "./send.js"
import { handler } from "./managed.js"
import { PostboiError } from "../errors.js"
import { reset_config } from "../config.js"
import { infer_channel_provider } from "../registry.js"

const SUBSCRIPTION = {
	endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
	keys: {
		p256dh:
			"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		auth: "BTBZMqHH6r4Tts7J_aSIgg",
	},
}
const VAPID = {
	public_key:
		"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	private_key: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	subject: "mailto:you@example.com",
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("managed push", () => {
	const fetch_mock = vi.fn()

	beforeEach(() => {
		vi.stubGlobal("fetch", fetch_mock)
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubEnv("POSTBOI_API_URL", "https://api.test")
	})
	afterEach(() => {
		fetch_mock.mockReset()
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
		reset_config()
	})

	it("sends to a person through /v1/push/send and answers per-device counts", async () => {
		fetch_mock.mockResolvedValueOnce(json({ sent: 2, expired: 1, failed: [] }))
		const result = await new PostboiPush().send({
			to: { user: 123 },
			title: "Order shipped",
			message: "On its way",
			urgency: "high",
		})
		expect(result).toEqual({ sent: 2, expired: 1, failed: [] })
		const [url, init] = fetch_mock.mock.calls[0]
		expect(url).toBe("https://api.test/v1/push/send")
		expect(init.headers.Authorization).toBe("Bearer pb_test")
		expect(JSON.parse(init.body)).toMatchObject({
			to: { user: "123" },
			title: "Order shipped",
			message: "On its way",
			urgency: "high",
		})
	})

	it("is chosen by POSTBOI_PUSH_PROVIDER=postboi and never by a token alone", async () => {
		vi.stubEnv("POSTBOI_PUSH_PROVIDER", "postboi")
		fetch_mock.mockResolvedValueOnce(json({ sent: 1, expired: 0, failed: [] }))
		expect(await push({ to: { list: "new-posts" }, message: "New post" })).toEqual({
			sent: 1,
			expired: 0,
			failed: [],
		})
		expect(fetch_mock.mock.calls[0][0]).toBe("https://api.test/v1/push/send")

		// A token and a VAPID trio: still Web Push, which is what the trio was minted for.
		// Asked of inference directly, with only those set, so a machine carrying every
		// credential (CI's polluted run) can't make the answer ambiguous.
		const set = new Set(["POSTBOI_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"])
		expect(infer_channel_provider("push", (env) => set.has(env))).toBe("webpush")
		// And no credential at all ever infers managed push.
		expect(infer_channel_provider("push", () => true)).not.toBe("postboi")
	})

	it("an audience is refused by every provider that can't look one up", async () => {
		const provider = new WebPush(VAPID)
		await expect(provider.send({ to: { user: "1" }, message: "hi" })).rejects.toMatchObject({
			code: "invalid_target",
			message: expect.stringContaining("POSTBOI_PUSH_PROVIDER=postboi"),
		})
		expect(fetch_mock).not.toHaveBeenCalled()
	})

	it("an API 404 is not an expired subscription", async () => {
		fetch_mock.mockResolvedValueOnce(
			json({ message: "No list with that id or name on this account.", code: "not_found" }, 404)
		)
		const error = await new PostboiPush()
			.send({ to: { list: "nope" }, message: "hi" })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(PostboiError)
		expect((error as PostboiError).code).toBe("not_found")
		expect(PushProvider.is_expired(error)).toBe(false)
		expect(push.expired(error)).toBe(false)
	})

	it("says what to do without a token", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "")
		await expect(
			new PostboiPush({ token: undefined }).send({ to: { user: "1" }, message: "hi" })
		).rejects.toMatchObject({ code: "no_token" })
	})

	it("push.subscriptions files, lists, removes and imports", async () => {
		fetch_mock
			.mockResolvedValueOnce(json({ endpoint: SUBSCRIPTION.endpoint, user: "7" }, 201))
			.mockResolvedValueOnce(json({ subscriptions: [], cursor: null }))
			.mockResolvedValueOnce(json({ endpoint: SUBSCRIPTION.endpoint, deleted: true }))
			.mockResolvedValueOnce(json({ imported: 1 }))
		await push.subscriptions.add(SUBSCRIPTION, { user: 7, lists: ["new-posts"] })
		await push.subscriptions.list({ user: 7, limit: 50 })
		await push.subscriptions.remove(SUBSCRIPTION.endpoint, { user: 7 })
		await push.subscriptions.import([{ subscription: SUBSCRIPTION, user: "7" }])

		const calls = fetch_mock.mock.calls.map(([url, init]) => [
			init.method,
			url,
			init.body ? JSON.parse(init.body) : undefined,
		])
		expect(calls).toEqual([
			[
				"POST",
				"https://api.test/v1/push/subscriptions",
				{ subscription: SUBSCRIPTION, user: "7", lists: ["new-posts"] },
			],
			["GET", "https://api.test/v1/push/subscriptions?user=7&limit=50", undefined],
			[
				"DELETE",
				"https://api.test/v1/push/subscriptions",
				{ endpoint: SUBSCRIPTION.endpoint, user: "7" },
			],
			[
				"POST",
				"https://api.test/v1/push/subscriptions/import",
				{ rows: [{ subscription: SUBSCRIPTION, user: "7" }] },
			],
		])
	})
})

describe("push.handler", () => {
	const fetch_mock = vi.fn()

	beforeEach(() => {
		vi.stubGlobal("fetch", fetch_mock)
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubEnv("POSTBOI_API_URL", "https://api.test")
	})
	afterEach(() => {
		fetch_mock.mockReset()
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	const post = (body: unknown, method = "POST") =>
		new Request("https://app.test/push", {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})

	it("files the page's subscription under the signed-in user (SvelteKit's event.request)", async () => {
		fetch_mock.mockResolvedValueOnce(json({ endpoint: SUBSCRIPTION.endpoint, user: "42" }, 201))
		const { POST } = handler(
			(event: { locals: { user?: { id: number } } }) => event.locals.user?.id
		)
		const response = await POST({
			request: post(SUBSCRIPTION),
			locals: { user: { id: 42 } },
		} as never)
		expect(response.status).toBe(201)
		expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
			subscription: SUBSCRIPTION,
			user: "42",
		})
	})

	it("is a 401 when nobody is signed in, so the toggle rolls the browser back", async () => {
		const { POST, DELETE } = handler(() => null)
		expect((await POST(post(SUBSCRIPTION))).status).toBe(401)
		expect((await DELETE(post({ endpoint: SUBSCRIPTION.endpoint }, "DELETE"))).status).toBe(401)
		expect(fetch_mock).not.toHaveBeenCalled()
	})

	it("unfiles only the signed-in user's browser, and an already-gone one is fine", async () => {
		fetch_mock.mockResolvedValueOnce(json({ message: "gone", code: "not_found" }, 404))
		// A bare Request (Next route handlers, Workers) and Hono's c.req.raw both work.
		const { DELETE } = handler(() => "u1")
		const response = await DELETE({
			req: { raw: post({ endpoint: SUBSCRIPTION.endpoint }, "DELETE") },
		} as never)
		expect(response.status).toBe(200)
		expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
			endpoint: SUBSCRIPTION.endpoint,
			user: "u1",
		})
	})

	it("passes a Postboi refusal through as itself", async () => {
		fetch_mock.mockResolvedValueOnce(
			json({ message: "Managed push isn't on for this account.", code: "push_not_set_up" }, 409)
		)
		const { POST } = handler(() => "u1")
		const response = await POST(post(SUBSCRIPTION))
		expect(response.status).toBe(409)
		expect((await response.json()).message).toContain("Managed push isn't on")
	})

	it("refuses a body that isn't a subscription", async () => {
		const { POST } = handler(() => "u1")
		expect((await POST(post({ nope: true }))).status).toBe(400)
	})
})
