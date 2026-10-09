import { describe, it, expect, vi, afterEach } from "vitest"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { stdin, stdout } from "node:process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strip_ansi } from "./prompts.js"
import {
	table,
	api_command,
	parse_weekdays,
	describe_schedule,
	download_target,
	error_json,
	ApiCommandError,
	parse_email_list,
	slug,
	image_ext,
	versus_previous,
	testing_io,
} from "./api.js"

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

	it("answers --help and -h with the command's own help, without calling the API", async () => {
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		const fetch_spy = vi.fn()
		vi.stubGlobal("fetch", fetch_spy)

		expect(await api_command("testing", ["run", "--help"])).toBe(true)
		expect(await api_command("lists", ["-h"])).toBe(true)

		expect(fetch_spy).not.toHaveBeenCalled()
		expect(lines[0]).toContain("bunx postboi testing")
		expect(lines[0]).toContain("run <file.html or ->")
		expect(lines[1]).toContain("bunx postboi lists")
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

	it("download fetches the file with the filter as a query and writes it where asked", async () => {
		const calls: Array<string> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		const csv =
			"\uFEFFSent at,Subject\r\n2026-09-12T08:00:00.000Z,Query\r\n2026-09-13T08:00:00.000Z,Query\r\n"
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				calls.push(url)
				return new Response(csv, {
					status: 200,
					headers: {
						"Content-Type": "text/csv; charset=utf-8",
						"Content-Disposition": 'attachment; filename="acme-messages.csv"',
					},
				})
			})
		)
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		const dir = mkdtempSync(join(tmpdir(), "postboi-export-"))
		const out = join(dir, "enquiries.csv")

		expect(
			await api_command("exports", [
				"download",
				"--form",
				"Contact",
				"--since",
				"2026-09-01",
				"--status",
				"delivered, bounced",
				"--no-fields",
				"--out",
				out,
			])
		).toBe(true)
		expect(calls[0].replace(/^.*\/v1/, "/v1")).toBe(
			"/v1/exports/download?form=Contact&status=delivered%2Cbounced&since=2026-09-01&fields=0"
		)
		expect(readFileSync(out, "utf8")).toBe(csv)
		expect(lines.join("\n")).toContain("enquiries.csv")
		expect(lines.join("\n")).toContain("2 rows")

		// --xlsx asks for the spreadsheet
		await api_command("exports", ["download", "--xlsx", "--out", join(dir, "enquiries.xlsx")])
		expect(calls[1].replace(/^.*\/v1/, "/v1")).toBe("/v1/exports/download?format=xlsx")

		// without --out the server's name is used, then a plain default
		expect(download_target(undefined, "acme-messages.csv", "csv")).toBe("acme-messages.csv")
		expect(download_target(undefined, undefined, "xlsx")).toBe("export.xlsx")
		expect(download_target("mine.csv", "acme-messages.csv", "csv")).toBe("mine.csv")

		// a stray positional is a usage error, not a filter
		await expect(api_command("exports", ["download", "Contact"])).rejects.toThrow(
			/Usage: postboi exports download/
		)
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

describe("`list` as the bare listing", () => {
	it("is accepted on every noun that lists, and hits the collection GET", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init })
				const empty = Object.fromEntries(
					[
						"lists",
						"contacts",
						"domains",
						"webhooks",
						"members",
						"messages",
						"suppressions",
						"exports",
					].map((k) => [k, []])
				)
				return new Response(JSON.stringify({ ...empty, invites: [] }), { status: 200 })
			})
		)
		vi.spyOn(console, "log").mockImplementation(() => {})
		const nouns: Array<[string, string]> = [
			["lists", "/v1/lists"],
			["contacts", "/v1/contacts"],
			["domains", "/v1/domains"],
			["webhooks", "/v1/webhooks"],
			["members", "/v1/members"],
			["messages", "/v1/messages"],
			["suppressions", "/v1/suppressions"],
			["exports", "/v1/exports"],
		]
		for (const [noun, path] of nouns) {
			calls.length = 0
			expect(await api_command(noun, ["list"])).toBe(true)
			expect(calls[0].url.replace(/^.*\/v1/, "/v1")).toBe(path)
			expect(calls[0].init?.method ?? "GET").toBe("GET")
		}
	})

	it("stays a list name for recipients, whose first word is the list", async () => {
		const calls: Array<string> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				calls.push(url)
				return new Response(JSON.stringify({ name: "list", recipients: [] }), { status: 200 })
			})
		)
		vi.spyOn(console, "log").mockImplementation(() => {})
		await api_command("recipients", ["list"])
		expect(calls[0]).toContain("/v1/lists/list")
	})
})

