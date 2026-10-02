import { describe, it, expect, afterEach, vi } from "vitest"
import { find_worker, suggest_worker, wire_worker, page_snippet } from "./service_worker.js"
import { receive } from "../library/push/sw.js"
import { fake_worker, fake_subscription, STORED, VAPID_KEY } from "../testing/worker.js"

const has =
	(...paths: Array<string>) =>
	(path: string) =>
		paths.includes(path)
const none = () => false

describe("find_worker", () => {
	it("finds a worker wherever the framework keeps it", () => {
		expect(find_worker(has("public/sw.js"))).toMatchObject({
			path: "public/sw.js",
			url: "/sw.js",
			kind: "raw",
		})
		expect(find_worker(has("static/sw.js"))).toMatchObject({ path: "static/sw.js", kind: "raw" })
		expect(find_worker(has("src/service-worker.ts"))).toMatchObject({
			url: "/service-worker.js",
			kind: "bundled",
		})
	})

	/** A leftover static file next to a real bundled entry means the bundled one — that's
	 * the file the framework actually builds. */
	it("prefers the bundled entry when a project has both", () => {
		expect(find_worker(has("src/service-worker.ts", "static/sw.js"))?.path).toBe(
			"src/service-worker.ts"
		)
	})

	it("is undefined when there is no worker at all", () => {
		expect(find_worker(none)).toBeUndefined()
	})

	/** `kit.files.serviceWorker` moves the source file, not the URL — SvelteKit serves the
	 * built worker at /service-worker.js wherever the source lives. */
	it("follows a svelte config's kit.files.serviceWorker to a custom source", () => {
		const config = `export default { kit: { files: { serviceWorker: "src/lib/worker" } } }`
		const exists = has("svelte.config.js", "src/lib/worker.ts")
		expect(find_worker(exists, () => config)).toEqual({
			path: "src/lib/worker.ts",
			url: "/service-worker.js",
			kind: "bundled",
		})
	})

	it("prefers the configured source over the standard locations", () => {
		const config = `export default { kit: { files: { serviceWorker: "src/lib/worker.ts" } } }`
		const exists = has("svelte.config.js", "src/lib/worker.ts", "src/service-worker.ts")
		expect(find_worker(exists, () => config)?.path).toBe("src/lib/worker.ts")
	})

	/** `kit.serviceWorker` (an object, for `register: false`) is a different option and must
	 * not read as a path. */
	it("ignores configs that don't name a worker source as a string", () => {
		const registration = `export default { kit: { serviceWorker: { register: false } } }`
		const exists = has("svelte.config.js", "src/service-worker.ts")
		expect(find_worker(exists, () => registration)?.path).toBe("src/service-worker.ts")
		// A named source that doesn't exist on disk falls back too, rather than wiring a
		// file SvelteKit won't build.
		const missing = `export default { kit: { files: { serviceWorker: "src/gone" } } }`
		expect(find_worker(exists, () => missing)?.path).toBe("src/service-worker.ts")
	})
})

describe("suggest_worker", () => {
	/**
	 * The decision that matters: an `import` in a file the framework serves verbatim is a
	 * syntax error at worker startup, with nothing pointing at the cause. SvelteKit builds
	 * `src/service-worker`, so it's the only one that gets the import.
	 */
	it("gives SvelteKit the bundled entry, in the project's language", () => {
		expect(
			suggest_worker([], { dependencies: { "@sveltejs/kit": "^2" } }, has("tsconfig.json"))
		).toEqual({ path: "src/service-worker.ts", url: "/service-worker.js", kind: "bundled" })
		expect(suggest_worker(["svelte.config.js"], undefined, none)).toMatchObject({
			path: "src/service-worker.js",
			kind: "bundled",
		})
	})

	it("gives everything else a served-as-is file, in whichever static directory it has", () => {
		const next = { dependencies: { next: "^15" } }
		expect(suggest_worker([], next, has("public"))).toEqual({
			path: "public/sw.js",
			url: "/sw.js",
			kind: "raw",
		})
		expect(suggest_worker([], undefined, has("static"))).toMatchObject({ path: "static/sw.js" })
		// Nothing recognised at all still lands on the shape that can't fail to parse.
		expect(suggest_worker([], undefined, none)).toMatchObject({ kind: "raw" })
	})
})

