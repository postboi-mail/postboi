import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	configure,
	config,
	get_settings,
	load_settings,
	reset_settings,
} from "$library/settings.js"
import Mock from "$library/mock.js"
import { send } from "$library/cloud.js"

const fetch = vi.fn()
global.fetch = fetch

beforeEach(() => {
	reset_settings()
	fetch.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("global settings", () => {
	it("configure() merges; later calls add to earlier ones", () => {
		configure({ retries: 2 })
		configure({ default: { from: "a@test.com" } })
		expect(get_settings()).toMatchObject({ retries: 2, default: { from: "a@test.com" } })
	})

	it("config() registers as a side effect and returns the value", () => {
		const value = config({ auto_text: true })
		expect(value).toEqual({ auto_text: true })
		expect(get_settings().auto_text).toBe(true)
	})

	it("applies global default + hooks to every provider instance", async () => {
		const before = vi.fn()
		configure({ default: { from: "global@test.com" }, hooks: { before: { send: before } } })

		const mail = new Mock()
		await mail.send({ to: "to@test.com", body: "hi" })

		expect(mail.last?.from.address).toBe("global@test.com")
		expect(before).toHaveBeenCalledOnce()
	})

	it("lets per-instance options override global settings", async () => {
		configure({ default: { from: "global@test.com" }, retries: 5 })
		const mail = new Mock({ default: { from: "local@test.com" } })
		await mail.send({ to: "to@test.com", body: "hi" })
		expect(mail.last?.from.address).toBe("local@test.com")
	})

	it("merges global hooks with instance hooks rather than replacing them", async () => {
		const global_hook = vi.fn()
		const instance_hook = vi.fn()
		configure({ hooks: { before: { send: global_hook }, after: { send: instance_hook } } })

		const mail = new Mock({ default: { from: "f@test.com" }, hooks: { after: { send: instance_hook } } })
		await mail.send({ to: "to@test.com", body: "hi" })

		expect(global_hook).toHaveBeenCalledOnce() // kept from global
		expect(instance_hook).toHaveBeenCalledOnce() // instance wins for after.send
	})

	it("zero-config send() uses settings.provider when POSTBOI_PROVIDER is unset", async () => {
		configure({ provider: "resend", default: { from: "from@test.com" } })
		vi.stubEnv("RESEND_API_KEY", "re_123")
		fetch.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			text: async () => JSON.stringify({ id: "1" }),
			json: async () => ({ id: "1" }),
		})

		await send({ to: "to@test.com", body: "hi" })
		expect(fetch.mock.calls.at(-1)![0]).toBe("https://api.resend.com/emails")
	})

	it("auto-loads a postboi.settings file from disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "postboi-settings-"))
		const original = process.cwd()
		try {
			writeFileSync(
				join(dir, "postboi.settings.mjs"),
				`export default { retries: 3, auto_text: true, default: { from: "file@test.com" } }`
			)
			process.chdir(dir)

			const settings = await load_settings()
			expect(settings.retries).toBe(3)
			expect(settings.auto_text).toBe(true)
			expect(settings.default?.from).toBe("file@test.com")
		} finally {
			process.chdir(original)
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