describe("--json", () => {
	function stub(response: unknown, status = 200) {
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(response), { status }))
		)
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		return lines
	}

	it("prints the API's body and nothing else, on any account command", async () => {
		const account = {
			id: "acct_1",
			name: "Acme",
			plan: "starter",
			send_address: "a@send.postboi.email",
		}
		const lines = stub(account)
		expect(await api_command("whoami", ["--json"])).toBe(true)
		expect(lines).toHaveLength(1)
		expect(JSON.parse(lines[0])).toEqual(account)

		lines.length = 0
		const list = { id: "lst_1", name: "News" }
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(list), { status: 200 }))
		)
		await api_command("lists", ["add", "News", "--json"])
		expect(lines).toHaveLength(1)
		expect(JSON.parse(lines[0])).toEqual(list)
	})

	it("prints nothing after a download that went to stdout — the bytes are the output", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("a,b\r\n1,2\r\n", { status: 200, headers: { "Content-Type": "text/csv" } })
			)
		)
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		const written: Array<Uint8Array> = []
		const { stdout } = await import("node:process")
		vi.spyOn(stdout, "write").mockImplementation(((chunk: Uint8Array) => {
			written.push(chunk)
			return true
		}) as never)
		await api_command("exports", ["download", "--out", "-", "--json"])
		expect(written).toHaveLength(1)
		expect(lines).toHaveLength(0)
	})

	it("is off again for the next command", async () => {
		const lines = stub({ send_address: "a@send.postboi.email" })
		await api_command("send-address", ["--json"])
		await api_command("send-address", [])
		expect(lines).toHaveLength(2)
		expect(lines[1]).toContain("Send address:")
	})

	it("a refusal carries the API's code, for people and for JSON", async () => {
		stub({ message: "That name is taken.", code: "name_taken" }, 409)
		const failure = await api_command("lists", ["add", "News"]).catch((e: unknown) => e)
		expect(failure).toBeInstanceOf(ApiCommandError)
		expect((failure as ApiCommandError).code).toBe("name_taken")
		expect((failure as ApiCommandError).message).toBe("That name is taken.")
		expect(JSON.parse(error_json(failure))).toEqual({
			error: { message: "That name is taken.", code: "name_taken" },
		})
	})

	it("a bodiless failure still gets a code from the status", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 502 }))
		)
		const failure = await api_command("whoami", []).catch((e: unknown) => e)
		expect((failure as ApiCommandError).code).toBe("http_502")
	})
})

describe("send", () => {
	function stub(response: unknown, status = 200) {
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

	it("POSTs /v1/send with the recipients parsed and the body as given", async () => {
		const { calls, lines } = stub({ id: "msg_1" })
		expect(
			await api_command("send", [
				"--to",
				"Ada <ada@acme.com>, bob@acme.com",
				"--subject",
				"Hello",
				"--text",
				"hi there",
				"--from",
				"Ops <ops@acme.com>",
				"--tag",
				"welcome, v2",
			])
		).toBe(true)
		expect(calls[0].url).toContain("/v1/send")
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			to: [{ email: "ada@acme.com", name: "Ada" }, { email: "bob@acme.com" }],
			subject: "Hello",
			text: "hi there",
			from: { email: "ops@acme.com", name: "Ops" },
			tags: ["welcome", "v2"],
		})
		expect(lines[0]).toContain("msg_1")
		expect(lines.join("\n")).toContain("postboi messages msg_1")
	})

	it("surfaces the claim URL on a sandboxed send, as the skill requires", async () => {
		const { lines } = stub({ id: "msg_1", sandbox: true, claim_url: "https://postboi.app/claim/x" })
		await api_command("send", ["--to", "a@b.co", "--subject", "s", "--html", "<p>x</p>"])
		expect(lines.join("\n")).toContain("https://postboi.app/claim/x")
	})

	it("reads a body from a file, HTML by its look", async () => {
		const { calls } = stub({ id: "msg_1" })
		const dir = mkdtempSync(join(tmpdir(), "postboi-send-"))
		const { writeFileSync } = await import("node:fs")
		writeFileSync(join(dir, "body.txt"), "<p>looks like html</p>")
		await api_command("send", ["--to", "a@b.co", "--subject", "s", "--file", join(dir, "body.txt")])
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
			html: "<p>looks like html</p>",
		})
		writeFileSync(join(dir, "body.txt"), "plain words")
		await api_command("send", ["--to", "a@b.co", "--subject", "s", "--file", join(dir, "body.txt")])
		expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ text: "plain words" })
	})

	it("refuses without a recipient, a subject or a body", async () => {
		stub({ id: "msg_1" })
		await expect(api_command("send", ["--to", "a@b.co", "--subject", "s"])).rejects.toThrow(
			/Usage: postboi send/
		)
		await expect(api_command("send", ["--subject", "s", "--text", "t"])).rejects.toThrow(/Usage/)
		await expect(
			api_command("send", ["--to", "nobody", "--subject", "s", "--text", "t"])
		).rejects.toThrow(/at least one email/)
	})
})

