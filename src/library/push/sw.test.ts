import { describe, it, expect, afterEach, vi } from "vitest"
import { receive } from "./sw.js"
import { fake_worker, fake_subscription, STORED, VAPID_KEY } from "../../testing/worker.js"

/** `receive()` reads the worker globals, so the fake goes onto `globalThis`. */
function install(worker: ReturnType<typeof fake_worker>) {
	for (const [key, value] of Object.entries(worker.scope)) vi.stubGlobal(key, value)
	vi.stubGlobal("fetch", worker.fetch)
	return worker
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("the push handler", () => {
	it("shows what the Web Push provider sent, with the url carried on data for the click", async () => {
		const w = install(fake_worker())
		receive()

		await w.fire("push", {
			data: {
				json: () => ({ title: "Shipped", body: "On its way", icon: "/i.png", url: "/orders/7" }),
			},
		})

		expect(w.shown).toEqual([
			["Shipped", { body: "On its way", icon: "/i.png", data: { url: "/orders/7" } }],
		])
	})

	/**
	 * `userVisibleOnly` means every push owes the user a notification, and a browser that
	 * sees one skipped revokes the permission — so a payload from something that isn't
	 * postboi, or none at all, still has to show something rather than throw.
	 */
	it("still shows something for a payload that isn't ours, and for no payload at all", async () => {
		const w = install(fake_worker())
		receive()

		await w.fire("push", {
			data: {
				json: () => {
					throw new SyntaxError("not JSON")
				},
				text: () => "plain text",
			},
		})
		await w.fire("push", { data: null })

		expect(w.shown.map(([title, options]) => [title, (options as { body: string }).body])).toEqual([
			["", "plain text"],
			["", ""],
		])
	})

	it("merges the notification override over the defaults", async () => {
		const w = install(fake_worker())
		receive({ notification: (payload) => ({ title: payload.title ?? "Acme", tag: "orders" }) })

		await w.fire("push", { data: { json: () => ({ body: "no title on this one" }) } })

		expect(w.shown).toEqual([
			[
				"Acme",
				{
					body: "no title on this one",
					icon: undefined,
					data: { url: undefined },
					tag: "orders",
				},
			],
		])
	})
})

describe("the notificationclick handler", () => {
	it("focuses the tab already showing the url rather than opening a second one", async () => {
		const w = install(fake_worker({ windows: ["https://app.example/orders/7"] }))
		receive()

		await w.fire("notificationclick", {
			notification: { close: () => {}, data: { url: "/orders/7" } },
		})

		expect(w.focused).toEqual(["https://app.example/orders/7"])
		expect(w.opened).toEqual([])
	})

	it("opens a window when nothing is showing it, and does nothing without a url", async () => {
		const w = install(fake_worker({ windows: ["https://app.example/settings"] }))
		receive()

		await w.fire("notificationclick", {
			notification: { close: () => {}, data: { url: "/orders/7" } },
		})
		await w.fire("notificationclick", { notification: { close: () => {}, data: null } })

		expect(w.opened).toEqual(["https://app.example/orders/7"])
		expect(w.focused).toEqual([])
	})
})

describe("the pushsubscriptionchange handler", () => {
	/** The whole reason this file exists: a rotation the server is never told about is one
	 * notification that silently goes nowhere. */
	it("re-subscribes and files the replacement with the endpoint it replaced", async () => {
		const w = install(fake_worker({ subscription: fake_subscription() }))
		receive({ key: VAPID_KEY, register: "/push/subscriptions" })

		await w.fire("pushsubscriptionchange", {
			oldSubscription: { endpoint: "https://push.example/old" },
		})

		expect(w.subscribed).toHaveLength(1)
		expect((w.subscribed[0] as { userVisibleOnly: boolean }).userVisibleOnly).toBe(true)
		expect(w.posted).toEqual([
			["/push/subscriptions", { ...STORED, old_endpoint: "https://push.example/old" }],
		])
	})

	it("takes the replacement the browser already made rather than minting a second", async () => {
		const w = install(fake_worker())
		const filed: Array<unknown> = []
		receive({ key: VAPID_KEY, register: async (s) => void filed.push(s) })

		await w.fire("pushsubscriptionchange", { newSubscription: fake_subscription() })

		expect(w.subscribed).toEqual([])
		expect(filed).toEqual([STORED])
	})

	it("says so in the console rather than failing silently when there is no key to re-subscribe with", async () => {
		const w = install(fake_worker({ subscription: fake_subscription() }))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		receive({ register: "/push/subscriptions" })

		await w.fire("pushsubscriptionchange", {})

		expect(w.posted).toEqual([])
		expect(warn.mock.calls[0]?.[0]).toContain("bunx postboi sync")
		warn.mockRestore()
	})
})
