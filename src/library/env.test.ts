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

	it("reads how mail should look from the environment, for runtimes with no config file", async () => {
		bindings.current = {
			POSTBOI_LETTERHEAD: "true",
			POSTBOI_SHELL: "1",
			POSTBOI_STYLE: "plain",
		}
		const { ensure_env_loaded, env_defaults } = await load_env()

		await ensure_env_loaded()

		expect(env_defaults()).toMatchObject({ letterhead: true, shell: true, style: "plain" })
	})

	it("a flag that is neither yes nor no is said out loud and ignored", async () => {
		bindings.current = { POSTBOI_LETTERHEAD: "treu", POSTBOI_STYLE: "fancy" }
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { ensure_env_loaded, env_defaults } = await load_env()

		await ensure_env_loaded()
		const defaults = env_defaults()

		// Silently reading "treu" as off is a fortnight of unbranded mail nobody notices.
		expect(defaults.letterhead).toBeUndefined()
		expect(defaults.style).toBeUndefined()
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it("off is an answer, not an absence", async () => {
		bindings.current = { POSTBOI_LETTERHEAD: "false" }
		const { ensure_env_loaded, env_defaults } = await load_env()

		await ensure_env_loaded()

		expect(env_defaults().letterhead).toBe(false)
	})

	it("reads Cloudflare's `.dev.vars` so a Vite/Node dev server sees a Worker's token", async () => {
		// adapter-cloudflare's dev proxy reads .dev.vars but never puts it on process.env,
		// and `cloudflare:workers` doesn't resolve outside workerd — so this file is the
		// only place a Node dev server can find the token.
		vi.doMock("node:fs", () => ({
			existsSync: (p: string) => String(p).endsWith(".dev.vars"),
			readFileSync: () => 'POSTBOI_TOKEN="pb_from_dev_vars"\n',
		}))
		try {
			const { ensure_env_loaded, read_env } = await load_env()
			await ensure_env_loaded()
			expect(read_env("POSTBOI_TOKEN")).toBe("pb_from_dev_vars")
		} finally {
			vi.doUnmock("node:fs")
		}
	})

	it("only loads once, even when concurrent sends race the first call", async () => {
		bindings.current = { POSTBOI_TOKEN: "pb_from_binding" }
		const { ensure_env_loaded, read_env } = await load_env()

		// The loser of the race must wait for the bindings, not skip past an empty cache.
		await Promise.all([ensure_env_loaded(), ensure_env_loaded()])

		expect(read_env("POSTBOI_TOKEN")).toBe("pb_from_binding")
	})
})

describe("parse_dotenv", () => {
	it("decodes the escapes the CLI's env writer produces", async () => {
		const { parse_dotenv } = await import("./env.js")
		const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
		// What cli/env.ts format_line writes for that value.
		const line = 'FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"'
		expect(parse_dotenv(line)).toEqual([["FCM_PRIVATE_KEY", pem]])
		// Plain and single-quoted values stay untouched.
		expect(parse_dotenv("A=plain\nB='lit\\neral'")).toEqual([
			["A", "plain"],
			["B", "lit\\neral"],
		])
	})
})