describe("messages <id> and cancel", () => {
	function stub(response: unknown, status = 200) {
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

	it("a word that isn't a status is an id, read back with its fields", async () => {
		const { calls, lines } = stub({
			id: "msg_1",
			from: "forms@acme.com",
			to: ["me@acme.com"],
			subject: "Query",
			status: "delivered",
			form: { id: "frm_1", name: "Contact" },
			fields: [
				["name", "Ada"],
				["interest", "web"],
			],
			open_count: 2,
			opened_at: "2026-09-12T09:00:00.000Z",
			created_at: "2026-09-12T08:00:00.000Z",
		})
		await api_command("messages", ["msg_1"])
		expect(calls[0].url.replace(/^.*\/v1/, "/v1")).toBe("/v1/messages/msg_1")
		const text = lines.join("\n")
		expect(text).toContain("Contact")
		expect(text).toContain("Ada")
		expect(text).toContain("2×")
	})

	it("a status still lists", async () => {
		const { calls } = stub({ messages: [] })
		await api_command("messages", ["bounced"])
		expect(calls[0].url.replace(/^.*\/v1/, "/v1")).toBe("/v1/messages?status=bounced")
	})

	it("cancel POSTs the cancel route and says so", async () => {
		const { calls, lines } = stub({ id: "msg_1", status: "canceled" })
		await api_command("messages", ["cancel", "msg_1"])
		expect(calls[0].url.replace(/^.*\/v1/, "/v1")).toBe("/v1/messages/msg_1/cancel")
		expect(calls[0].init?.method).toBe("POST")
		expect(lines[0]).toContain("canceled")
	})
})

describe("parse_email_list", () => {
	it("takes bare, named and comma-separated addresses", () => {
		expect(parse_email_list("a@b.co")).toEqual([{ email: "a@b.co" }])
		expect(parse_email_list('"Ada L" <ada@b.co>; bob@b.co')).toEqual([
			{ email: "ada@b.co", name: "Ada L" },
			{ email: "bob@b.co" },
		])
		expect(parse_email_list("nobody")).toEqual([])
	})
})

describe("the nouns the API had and the CLI didn't", () => {
	function stub(response: unknown, status = 200) {
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
		const path = (i = 0) => calls[i].url.replace(/^.*\/v1/, "/v1")
		const body = (i = 0) => JSON.parse(String(calls[i].init?.body))
		return { calls, lines, path, body }
	}

	it("forms lists, and points at the code for anything else", async () => {
		const { path, lines } = stub({
			forms: [
				{
					id: "frm_1",
					name: "Contact",
					kind: "library",
					paused: false,
					created_at: "2026-09-01T00:00:00.000Z",
				},
			],
		})
		expect(await api_command("forms", [])).toBe(true)
		expect(path()).toBe("/v1/forms")
		expect(lines.join("\n")).toContain("named in code")
		await expect(api_command("forms", ["add", "X"])).rejects.toThrow(/named from your code/)
	})

	it("notifications: list, add on a schedule or on signup, delete", async () => {
		const { path, body, lines } = stub({
			id: "ntf_1",
			recipients: [{ email: "ops@acme.com" }],
			schedule: {
				frequency: "weekly",
				days: [5],
				month_day: 1,
				send_time: "09:00",
				timezone: "UTC",
			},
		})
		await api_command("notifications", [
			"Newsletter",
			"add",
			"--to",
			"ops@acme.com",
			"--weekly",
			"--day",
			"fri",
			"--subject",
			"New signups",
		])
		expect(path()).toBe("/v1/lists/Newsletter/notifications")
		expect(body()).toEqual({
			recipients: "ops@acme.com",
			subject: "New signups",
			schedule: { frequency: "weekly", days: [5] },
		})
		expect(lines[0]).toContain("weekly on Friday")

		await api_command("notifications", ["Newsletter", "add", "--to", "ops@acme.com", "--on-signup"])
		expect(body(1)).toEqual({ recipients: "ops@acme.com", schedule: { frequency: "subscribe" } })

		await api_command("notifications", ["Newsletter", "delete", "ntf_1"])
		expect(path(2)).toBe("/v1/lists/Newsletter/notifications/ntf_1")

		await expect(
			api_command("notifications", ["Newsletter", "add", "--to", "a@b.co"])
		).rejects.toThrow(/Usage/)
		await expect(api_command("notifications", [])).rejects.toThrow(/Usage/)
	})

	it("lists send posts a broadcast", async () => {
		const { path, body, lines } = stub({ ids: ["msg_1", "msg_2"], recipients: 2 })
		await api_command("lists", [
			"send",
			"Newsletter",
			"--subject",
			"Hi",
			"--text",
			"hello",
			"--from",
			"Ops <ops@acme.com>",
		])
		expect(path()).toBe("/v1/lists/Newsletter/send")
		expect(body()).toEqual({
			subject: "Hi",
			text: "hello",
			from: { email: "ops@acme.com", name: "Ops" },
		})
		expect(lines[0]).toContain("2")
		await expect(api_command("lists", ["send", "Newsletter", "--subject", "Hi"])).rejects.toThrow(
			/Usage: postboi lists send/
		)
	})

	it("testing: add mints an address, <id> reads the report, clients lists the farm", async () => {
		const { path, body, lines } = stub({
			id: "tst_1",
			status: "waiting",
			address: "tst_1@test.postboi.email",
			created_at: "2026-09-01T00:00:00.000Z",
		})
		await api_command("testing", [
			"add",
			"--label",
			"welcome v2",
			"--clients",
			"gmail-web, outlook-win",
		])
		expect(path()).toBe("/v1/testing")
		expect(body()).toEqual({ label: "welcome v2", clients: ["gmail-web", "outlook-win"] })
		expect(lines.join("\n")).toContain("tst_1@test.postboi.email")

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							id: "tst_1",
							status: "received",
							label: "welcome v2",
							from: "a@acme.com",
							subject: "Welcome",
							authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
							spam: { score: 1.2 },
							report: {
								status: "warnings",
								findings: [{ level: "warning", title: "Image without alt text" }],
							},
							previews: [{ client: "gmail-web", name: "Gmail (web)", status: "ready" }],
							created_at: "2026-09-01T00:00:00.000Z",
						}),
						{ status: 200 }
					)
			)
		)
		lines.length = 0
		await api_command("testing", ["tst_1"])
		const text = lines.join("\n")
		expect(text).toContain("Image without alt text")
		expect(text).toContain("Gmail (web)")
		expect(text).toContain("dmarc")

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: [{ id: "gmail-web", name: "Gmail (web)", group: "Webmail", default: true }],
							max_per_test: 25,
						}),
						{ status: 200 }
					)
			)
		)
		lines.length = 0
		await api_command("testing", ["clients"])
		expect(lines.join("\n")).toContain("gmail-web")
	})

	it("domains inbound turns receiving on (printing the records) and off", async () => {
		const { path, lines, calls } = stub({
			id: "dom_1",
			domain: "acme.com",
			status: "verified",
			records: [],
			inbound: {
				domain: "reply.acme.com",
				status: "pending",
				records: [{ type: "MX", name: "reply.acme.com", value: "in.postboi.email", priority: 10 }],
			},
		})
		await api_command("domains", ["inbound", "acme.com"])
		expect(path()).toBe("/v1/domains/acme.com/inbound")
		expect(calls[0].init?.method).toBe("POST")
		expect(lines.join("\n")).toContain("10 in.postboi.email")
		await api_command("domains", ["inbound", "acme.com", "--off"])
		expect(calls[1].init?.method).toBe("DELETE")
	})

	it("webhooks rotate prints the new secret and points at sync", async () => {
		const { path, lines, calls } = stub({ id: "wh_1", secret: "whsec_new" })
		await api_command("webhooks", ["rotate", "wh_1"])
		expect(path()).toBe("/v1/webhooks/wh_1/rotate")
		expect(calls[0].init?.method).toBe("POST")
		expect(lines.join("\n")).toContain("whsec_new")
		expect(lines.join("\n")).toContain("postboi sync")
	})
})