describe("wire_worker", () => {
	const options = { register: "/push/subscriptions", key: VAPID_KEY }
	const bundled = {
		path: "src/service-worker.ts",
		url: "/service-worker.js",
		kind: "bundled",
	} as const
	const raw = { path: "public/sw.js", url: "/sw.js", kind: "raw" } as const

	it("creates a bundled worker as one import and one call", () => {
		const result = wire_worker(bundled, undefined, options)
		expect(result).toMatchObject({ action: "created" })
		const source = (result as { source: string }).source
		expect(source).toContain('import { receive } from "postboi/push/sw"')
		expect(source).toContain('receive({ register: "/push/subscriptions" })')
	})

	/** The raw file never imports — that's the whole reason the generated shape exists. */
	it("creates a raw worker with the handlers written out and the key baked in", () => {
		const result = wire_worker(raw, undefined, options)
		const source = (result as { source: string }).source
		expect(source).not.toMatch(/^import /m)
		expect(source).toContain(`const POSTBOI_VAPID_KEY = "${VAPID_KEY}"`)
		for (const event of ["push", "notificationclick", "pushsubscriptionchange"]) {
			expect(source).toContain(`self.addEventListener("${event}"`)
		}
	})

	it("appends to a worker that already exists, keeping what was there", () => {
		const existing = 'self.addEventListener("fetch", (event) => {})\n'
		const result = wire_worker(raw, existing, options)
		expect(result).toMatchObject({ action: "updated" })
		expect((result as { source: string }).source.startsWith(existing)).toBe(true)
	})

	it("is a no-op when postboi is already wired in, in either shape", () => {
		for (const target of [bundled, raw]) {
			const already = (wire_worker(target, undefined, options) as { source: string }).source
			expect(wire_worker(target, already, options)).toBe("present")
		}
	})

	/**
	 * Two `push` handlers means two notifications for one send. Appending is never safe
	 * here, so the caller gets told rather than the user getting doubles.
	 */
	it("refuses to append to a worker that already handles push itself", () => {
		expect(wire_worker(raw, 'self.addEventListener("push", (e) => {})', options)).toBe("conflict")
		expect(wire_worker(raw, "self.onpush = () => {}", options)).toBe("conflict")
	})

	it("writes a worker that still handles rotations when no key was available", () => {
		const source = (wire_worker(raw, undefined, { register: "/r" }) as { source: string }).source
		expect(source).toContain('const POSTBOI_VAPID_KEY = ""')
	})
})

describe("page_snippet", () => {
	/** `subscribe()` probes the conventional URLs itself, so the line only names a path for
	 * a worker served somewhere it would never look. */
	it("names the worker's url only when subscribe() wouldn't find it", () => {
		expect(page_snippet({ path: "public/sw.js", url: "/sw.js", kind: "raw" }, "/r")).toBe(
			'subscription({ register: "/r" })'
		)
		expect(
			page_snippet(
				{ path: "src/service-worker.ts", url: "/service-worker.js", kind: "bundled" },
				"/r"
			)
		).toBe('subscription({ register: "/r" })')
		expect(page_snippet({ path: "public/pwa.js", url: "/pwa.js", kind: "raw" }, "/r")).toBe(
			'subscription({ register: "/r", sw: "/pwa.js" })'
		)
	})
})

/**
 * The generated worker and `receive()` are two implementations of one behaviour, which is
 * the arrangement that drifts. Both are driven through the same fake worker with the same
 * events, and their recordings compared: a change made to one and not the other fails here.
 *
 * Behaviour, not error handling — the library version rejects an incomplete subscription
 * and a non-2xx register response, where the generated file is deliberately plainer.
 */
