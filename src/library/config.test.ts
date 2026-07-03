import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configure, config, get_config, load_config, reset_config } from "$library/config.js"
import Mock from "$library/mock.js"
import { mail } from "$library/cloud.js"

const fetch = vi.fn()
global.fetch = fetch

beforeEach(() => {
	reset_config()
	fetch.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("global config", () => {
	it("configure() merges; later calls add to earlier ones", () => {
		configure({ retries: 2 })
		configure({ default: { from: "a@test.com" } })
		expect(get_config()).toMatchObject({ retries: 2, default: { from: "a@test.com" } })
	})

	it("config() registers as a side effect and returns the value", () => {
		const value = config({ auto_text: true })
		expect(value).toEqual({ auto_text: true })
		expect(get_config().auto_text).toBe(true)
	})

	it("applies global default + hooks to every provider instance", async () => {
		const before = vi.fn()
		configure({ default: { from: "global@test.com" }, hooks: { before: { send: before } } })

		const provider = new Mock()
		await provider.send({ to: "to@test.com", body: "hi" })

		expect(provider.last?.from.address).toBe("global@test.com")
		expect(before).toHaveBeenCalledOnce()
	})

	it("lets per-instance options override global config", async () => {
		configure({ default: { from: "global@test.com" }, retries: 5 })
		const provider = new Mock({ default: { from: "local@test.com" } })
		await provider.send({ to: "to@test.com", body: "hi" })
		expect(provider.last?.from.address).toBe("local@test.com")
	})

	it("merges global hooks with instance hooks rather than replacing them", async () => {
		const global_hook = vi.fn()
		const instance_hook = vi.fn()
		configure({ hooks: { before: { send: global_hook }, after: { send: instance_hook } } })

		const provider = new Mock({
			default: { from: "f@test.com" },
			hooks: { after: { send: instance_hook } },
		})
		await provider.send({ to: "to@test.com", body: "hi" })

		expect(global_hook).toHaveBeenCalledOnce() // kept from global
		expect(instance_hook).toHaveBeenCalledOnce() // instance wins for after.send
	})

	it("zero-config mail() uses config.provider when POSTBOI_PROVIDER is unset", async () => {
		configure({ provider: "resend", default: { from: "from@test.com" } })
		vi.stubEnv("RESEND_API_KEY", "re_123")
		fetch.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			text: async () => JSON.stringify({ id: "1" }),
			json: async () => ({ id: "1" }),
		})

		await mail({ to: "to@test.com", body: "hi" })
		expect(fetch.mock.calls.at(-1)![0]).toBe("https://api.resend.com/emails")
	})

	it("warns once when POSTBOI_FROM shadows a differing config default.from", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		configure({ provider: "mock", default: { from: "config@test.com" } })
		vi.stubEnv("POSTBOI_FROM", "env@test.com")

		await mail({ to: "to@test.com", body: "hi" })
		await mail({ to: "to@test.com", body: "hi" })

		const shadow_warnings = warn.mock.calls.filter(([msg]) => String(msg).includes("POSTBOI_FROM"))
		expect(shadow_warnings).toHaveLength(1) // once, not per send
		warn.mockRestore()
	})

	it('resolves provider: "mock" with no credentials and no network', async () => {
		configure({ provider: "mock", default: { from: "from@test.com" } })
		const result = (await mail({ to: "to@test.com", body: "hi" })) as { id: string }
		expect(result.id).toBeTruthy()
		expect(fetch).not.toHaveBeenCalled()
	})

	it("supplies non-secret provider options from config.options (env still wins)", async () => {
		configure({ provider: "mailgun", options: { domain: "from-config.example.com" } })
		vi.stubEnv("MAILGUN_API_KEY", "key-abc")
		const ok = {
			ok: true,
			status: 200,
			headers: new Headers(),
			text: async () => JSON.stringify({ id: "<m>" }),
			json: async () => ({ id: "<m>" }),
		}
		fetch.mockResolvedValue(ok)

		// No MAILGUN_DOMAIN env — the domain comes from config.options.
		await mail({ to: "to@test.com", from: "f@test.com", body: "hi" })
		expect(fetch.mock.calls.at(-1)![0]).toContain("from-config.example.com")

		// With the env var set, it overrides the config value.
		vi.stubEnv("MAILGUN_DOMAIN", "from-env.example.com")
		await mail({ to: "to@test.com", from: "f@test.com", body: "hi" })
		expect(fetch.mock.calls.at(-1)![0]).toContain("from-env.example.com")
	})

	it("auto-loads a postboi.config file from disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "postboi-config-"))
		const original = process.cwd()
		try {
			writeFileSync(
				join(dir, "postboi.config.mjs"),
				`export default { retries: 3, auto_text: true, default: { from: "file@test.com" } }`
			)
			process.chdir(dir)

			const config = await load_config()
			expect(config.retries).toBe(3)
			expect(config.auto_text).toBe(true)
			expect(config.default?.from).toBe("file@test.com")
		} finally {
			process.chdir(original)
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
