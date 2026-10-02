import { describe, it, expect, beforeEach, vi } from "vitest"

// The controller's logic is the thing under test; the browser half is the seam.
const client = vi.hoisted(() => {
	const subscribe = Object.assign(vi.fn(), {
		supported: vi.fn(() => true),
		permission: vi.fn(() => "default" as const),
		current: vi.fn(async () => null),
		reason: vi.fn(() => null),
	})
	return { subscribe, unsubscribe: vi.fn(async () => null) }
})
vi.mock("./client.js", () => client)

import { subscription } from "./controller.js"

const SUBSCRIPTION = {
	endpoint: "https://push.example/abc",
	expirationTime: null,
	keys: { p256dh: "key", auth: "secret" },
}

function last_state(states: Array<unknown>) {
	return states[states.length - 1] as Record<string, unknown>
}

beforeEach(() => {
	vi.clearAllMocks()
	client.subscribe.supported.mockReturnValue(true)
	client.subscribe.current.mockResolvedValue(null)
	client.subscribe.reason.mockReturnValue(null)
})

describe("subscription", () => {
	it("touches no browser API until something listens, then reports reality", async () => {
		const controller = subscription({ key: "k" })
		expect(client.subscribe.supported).not.toHaveBeenCalled()

		client.subscribe.current.mockResolvedValue(SUBSCRIPTION as never)
		const states: Array<unknown> = []
		controller.subscribe((state) => states.push(state))
		await vi.waitFor(() => expect(last_state(states).on).toBe(true))
		expect(last_state(states).supported).toBe(true)
	})

	it("enable subscribes, registers, and lands on", async () => {
		client.subscribe.mockResolvedValue(SUBSCRIPTION as never)
		const fetch = vi.fn(async () => ({ ok: true }))
		vi.stubGlobal("fetch", fetch)

		const controller = subscription({ key: "k", register: "/push/subscriptions" })
		await controller.enable()

		expect(fetch).toHaveBeenCalledWith("/push/subscriptions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUBSCRIPTION),
		})
		expect(controller.now()).toMatchObject({ on: true, busy: false, reason: null })
	})

	it("a failed register rolls the browser subscription back — no orphaned addresses", async () => {
		client.subscribe.mockResolvedValue(SUBSCRIPTION as never)
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500 }))
		)

		const controller = subscription({ key: "k", register: "/push/subscriptions" })
		await controller.enable()

		expect(client.unsubscribe).toHaveBeenCalled()
		expect(controller.now()).toMatchObject({ on: false, reason: "register_failed" })
	})

	it("a dismissed prompt is a shrug: reason stays null", async () => {
		client.subscribe.mockRejectedValue(new Error("dismissed"))
		client.subscribe.reason.mockReturnValue("permission_dismissed" as never)

		const controller = subscription({ key: "k" })
		await controller.enable()
		expect(controller.now()).toMatchObject({ on: false, busy: false })
		expect(controller.now().reason).toBe("permission_dismissed")
	})

	it("disable unsubscribes and unfiles by endpoint", async () => {
		client.unsubscribe.mockResolvedValue(SUBSCRIPTION as never)
		const fetch = vi.fn(async () => ({ ok: true }))
		vi.stubGlobal("fetch", fetch)

		const controller = subscription({ key: "k", unregister: "/push/subscriptions" })
		await controller.disable()

		expect(fetch).toHaveBeenCalledWith("/push/subscriptions", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ endpoint: SUBSCRIPTION.endpoint }),
		})
		expect(controller.now()).toMatchObject({ on: false, busy: false })
	})

	it("toggle subscribes when off and unsubscribes when on", async () => {
		client.subscribe.mockResolvedValue(SUBSCRIPTION as never)
		client.unsubscribe.mockResolvedValue(SUBSCRIPTION as never)

		const controller = subscription({ key: "k" })
		await controller.toggle()
		expect(controller.now().on).toBe(true)

		await controller.toggle()
		expect(controller.now().on).toBe(false)
		expect(client.unsubscribe).toHaveBeenCalled()
	})

	it("toggle survives being handed straight to an event handler", async () => {
		client.subscribe.mockResolvedValue(SUBSCRIPTION as never)

		// `onclick={push.toggle}` calls it unbound — it must not need its object.
		const { toggle } = subscription({ key: "k" })
		await toggle()

		expect(client.subscribe).toHaveBeenCalled()
	})

	it("a click that beats the initial read still lands on the right side", async () => {
		// The browser is already subscribed, but nothing has listened yet, so `on` is
		// still its initial false. The click must wait for the read, not enable again.
		client.subscribe.current.mockResolvedValue(SUBSCRIPTION as never)
		client.unsubscribe.mockResolvedValue(SUBSCRIPTION as never)

		const controller = subscription({ key: "k" })
		await controller.toggle()

		expect(client.unsubscribe).toHaveBeenCalled()
		expect(client.subscribe).not.toHaveBeenCalled()
		expect(controller.now().on).toBe(false)
	})

	it("a failed unsubscribe releases busy instead of wedging the toggle", async () => {
		client.subscribe.current.mockResolvedValue(SUBSCRIPTION as never)
		client.unsubscribe.mockRejectedValue(new DOMException("push service unreachable"))

		const controller = subscription({ key: "k" })
		await controller.toggle()

		// The browser still holds the subscription, and the machine must still be usable.
		expect(controller.now()).toMatchObject({ on: true, busy: false })
	})

	it("a failed rollback still reports register_failed", async () => {
		client.subscribe.mockResolvedValue(SUBSCRIPTION as never)
		client.unsubscribe.mockRejectedValue(new DOMException("gone"))
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500 }))
		)

		const controller = subscription({ key: "k", register: "/push/subscriptions" })
		await controller.enable()

		// The register call is the story; the rollback failing too must not eat it.
		expect(controller.now()).toMatchObject({ busy: false, reason: "register_failed" })
	})

	it("a slow initial read can't overwrite the enable that finished first", async () => {
		let answer!: (value: null) => void
		client.subscribe.current.mockReturnValue(new Promise((resolve) => (answer = resolve)))
		client.subscribe.mockResolvedValue(SUBSCRIPTION as never)

		const controller = subscription({ key: "k" })
		controller.subscribe(() => {}) // kicks off the read, which hangs
		await controller.enable()
		expect(controller.now().on).toBe(true)

		answer(null) // the read finally resolves, with a snapshot from before the enable
		await vi.waitFor(() => expect(controller.now().supported).toBe(true))
		expect(controller.now().on).toBe(true)
	})
})