describe("testing run and download", () => {
	type Route = (init: RequestInit | undefined, url: URL) => unknown
	/** Answers by `METHOD /path`; a function route sees the request, a Response goes back as-is. */
	function serve(routes: Record<string, unknown>) {
		const calls: Array<{ key: string; body?: unknown }> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubEnv("POSTBOI_API_URL", "https://api.test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const url = new URL(input)
				const key = `${init?.method ?? "GET"} ${url.pathname}`
				const body = init?.body
				calls.push({ key, body: typeof body === "string" ? JSON.parse(body) : body })
				const route = routes[key]
				if (route === undefined)
					return new Response(JSON.stringify({ message: key }), { status: 404 })
				const answer = typeof route === "function" ? (route as Route)(init, url) : route
				return answer instanceof Response ? answer : new Response(JSON.stringify(answer))
			})
		)
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		return { calls, lines }
	}

	const png = () =>
		new Response(new Uint8Array([137, 80]), { headers: { "content-type": "image/png" } })
	const summary = { state: "done", total: 2, ready: 1, failed: 1, pending: 0, notes: [] }

	function workspace() {
		const dir = mkdtempSync(join(tmpdir(), "postboi-testing-"))
		const file = join(dir, "partner.html")
		writeFileSync(file, "<title>Partner news</title><p>hi</p>")
		return { dir, file, out: join(dir, "shots") }
	}

	afterEach(() => {
		process.exitCode = undefined
		testing_io.poll_ms = 5000
		testing_io.timeout_ms = 15 * 60_000
	})

	it("helpers: slugs, extensions and the comparison column", () => {
		expect(slug("Outlook 2024 (Windows) Dark")).toBe("outlook-2024-windows-dark")
		expect(slug("Gmail ✉ Ünïcode")).toBe("gmail-unicode")
		expect(slug("")).toBe("other")
		expect(image_ext("image/jpeg")).toBe("jpg")
		expect(image_ext("image/svg+xml; charset=utf-8")).toBe("svg")
		expect(image_ext(null)).toBe("png")
		expect(versus_previous({ status: "ready" })).toBe("")
		expect(versus_previous({ status: "ready", previous: null })).toBe("new")
		expect(versus_previous({ status: "ready", reused: true, previous: null })).toBe("reused")
		const previous = { run_id: "r", preview_id: "p", url: "/x", created_at: "" }
		expect(versus_previous({ status: "ready", previous: { ...previous, identical: true } })).toBe(
			"unchanged"
		)
		expect(versus_previous({ status: "ready", previous: { ...previous, identical: false } })).toBe(
			"changed"
		)
	})

	it("pastes, waits, saves each capture to a stable path and exits 1 on a failed capture", async () => {
		const { dir, file, out } = workspace()
		let polls = 0
		testing_io.poll_ms = 0
		const { calls, lines } = serve({
			"GET /v1/testing/clients": {
				data: [{ id: "gmail_web", name: "Gmail (web)", group: "Webmail", default: true }],
				max_per_test: 25,
				renders: { left: 50, monthly: 50, credits: 0 },
			},
			"POST /v1/testing": { id: "test_1", url: "https://api.test/dashboard/acc_1/testing/test_1" },
			"POST /v1/testing/test_1/source": { id: "test_1", status: "received" },
			"GET /v1/testing/test_1": () =>
				++polls === 1
					? {
							id: "test_1",
							status: "received",
							screenshots: { ...summary, state: "rendering" },
							previews: [],
						}
					: {
							id: "test_1",
							status: "received",
							url: "https://api.test/dashboard/acc_1/testing/test_1",
							report: { status: "warning", findings: [{ id: "x" }] },
							screenshots: summary,
							renders: { used: 1 },
							previews: [
								{
									id: "prev_1",
									client_id: "gmail_web",
									client_name: "Gmail (web)",
									group: "Webmail",
									status: "ready",
									url: "/v1/testing/test_1/previews/prev_1",
									previous: null,
								},
								{
									id: "prev_2",
									client_id: "yahoo",
									client_name: "Yahoo",
									status: "failed",
									error: "farm said no",
								},
							],
						},
			"GET /v1/testing/test_1/previews/prev_1": png,
		})

		await api_command("testing", ["run", file, "--out", out])

		// The default set is sent explicitly, so a continued series can't inherit an older pick.
		expect(calls.find((c) => c.key === "POST /v1/testing")?.body).toEqual({
			series: "partner",
			clients: ["gmail_web"],
		})
		expect(calls.find((c) => c.key === "POST /v1/testing/test_1/source")?.body).toEqual({
			subject: "Partner news",
			html: "<title>Partner news</title><p>hi</p>",
		})
		// No /previews call: the run carries them.
		expect(calls.some((c) => c.key.endsWith("/previews"))).toBe(false)
		const saved = join(out, "webmail", "gmail-web.png")
		expect([...readFileSync(saved)]).toEqual([137, 80])
		const text = lines.join("\n")
		expect(text).toContain("new")
		expect(text).toContain("farm said no")
		expect(text).toContain("warning, 1 finding")
		expect(text).toContain("1 used")
		expect(text).toContain("https://api.test/dashboard/acc_1/testing/test_1")
		expect(process.exitCode).toBe(1)
		expect(dir).toBeTruthy()
	})

	it("uploads local assets once, warns about missing ones, and pastes the rewritten HTML", async () => {
		const { dir, out } = workspace()
		writeFileSync(join(dir, "package.json"), "{}")
		mkdirSync(join(dir, "images"))
		mkdirSync(join(dir, "public"))
		writeFileSync(join(dir, "images", "hero.png"), "hero")
		writeFileSync(join(dir, "public", "logo.png"), "logo")
		const file = join(dir, "public", "email.html")
		const html = [
			`<img src="/images/hero.png"><img src="logo.png" srcset="logo.png 1x, /images/hero.png 2x">`,
			`<!--[if mso]><v:fill src="/images/hero.png" /><![endif]-->`,
			`<img src="gone.png"><img src="gone.png"><img src="https://cdn.test/a.png"><img src="{{ img }}">`,
		].join("")
		writeFileSync(file, html)
		const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32)
		const url = (s: string) => `https://assets.test/testing/acc_1/${hash(s)}.png`
		const { calls, lines } = serve({
			"POST /v1/testing/assets": (init: RequestInit) => ({
				assets: JSON.parse(String(init.body)).assets.map((a: { hash: string; ext: string }) => ({
					...a,
					url: `https://assets.test/testing/acc_1/${a.hash}.${a.ext}`,
					exists: a.hash === hash("logo"),
				})),
			}),
			[`PUT /v1/testing/assets/${hash("hero")}.png`]: () =>
				new Response(JSON.stringify({ url: url("hero") }), { status: 201 }),
			"GET /v1/testing/clients": { data: [], max_per_test: 25 },
			"POST /v1/testing": { id: "test_1" },
			"POST /v1/testing/test_1/source": { id: "test_1", status: "received" },
		})

		await api_command("testing", ["run", file, "--out", out, "--no-wait"])

		expect(calls.find((c) => c.key === "POST /v1/testing/assets")?.body).toEqual({
			assets: [
				{ hash: hash("hero"), ext: "png", size: 4 },
				{ hash: hash("logo"), ext: "png", size: 4 },
			],
		})
		const puts = calls.filter((c) => c.key.startsWith("PUT "))
		expect(puts).toHaveLength(1)
		expect(new TextDecoder().decode(puts[0].body as Uint8Array)).toBe("hero")
		const pasted = calls.find((c) => c.key === "POST /v1/testing/test_1/source")?.body as {
			html: string
		}
		expect(pasted.html).toBe(
			html.replaceAll("/images/hero.png", url("hero")).replaceAll(`"logo.png`, `"${url("logo")}`)
		)
		const text = lines.join("\n")
		expect(text).toContain("assets   2 local (1 uploaded, 1 already there)")
		expect(text.match(/gone\.png: no such file/g)).toHaveLength(1)
	})

	it("--no-assets pastes the HTML as it is, and no local references means no line", async () => {
		const { dir, file, out } = workspace()
		writeFileSync(join(dir, "a.png"), "a")
		writeFileSync(file, `<img src="a.png">`)
		const routes = {
			"GET /v1/testing/clients": { data: [], max_per_test: 25 },
			"POST /v1/testing": { id: "test_1" },
			"POST /v1/testing/test_1/source": { id: "test_1", status: "received" },
		}
		const { calls } = serve(routes)
		await api_command("testing", ["run", file, "--out", out, "--no-wait", "--no-assets"])
		expect(calls.some((c) => c.key.includes("/assets"))).toBe(false)
		expect(calls.find((c) => c.key.endsWith("/source"))?.body).toMatchObject({
			html: `<img src="a.png">`,
		})

		writeFileSync(file, `<img src="https://cdn.test/a.png">`)
		const second = serve(routes)
		await api_command("testing", ["run", file, "--out", out, "--no-wait"])
		expect(second.calls.some((c) => c.key.includes("/assets"))).toBe(false)
		expect(second.lines.join("\n")).not.toContain("assets")
	})

	it("--all splits past the per-run cap into batches of one series, first batch alone", async () => {
		const { file, out } = workspace()
		const data = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, name: `Client ${i}` }))
		let next = 0
		const created: Array<string> = []
		const { calls, lines } = serve({
			"GET /v1/testing/clients": {
				data,
				max_per_test: 25,
				renders: { left: 100, monthly: 100, credits: 0 },
			},
			"POST /v1/testing": () => {
				const id = `test_${++next}`
				created.push(id)
				return { id }
			},
			"POST /v1/testing/test_1/source": { id: "test_1", status: "received" },
			"POST /v1/testing/test_2/source": { id: "test_2", status: "received" },
			"GET /v1/testing/test_1": {
				id: "test_1",
				status: "received",
				report: { status: "pass", findings: [] },
				screenshots: { ...summary, failed: 0 },
				previews: [],
			},
			"GET /v1/testing/test_2": {
				id: "test_2",
				status: "received",
				screenshots: { ...summary, failed: 0 },
				previews: [],
			},
		})

		await api_command("testing", [
			"run",
			file,
			"--all",
			"--series",
			"Partner v2",
			"--out",
			out,
			"--json",
		])

		const creates = calls
			.filter((c) => c.key === "POST /v1/testing")
			.map((c) => c.body as { series: string; clients: Array<string> })
		expect(creates.map((b) => b.clients.length)).toEqual([25, 5])
		expect(creates.every((b) => b.series === "Partner v2")).toBe(true)
		expect(created).toEqual(["test_1", "test_2"])
		// --json: one document and nothing else.
		expect(lines).toHaveLength(1)
		const doc = JSON.parse(lines[0])
		expect(doc.series).toBe("Partner v2")
		expect(doc.runs.map((r: { id: string }) => r.id)).toEqual(["test_1", "test_2"])
		expect(process.exitCode).toBeUndefined()
	})

	it("falls back to /previews and a settled row list on a server without the summary", async () => {
		const { file, out } = workspace()
		testing_io.poll_ms = 0
		let listings = 0
		const { lines } = serve({
			"GET /v1/testing/clients": {
				data: [{ id: "gmail_web", name: "Gmail (web)", group: "Webmail" }],
				max_per_test: 25,
			},
			"POST /v1/testing": { id: "test_1" },
			"POST /v1/testing/test_1/source": { id: "test_1", status: "received" },
			"GET /v1/testing/test_1": {
				id: "test_1",
				status: "received",
				report: { status: "pass", findings: [] },
			},
			// Empty right after the paste, then pending, then ready: none of these is "done" early.
			"GET /v1/testing/test_1/previews": () => {
				listings++
				if (listings === 1) return { data: [] }
				const status = listings === 2 ? "pending" : "ready"
				return {
					data: [
						{
							id: "prev_1",
							client_id: "gmail_web",
							client_name: "Gmail (web)",
							status,
							url: status === "ready" ? "/v1/testing/test_1/previews/prev_1" : undefined,
						},
					],
				}
			},
			"GET /v1/testing/test_1/previews/prev_1": png,
		})

		await api_command("testing", ["run", file, "--out", out])

		expect(listings).toBe(3)
		// The group came from the catalog, since the old preview row has none.
		expect([...readFileSync(join(out, "webmail", "gmail-web.png"))]).toEqual([137, 80])
		// No comparison data from this server, so no claim about it.
		expect(lines.join("\n")).not.toContain("new")
		expect(lines.join("\n")).toContain("https://api.test/dashboard/testing/test_1")
		expect(process.exitCode).toBeUndefined()
	})

	it("exits 1 on an error report, and the timeout names the command that resumes", async () => {
		const { file, out } = workspace()
		serve({
			"GET /v1/testing/clients": { data: [], max_per_test: 25 },
			"POST /v1/testing": { id: "test_1" },
			"POST /v1/testing/test_1/source": { id: "test_1", status: "received" },
			"GET /v1/testing/test_1": {
				id: "test_1",
				status: "received",
				report: { status: "error", findings: [{}] },
				screenshots: { state: "disabled", total: 0, ready: 0, failed: 0, pending: 0, notes: [] },
			},
		})
		await api_command("testing", ["run", file, "--out", out])
		expect(process.exitCode).toBe(1)

		process.exitCode = undefined
		testing_io.timeout_ms = 0
		serve({
			"GET /v1/testing/test_9": {
				id: "test_9",
				status: "received",
				screenshots: { ...summary, state: "rendering" },
				previews: [],
			},
		})
		await expect(api_command("testing", ["download", "test_9"])).rejects.toThrow(
			/postboi testing download test_9/
		)
	})

	it("asks before a big order on a terminal, and --yes skips the question", async () => {
		const { file, out } = workspace()
		const data = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `Client ${i}` }))
		const routes = {
			"GET /v1/testing/clients": {
				data,
				max_per_test: 25,
				renders: { left: 5, monthly: 5, credits: 0 },
			},
			"POST /v1/testing": { id: "test_1" },
			"POST /v1/testing/test_1/source": { id: "test_1", status: "received" },
		}
		const tty = [stdin.isTTY, stdout.isTTY]
		stdin.isTTY = true
		stdout.isTTY = true
		try {
			const confirm = vi.fn(async () => false)
			testing_io.confirm = confirm
			const { calls, lines } = serve(routes)
			await expect(api_command("testing", ["run", file, "--all", "--out", out])).rejects.toThrow(
				/Nothing ordered/
			)
			expect(confirm).toHaveBeenCalledOnce()
			expect(calls.some((c) => c.key === "POST /v1/testing")).toBe(false)
			expect(lines.join("\n")).toContain("7 clients will be skipped")

			confirm.mockClear()
			const second = serve(routes)
			await api_command("testing", ["run", file, "--all", "--out", out, "--no-wait", "--yes"])
			expect(confirm).not.toHaveBeenCalled()
			expect(second.calls.some((c) => c.key === "POST /v1/testing")).toBe(true)
			expect(second.lines.join("\n")).toContain("postboi testing download test_1")
		} finally {
			;[stdin.isTTY, stdout.isTTY] = tty
		}
	})

	it("download collects an existing run into a folder named after it", async () => {
		const { dir } = workspace()
		const out = join(dir, "collected")
		const { calls } = serve({
			"GET /v1/testing/test_5": {
				id: "test_5",
				status: "received",
				label: "partner",
				screenshots: { ...summary, failed: 0, total: 1 },
				previews: [
					{
						id: "p1",
						client_id: "a",
						client_name: "Apple Mail",
						group: "Application",
						status: "ready",
						url: "/v1/testing/test_5/previews/p1",
					},
				],
			},
			"GET /v1/testing/test_5/previews/p1": () =>
				new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
		})
		await api_command("testing", ["download", "test_5", "--out", out])
		expect(readFileSync(join(out, "application", "apple-mail.svg"), "utf8")).toBe("<svg/>")
		// Every preview had a group, so the catalog wasn't needed.
		expect(calls.some((c) => c.key === "GET /v1/testing/clients")).toBe(false)
	})

	it("sets list, save and delete by name; share and revoke", async () => {
		const set = { id: "set_1", name: "Core", clients: ["a", "b"], created_at: "" }
		const { calls, lines } = serve({
			"GET /v1/testing/sets": { data: [set] },
			"POST /v1/testing/sets": set,
			"DELETE /v1/testing/sets/set_1": () => new Response(null, { status: 204 }),
			"POST /v1/testing/test_1/share": { share_url: "https://api.test/share/testing/tok" },
			"DELETE /v1/testing/test_1/share": () => new Response(null, { status: 204 }),
		})
		await api_command("testing", ["sets"])
		expect(lines.join("\n")).toContain("Core")
		await api_command("testing", ["sets", "save", "Core", "--clients", "a, b"])
		expect(calls.find((c) => c.key === "POST /v1/testing/sets")?.body).toEqual({
			name: "Core",
			clients: ["a", "b"],
		})
		await api_command("testing", ["sets", "delete", "core"])
		expect(calls.some((c) => c.key === "DELETE /v1/testing/sets/set_1")).toBe(true)
		await api_command("testing", ["share", "test_1"])
		expect(lines.join("\n")).toContain("https://api.test/share/testing/tok")
		await api_command("testing", ["share", "test_1", "--revoke"])
		expect(calls.some((c) => c.key === "DELETE /v1/testing/test_1/share")).toBe(true)
	})
})