describe("the generated worker matches receive()", () => {
	const GENERATED = (
		wire_worker({ path: "public/sw.js", url: "/sw.js", kind: "raw" }, undefined, {
			register: "/push/subscriptions",
			key: VAPID_KEY,
		}) as { source: string }
	).source

	/** Run the generated source with the fake as its `self`, and its own `fetch`. */
	function generated(worker: ReturnType<typeof fake_worker>) {
		new Function("self", "fetch", GENERATED)(worker.scope, worker.fetch)
		return worker
	}

	/** Run `receive()` with the same fake installed as globals. */
	function library(worker: ReturnType<typeof fake_worker>) {
		for (const [key, value] of Object.entries(worker.scope)) vi.stubGlobal(key, value)
		vi.stubGlobal("fetch", worker.fetch)
		receive({ register: "/push/subscriptions", key: VAPID_KEY })
		return worker
	}

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	/** Fire one event at both and hand back the two recordings. */
	async function both(
		type: string,
		event: Record<string, unknown>,
		options: Parameters<typeof fake_worker>[0] = {}
	) {
		const a = generated(fake_worker(options))
		const b = library(fake_worker(options))
		await a.fire(type, event)
		await b.fire(type, event)
		return [a.record(), b.record()] as const
	}

	it("shows the same notification, including for a payload neither can parse", async () => {
		const [gen, lib] = await both("push", {
			data: { json: () => ({ title: "Shipped", body: "On its way", url: "/orders/7" }) },
		})
		expect(gen).toEqual(lib)
		expect(gen.shown[0][0]).toBe("Shipped")

		const [gen2, lib2] = await both("push", {
			data: {
				json: () => {
					throw new SyntaxError("nope")
				},
				text: () => "plain text",
			},
		})
		expect(gen2).toEqual(lib2)
		expect((gen2.shown[0][1] as { body: string }).body).toBe("plain text")
	})

	it("focuses the same tab, and opens the same window when there isn't one", async () => {
		const [gen, lib] = await both(
			"notificationclick",
			{ notification: { close: () => {}, data: { url: "/orders/7" } } },
			{ windows: ["https://app.example/orders/7"] }
		)
		expect(gen).toEqual(lib)
		expect(gen.focused).toEqual(["https://app.example/orders/7"])

		const [gen2, lib2] = await both("notificationclick", {
			notification: { close: () => {}, data: { url: "/orders/7" } },
		})
		expect(gen2).toEqual(lib2)
		expect(gen2.opened).toEqual(["https://app.example/orders/7"])
	})

	it("re-subscribes with the same key and files the same body, old endpoint included", async () => {
		const [gen, lib] = await both(
			"pushsubscriptionchange",
			{ oldSubscription: { endpoint: "https://push.example/old" } },
			{ subscription: fake_subscription() }
		)
		expect(gen).toEqual(lib)
		expect(gen.posted).toEqual([
			["/push/subscriptions", { ...STORED, old_endpoint: "https://push.example/old" }],
		])
	})

	it("takes the browser's own replacement the same way, with no old endpoint to send", async () => {
		const [gen, lib] = await both("pushsubscriptionchange", {
			newSubscription: fake_subscription(),
		})
		expect(gen).toEqual(lib)
		expect(gen.posted).toEqual([["/push/subscriptions", STORED]])
	})
})

describe("the generated managed worker matches receive()", () => {
	const MANAGED = { publishable_key: "pk_test", api: "https://api.test" }
	const GENERATED = (
		wire_worker({ path: "public/sw.js", url: "/sw.js", kind: "raw" }, undefined, {
			register: "/unused",
			key: VAPID_KEY,
			managed: MANAGED,
		}) as { source: string }
	).source

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	async function both(event: Record<string, unknown>) {
		const a = fake_worker({ subscription: fake_subscription() })
		new Function("self", "fetch", GENERATED)(a.scope, a.fetch)
		const b = fake_worker({ subscription: fake_subscription() })
		for (const [key, value] of Object.entries(b.scope)) vi.stubGlobal(key, value)
		vi.stubGlobal("fetch", b.fetch)
		receive({ key: VAPID_KEY, ...MANAGED })
		await a.fire("pushsubscriptionchange", event)
		await b.fire("pushsubscriptionchange", event)
		return [a.record(), b.record()] as const
	}

	it("re-files a rotation with Postboi on the publishable key, old endpoint included", async () => {
		const [gen, lib] = await both({ oldSubscription: { endpoint: "https://push.example/old" } })
		expect(gen).toEqual(lib)
		expect(gen.posted).toEqual([
			[
				"https://api.test/v1/push/browser",
				{ key: "pk_test", ...STORED, old_endpoint: "https://push.example/old" },
			],
		])
	})

	it("writes the bundled shape as a bare receive()", () => {
		const wired = wire_worker(
			{ path: "src/service-worker.ts", url: "/service-worker.js", kind: "bundled" },
			undefined,
			{ register: "/unused", managed: MANAGED }
		) as { source: string }
		expect(wired.source).toContain("receive()\n")
		expect(wired.source).not.toContain("/unused")
	})
})