describe("subscription({ list })", () => {
	it("follows a public list straight from the page, on the publishable key", async () => {
		client.subscribe.mockResolvedValue(SUBSCRIPTION as never)
		const fetch = vi.fn(async () => ({ ok: true }))
		vi.stubGlobal("fetch", fetch)

		const controller = subscription({
			list: "new-posts",
			publishable_key: "pk_test",
			api: "https://api.test/",
		})
		await controller.enable()
		expect(fetch).toHaveBeenCalledWith("https://api.test/v1/push/browser", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "pk_test", ...SUBSCRIPTION, list: "new-posts" }),
		})
		expect(controller.now()).toMatchObject({ on: true })

		client.unsubscribe.mockResolvedValue(SUBSCRIPTION as never)
		await controller.disable()
		expect(fetch).toHaveBeenLastCalledWith("https://api.test/v1/push/browser", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				key: "pk_test",
				endpoint: SUBSCRIPTION.endpoint,
				list: "new-posts",
			}),
		})
	})

	it("rolls the browser back when the list isn't public", async () => {
		client.subscribe.mockResolvedValue(SUBSCRIPTION as never)
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 403 }))
		)
		const controller = subscription({ list: "private", publishable_key: "pk_test" })
		await controller.enable()
		expect(client.unsubscribe).toHaveBeenCalled()
		expect(controller.now()).toMatchObject({ on: false, reason: "register_failed" })
	})

	it("says managed push isn't baked when there's no publishable key", async () => {
		client.subscribe.mockResolvedValue(SUBSCRIPTION as never)
		const fetch = vi.fn()
		vi.stubGlobal("fetch", fetch)
		const controller = subscription({ list: "new-posts" })
		await controller.enable()
		expect(fetch).not.toHaveBeenCalled()
		expect(controller.now()).toMatchObject({ on: false, reason: "register_failed" })
	})
})