describe("assets", () => {
	const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32)
	const url = (s: string) => `https://mail-view.acme.test/assets/${hash(s)}.png`

	/** `/v1/assets` answering like the server: `logo` is already there, the rest are new. */
	function serve(extra: Record<string, Response> = {}) {
		const calls: Array<{ key: string; body?: unknown }> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubEnv("POSTBOI_API_URL", "https://api.test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const key = `${init?.method ?? "GET"} ${new URL(input).pathname}`
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
				calls.push({ key, body })
				if (extra[key]) return extra[key]
				if (key === "POST /v1/assets") {
					const assets = (body as { assets: Array<{ hash: string; ext: string }> }).assets
					return Response.json({
						assets: assets.map((a) => ({
							url: `https://mail-view.acme.test/assets/${a.hash}.${a.ext}`,
							exists: a.hash === hash("logo"),
						})),
					})
				}
				if (key.startsWith("PUT /v1/assets/")) {
					return Response.json({ url: `https://mail-view.acme.test${key.slice(7)}` })
				}
				if (key === "POST /v1/send") return Response.json({ id: "msg_1" })
				return new Response("Not found", { status: 404 })
			})
		)
		const lines: Array<string> = []
		vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
		return { calls, lines }
	}

	function project() {
		const dir = mkdtempSync(join(tmpdir(), "postboi-hosted-"))
		writeFileSync(join(dir, "package.json"), "{}")
		mkdirSync(join(dir, "images"))
		mkdirSync(join(dir, "dist"))
		writeFileSync(join(dir, "images", "logo.png"), "logo")
		writeFileSync(join(dir, "images", "hero.png"), "hero")
		return dir
	}

	it("uploads what every file shares once and rewrites each file in place", async () => {
		const dir = project()
		const a = join(dir, "dist", "a.html")
		const b = join(dir, "dist", "b.html")
		const plain = join(dir, "dist", "plain.html")
		writeFileSync(a, `<img src="/images/logo.png"><img src="/images/hero.png">`)
		writeFileSync(b, `<img src="../images/logo.png" srcset="/images/hero.png 2x">`)
		writeFileSync(plain, `<img src="https://cdn.test/x.png">`)
		const { calls, lines } = serve()

		await api_command("assets", [a, b, plain])

		const posts = calls.filter((c) => c.key === "POST /v1/assets")
		expect(posts).toHaveLength(1)
		expect(posts[0].body).toEqual({
			assets: [
				{ hash: hash("logo"), ext: "png", size: 4 },
				{ hash: hash("hero"), ext: "png", size: 4 },
			],
		})
		expect(calls.filter((c) => c.key.startsWith("PUT "))).toEqual([
			{ key: `PUT /v1/assets/${hash("hero")}.png`, body: expect.any(Uint8Array) },
		])
		expect(readFileSync(a, "utf8")).toBe(`<img src="${url("logo")}"><img src="${url("hero")}">`)
		expect(readFileSync(b, "utf8")).toBe(`<img src="${url("logo")}" srcset="${url("hero")} 2x">`)
		expect(readFileSync(plain, "utf8")).toBe(`<img src="https://cdn.test/x.png">`)
		expect(lines).toEqual(["assets   2 local (1 uploaded, 1 already there) in 3 files"])
	})

	it("- reads stdin and writes the HTML to stdout, the summary to stderr", async () => {
		const dir = project()
		const input = join(dir, "in.html")
		writeFileSync(input, `<img src="images/logo.png"><img src="gone.png">`)
		const { lines } = serve()
		const errors: Array<string> = []
		vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line))
		const written: Array<string> = []
		vi.spyOn(stdout, "write").mockImplementation(((chunk: string) => {
			written.push(chunk)
			return true
		}) as never)
		const fd = stdin.fd
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir)
		Object.defineProperty(stdin, "fd", { value: openSync(input, "r"), configurable: true })
		try {
			await api_command("assets", ["-", "--json"])
		} finally {
			Object.defineProperty(stdin, "fd", { value: fd, configurable: true })
			cwd.mockRestore()
		}
		expect(written).toEqual([`<img src="${url("logo")}"><img src="gone.png">`])
		expect(lines).toEqual([])
		expect(errors.map(strip_ansi)).toEqual([
			"! gone.png: no such file, left as it is",
			"assets   1 local (0 uploaded, 1 already there) in 1 file",
		])
	})

	it("says why hosting was refused, and changes no file", async () => {
		const dir = project()
		const file = join(dir, "dist", "a.html")
		const html = `<img src="/images/logo.png">`
		writeFileSync(file, html)
		serve({
			"POST /v1/assets": Response.json(
				{ code: "views_not_allowed", message: "Publishing a view needs a verified domain." },
				{ status: 403 }
			),
		})
		await expect(api_command("assets", [file])).rejects.toMatchObject({
			code: "views_not_allowed",
			message: expect.stringContaining("verified sending domain or a paid plan"),
		})
		serve({ "POST /v1/assets": new Response("POST method not allowed", { status: 405 }) })
		await expect(api_command("assets", [file])).rejects.toMatchObject({
			code: "assets_unavailable",
		})
		expect(readFileSync(file, "utf8")).toBe(html)
		await expect(api_command("assets", [])).rejects.toThrow(/Usage: postboi assets/)
	})

	it("send --file hosts the local files first, and --no-assets sends the HTML as it is", async () => {
		const dir = project()
		const file = join(dir, "dist", "a.html")
		const html = `<img src="/images/hero.png">`
		writeFileSync(file, html)
		const send = ["--to", "a@b.co", "--subject", "s", "--file", file]
		const { calls, lines } = serve()

		await api_command("send", send)
		const sent = (n: number) => calls.filter((c) => c.key === "POST /v1/send")[n].body
		expect(sent(0)).toMatchObject({ html: `<img src="${url("hero")}">` })
		expect(lines[0]).toBe("assets   1 local (1 uploaded, 0 already there)")
		expect(readFileSync(file, "utf8")).toBe(html)

		const before = calls.length
		await api_command("send", [...send, "--no-assets"])
		expect(calls.slice(before).map((c) => c.key)).toEqual(["POST /v1/send"])
		expect(sent(1)).toMatchObject({ html })
	})
})
