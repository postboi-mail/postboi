import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Stands in for workerd's `cloudflare:workers` module, which only resolves inside a Worker.
const bindings = vi.hoisted(() => ({ current: {} as Record<string, string> }))
vi.mock("$library/workers_env.js", () => ({ workers_env: async () => bindings.current }))

// Fresh module per test: the fallback cache is module-level and loads exactly once.
async function load_env() {
	vi.resetModules()
	return import("$library/env.js")
}

beforeEach(() => {
	bindings.current = {}
})
afterEach(() => vi.unstubAllEnvs())

describe("env fallback", () => {
	it("reads Cloudflare Worker bindings, so a Worker needs no explicit credentials", async () => {
		bindings.current = { POSTBOI_TOKEN: "pb_from_binding" }
		const { ensure_env_loaded, read_env } = await load_env()

		await ensure_env_loaded()

		expect(read_env("POSTBOI_TOKEN")).toBe("pb_from_binding")
	})

	it("returns undefined for a binding that isn't set", async () => {
		const { ensure_env_loaded, read_env } = await load_env()
		await ensure_env_loaded()
		expect(read_env("POSTBOI_TOKEN")).toBeUndefined()
	})

	it("lets process.env win over a binding of the same name", async () => {
		bindings.current = { POSTBOI_TOKEN: "pb_from_binding" }
		const { ensure_env_loaded, read_env } = await load_env()
		vi.stubEnv("POSTBOI_TOKEN", "pb_from_process")

		await ensure_env_loaded()

		expect(read_env("POSTBOI_TOKEN")).toBe("pb_from_process")
	})

	it("populates the shared defaults from bindings too", async () => {
		bindings.current = { POSTBOI_FROM: "hi@example.com" }
		const { ensure_env_loaded, env_defaults } = await load_env()

		await ensure_env_loaded()

		expect(env_defaults().from).toBe("hi@example.com")
	})

	it("only loads once, even when concurrent sends race the first call", async () => {
		bindings.current = { POSTBOI_TOKEN: "pb_from_binding" }
		const { ensure_env_loaded, read_env } = await load_env()

		// The loser of the race must wait for the bindings, not skip past an empty cache.
		await Promise.all([ensure_env_loaded(), ensure_env_loaded()])

		expect(read_env("POSTBOI_TOKEN")).toBe("pb_from_binding")
	})
})
