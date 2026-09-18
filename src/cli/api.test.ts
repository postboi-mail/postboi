import { describe, it, expect, vi, afterEach } from "vitest"
import { table, api_command, parse_weekdays, describe_schedule } from "./api.js"

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

describe("exports", () => {
	function stub_fetch(response: unknown, status = 200) {
		const calls: Array<{ url: string; init?: RequestInit }> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init })
				return new Response(JSON.stringify(response), { status })
			})
		)
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		return { calls, lines }
	}

	const created = {
		id: "exp_1",
		name: "Weekly enquiries",
		recipients: [{ email: "james@example.com" }],
		filter: { form: "frm_1" },
		format: "csv",
		window: "since_last_run",
		schedule: { frequency: "weekly", days: [1], month_day: 1, send_time: "09:00", timezone: "UTC" },
		paused: false,
		next_run_at: "2026-09-21T09:00:00.000Z",
		last_error: null,
	}

	it("add POSTs /v1/exports with the recipients, filter and schedule as given", async () => {
		const { calls, lines } = stub_fetch(created)
		expect(
			await api_command("exports", [
				"add",
				"Weekly",
				"enquiries",
				"--to",
				"james@example.com",
				"--form",
				"Contact",
				"--weekly",
				"--day",
				"fri",
				"--at",
				"17:30",
				"--tz",
				"Europe/London",
				"--xlsx",
				"--no-fields",
			])
		).toBe(true)
		expect(calls[0].url).toContain("/v1/exports")
		expect(calls[0].init?.method).toBe("POST")
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			name: "Weekly enquiries",
			recipients: "james@example.com",
			filter: { form: "Contact" },
			format: "xlsx",
			fields: false,
			schedule: { frequency: "weekly", days: [5], send_time: "17:30", timezone: "Europe/London" },
		})
		// The schedule is said back, so a defaulted day or zone is visible.
		expect(lines.join("\n")).toContain("weekly on Monday at 09:00 UTC")
		expect(lines.join("\n")).toContain("postboi exports run exp_1")
	})

	it("add leaves the API's defaults to the API", async () => {
		const { calls } = stub_fetch(created)
		await api_command("exports", ["add", "Daily", "--to", "a@b.co, Ops <ops@b.co>", "--daily"])
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			name: "Daily",
			recipients: "a@b.co, Ops <ops@b.co>",
			filter: {},
			schedule: { frequency: "daily" },
		})
	})

	it("add refuses without a name, recipients or exactly one frequency", async () => {
		stub_fetch(created)
		await expect(api_command("exports", ["add", "--to", "a@b.co", "--weekly"])).rejects.toThrow(
			/Usage: postboi exports add/
		)
		await expect(api_command("exports", ["add", "X", "--weekly"])).rejects.toThrow(/Usage/)
		await expect(api_command("exports", ["add", "X", "--to", "a@b.co"])).rejects.toThrow(/Usage/)
		await expect(
			api_command("exports", ["add", "X", "--to", "a@b.co", "--daily", "--weekly"])
		).rejects.toThrow(/Usage/)
	})

	it("run, pause, resume and delete hit the item routes", async () => {
		const { calls } = stub_fetch({ ...created, paused: true, next_run_at: null })
		await api_command("exports", ["run", "exp_1"])
		await api_command("exports", ["pause", "exp_1"])
		await api_command("exports", ["resume", "exp_1"])
		await api_command("exports", ["delete", "exp_1"])
		expect(calls.map((c) => [c.url.replace(/^.*\/v1/, "/v1"), c.init?.method])).toEqual([
			["/v1/exports/exp_1/run", "POST"],
			["/v1/exports/exp_1", "PATCH"],
			["/v1/exports/exp_1", "PATCH"],
			["/v1/exports/exp_1", "DELETE"],
		])
		expect(JSON.parse(String(calls[1].init?.body))).toEqual({ paused: true })
		expect(JSON.parse(String(calls[2].init?.body))).toEqual({ paused: false })
	})

	it("lists what is scheduled and when it next runs", async () => {
		const { lines } = stub_fetch({
			exports: [created, { ...created, id: "exp_2", paused: true, next_run_at: null }],
		})
		expect(await api_command("exports", [])).toBe(true)
		expect(await api_command("exports", ["list"])).toBe(true) // the alias people guess
		const text = lines.join("\n")
		expect(text).toContain("Weekly enquiries")
		expect(text).toContain("weekly on Monday at 09:00 UTC")
		expect(text).toContain("2026-09-21 09:00")
		expect(text).toContain("paused")
	})

	it("surfaces the API's message on a refusal", async () => {
		stub_fetch({ message: "This export is paused — resume it first.", code: "export_paused" }, 409)
		await expect(api_command("exports", ["run", "exp_1"])).rejects.toThrow(
			/paused — resume it first/
		)
	})
})

describe("parse_weekdays", () => {
	it("takes names, prefixes and numbers, in a comma list", () => {
		expect(parse_weekdays("mon")).toEqual([1])
		expect(parse_weekdays("Friday,0")).toEqual([5, 0])
		expect(parse_weekdays("tue, thu")).toEqual([2, 4])
	})
	it("refuses what isn't a weekday", () => {
		expect(() => parse_weekdays("7")).toThrow(/weekday/)
		expect(() => parse_weekdays("m")).toThrow(/weekday/)
	})
})

describe("describe_schedule", () => {
	const base = { days: [], month_day: 1, send_time: "09:00", timezone: "UTC" }
	it("reads the three frequencies back", () => {
		expect(describe_schedule({ ...base, frequency: "daily" })).toBe("daily at 09:00 UTC")
		expect(describe_schedule({ ...base, frequency: "weekly", days: [1, 5] })).toBe(
			"weekly on Monday, Friday at 09:00 UTC"
		)
		expect(
			describe_schedule({ ...base, frequency: "monthly", month_day: 22, timezone: "Europe/London" })
		).toBe("monthly on the 22nd at 09:00 Europe/London")
	})
})
