import { describe, it, expect, vi, afterEach } from "vitest"
import { table, api_command } from "./api.js"

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe("table", () => {
	it("aligns columns ignoring ANSI colour codes", () => {
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		table(
			["NAME", "STATUS"],
			[
				["a", "\x1b[32mverified\x1b[0m"],
				["longer-name", "pending"],
			]
		)
		// Strip colours: every row's STATUS column starts at the same offset.
		// eslint-disable-next-line no-control-regex
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
		expect(plain[1].indexOf("verified")).toBe(plain[2].indexOf("pending"))
		expect(plain[0].indexOf("STATUS")).toBe(plain[2].indexOf("pending"))
	})
})

describe("api_command", () => {
	it("returns false for commands it doesn't own", async () => {
		expect(await api_command("init", [])).toBe(false)
		expect(await api_command("definitely-not-a-command", [])).toBe(false)
	})
})

describe("send-address", () => {
	function stub_fetch(response: unknown) {
		const calls: Array<{ url: string; init?: RequestInit }> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init })
				return new Response(JSON.stringify(response), { status: 200 })
			})
		)
		vi.spyOn(console, "log").mockImplementation(() => {})
		return calls
	}

	it("PATCHes /v1/account with the new address", async () => {
		const calls = stub_fetch({ send_address: "hello@acme.example" })
		expect(await api_command("send-address", ["hello@acme.example"])).toBe(true)
		expect(calls[0].url).toContain("/v1/account")
		expect(calls[0].init?.method).toBe("PATCH")
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ send_address: "hello@acme.example" })
	})

	it("shows the current address (a plain GET) when given no argument", async () => {
		const calls = stub_fetch({ send_address: "brisk-otter-cove@send.postboi.email" })
		expect(await api_command("send-address", [])).toBe(true)
		expect(calls[0].init?.method ?? "GET").toBe("GET")
	})
})

describe("contacts", () => {
	function stub_fetch(response: unknown) {
		const calls: Array<{ url: string; init?: RequestInit }> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init })
				return new Response(JSON.stringify(response), { status: 200 })
			})
		)
		vi.spyOn(console, "log").mockImplementation(() => {})
		return calls
	}

	it("add POSTs /v1/contacts with the parsed --name and --data flags", async () => {
		const calls = stub_fetch({ email: "ada@example.com", name: "Ada" })
		expect(
			await api_command("contacts", [
				"add",
				"ada@example.com",
				"--name",
				"Ada",
				"--data",
				'{"plan":"pro"}',
			])
		).toBe(true)
		expect(calls[0].url).toContain("/v1/contacts")
		expect(calls[0].init?.method).toBe("POST")
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			email: "ada@example.com",
			name: "Ada",
			data: { plan: "pro" },
		})
	})

	it("a bare email GETs the contact and its memberships", async () => {
		const calls = stub_fetch({ email: "ada@example.com", memberships: [] })
		expect(await api_command("contacts", ["ada@example.com"])).toBe(true)
		expect(calls[0].url).toContain("/v1/contacts/ada%40example.com")
		expect(calls[0].init?.method ?? "GET").toBe("GET")
	})

	it("remove DELETEs the contact", async () => {
		const calls = stub_fetch({ email: "ada@example.com", deleted: true })
		expect(await api_command("contacts", ["remove", "ada@example.com"])).toBe(true)
		expect(calls[0].url).toContain("/v1/contacts/ada%40example.com")
		expect(calls[0].init?.method).toBe("DELETE")
	})
})
