import { describe, it, expect } from "vitest"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	parse_inbox_args,
	parse_match,
	inboxes_path,
	read_saved,
	write_saved,
	remember,
	forget,
	pick_inbox,
	format_line,
	forward_payload,
	sign_forward,
	exec_env,
	expires_in,
	inbox_command,
	EXIT,
	type SavedInbox,
} from "./inbox.js"
import { temp } from "../library/temp_inbox.js"
import { fake_tempboi } from "../testing/fake_tempboi.js"
import { receive } from "../library/webhooks/index.js"

const HOUR = 3_600_000

function entry(address: string, expires_ms: number): SavedInbox {
	return {
		address,
		token: `tb_${address.slice(0, 4)}`,
		expires: new Date(expires_ms).toISOString(),
		base: "https://tempboi.email",
	}
}

async function a_mail(
	fields: Parameters<ReturnType<typeof fake_tempboi>["deliver"]>[1] = {},
	tag?: string
) {
	const server = fake_tempboi()
	const inbox = await temp({ base: server.base, fetch: server.fetch })
	server.deliver(tag ? inbox.tag(tag) : inbox.address, fields)
	return inbox.wait({ timeout: 100 })
}

describe("parse_inbox_args", () => {
	it("splits the sub-command, positionals, value flags and switches", () => {
		expect(
			parse_inbox_args(["wait", "a@b.c", "--code", "--timeout", "30", "--subject=Verify"])
		).toEqual({
			sub: "wait",
			positional: ["a@b.c"],
			flags: { code: true, timeout: "30", subject: "Verify" },
		})
		expect(parse_inbox_args([])).toEqual({ sub: undefined, positional: [], flags: {} })
		expect(() => parse_inbox_args(["new", "--ttl"])).toThrow(/--ttl needs a value/)
	})

	it("reads /…/flags as a RegExp and anything else as a substring", () => {
		expect(parse_match("/^Your code \\d+/i")).toEqual(/^Your code \d+/i)
		expect(parse_match("Verify")).toBe("Verify")
		expect(parse_match(undefined)).toBeUndefined()
	})
})

describe("inboxes.json", () => {
	it("lives under XDG_CONFIG_HOME, else ~/.config", () => {
		expect(inboxes_path({ XDG_CONFIG_HOME: "/x" })).toBe("/x/postboi/inboxes.json")
		expect(inboxes_path({ HOME: "/home/ada" })).toBe("/home/ada/.config/postboi/inboxes.json")
	})

	it("remembers most recent first, drops expired entries, and keeps the file private", () => {
		const path = join(mkdtempSync(join(tmpdir(), "postboi-inbox-")), "postboi", "inboxes.json")
		const now = Date.now()
		expect(read_saved(path)).toEqual([])
		write_saved(path, [entry("old@t.e", now - 1000), entry("keep@t.e", now + HOUR)])
		expect(read_saved(path, now).map((e) => e.address)).toEqual(["keep@t.e"])
		remember(path, entry("new@t.e", now + HOUR), now)
		expect(read_saved(path, now).map((e) => e.address)).toEqual(["new@t.e", "keep@t.e"])
		remember(path, entry("keep@t.e", now + 2 * HOUR), now)
		expect(read_saved(path, now).map((e) => e.address)).toEqual(["keep@t.e", "new@t.e"])
		forget(path, "keep@t.e", now)
		expect(read_saved(path, now).map((e) => e.address)).toEqual(["new@t.e"])
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
		writeFileSync(path, "not json")
		expect(read_saved(path)).toEqual([])
	})
})

describe("pick_inbox", () => {
	const saved = [entry("recent@t.e", Date.now() + HOUR), entry("older@t.e", Date.now() + HOUR)]

	it("takes the env pair first, then a named address, then the most recent", () => {
		const env = { POSTBOI_INBOX: "env@t.e", POSTBOI_INBOX_TOKEN: "tb_env" }
		expect(pick_inbox(saved, env)).toMatchObject({ address: "env@t.e", token: "tb_env" })
		expect(pick_inbox(saved, env, "older@t.e")).toMatchObject({ address: "older@t.e" })
		expect(pick_inbox(saved, {}, "older+run-1@t.e")).toMatchObject({ address: "older@t.e" })
		expect(pick_inbox(saved, {})).toMatchObject({ address: "recent@t.e" })
	})

	it("says why when there's nothing to read", () => {
		expect(pick_inbox([], {})).toMatchObject({ code: "no_inbox" })
		expect(pick_inbox(saved, {}, "stranger@t.e")).toMatchObject({ code: "unknown_inbox" })
	})
})

describe("formatting", () => {
	it("puts a mail on one line with its code and link", async () => {
		const mail = await a_mail(
			{
				from: "no-reply@acme.com",
				from_name: "Acme",
				subject: "Verify",
				code: "482913",
				link: "https://acme.com/v",
			},
			"signup"
		)
		const line = format_line(mail)
		expect(line).toMatch(
			/^\d\d:\d\d:\d\d · Acme <no-reply@acme\.com> · \+signup · Verify · 482913 · https:\/\/acme\.com\/v$/
		)
	})

	it("says how long is left", () => {
		const now = Date.now()
		expect(expires_in(new Date(now + 42 * 60_000), now)).toBe("in 42m")
		expect(expires_in(new Date(now + 2 * HOUR), now)).toBe("in 2h")
		expect(expires_in(new Date(now + 185 * 60_000), now)).toBe("in 3h 5m")
	})

	it("hands --exec the fields as env vars", async () => {
		const mail = await a_mail({ subject: "Hi", code: "1234" })
		expect(exec_env(mail)).toMatchObject({
			SUBJECT: "Hi",
			CODE: "1234",
			LINK: "",
			ID: mail.id,
			FROM: mail.from,
		})
	})
})

describe("--forward", () => {
	it("posts the shape of Postboi's email.received webhook, signed so a handler can verify it", async () => {
		const mail = await a_mail(
			{ from: "ada@example.com", subject: "Re: hello", text: "Thanks", html: "<p>Thanks</p>" },
			"run-1"
		)
		const payload = forward_payload(mail, new Date("2026-09-24T10:00:00Z"))
		expect(payload).toMatchObject({
			type: "email.received",
			created_at: "2026-09-24T10:00:00.000Z",
			data: {
				from: "ada@example.com",
				to: mail.to,
				subject: "Re: hello",
				text: "Thanks",
				html: "<p>Thanks</p>",
				tags: ["run-1"],
			},
		})

		const secret = "whsec_" + Buffer.from("a-test-secret-of-some-length").toString("base64")
		const body = JSON.stringify(payload)
		const headers = await sign_forward(body, secret, `whmsg_${mail.id}`)
		const events = await receive(
			new Request("http://localhost/hook", { method: "POST", headers, body }),
			{
				provider: "postboi",
				secret,
			}
		)
		expect(events[0]).toMatchObject({
			type: "received",
			email: "ada@example.com",
			subject: "Re: hello",
		})
		expect(events[0].body).toEqual({ html: "<p>Thanks</p>", text: "Thanks" })
	})
})

describe("inbox_command", () => {
	function run_env() {
		const server = fake_tempboi()
		const dir = mkdtempSync(join(tmpdir(), "postboi-inbox-"))
		const env = { XDG_CONFIG_HOME: dir, POSTBOI_INBOX_URL: server.base }
		const out: Array<string> = []
		const err: Array<string> = []
		const run = (...args: Array<string>) =>
			inbox_command(args, {
				env,
				fetch: server.fetch,
				out: (l) => out.push(l),
				err: (l) => err.push(l),
			})
		return { server, env, out, err, run, path: join(dir, "postboi", "inboxes.json") }
	}

	it("makes an inbox, remembers it, and waits for a code with no token of Postboi's", async () => {
		const { server, out, run, path } = run_env()
		expect(await run()).toBe(EXIT.ok)
		const address = out[0]
		expect(address).toMatch(/@tempboi\.email$/)
		expect(JSON.parse(readFileSync(path, "utf8"))[0]).toMatchObject({ address, base: server.base })

		setTimeout(() => server.deliver(address, { subject: "Your code", code: "777111" }), 10)
		expect(await run("wait", "--code", "--timeout", "5")).toBe(EXIT.ok)
		expect(out.at(-1)).toBe("777111")
	})

	it("prints help for --help rather than making an inbox", async () => {
		const { server, out, run, path } = run_env()
		expect(await run("--help")).toBe(EXIT.ok)
		expect(out.join("\n")).toContain("inbox wait")
		expect(server.requests.length).toBe(0)
		expect(() => readFileSync(path, "utf8")).toThrow()
	})

	it("prints an eval-able --env line", async () => {
		const { out, run } = run_env()
		await run("new", "--env", "--name", "ci")
		expect(out[0]).toMatch(
			/^export POSTBOI_INBOX=ci-\S+@tempboi\.email POSTBOI_INBOX_TOKEN=tb_\S+ POSTBOI_INBOX_URL=/
		)
	})

	it("exits 2 on a timeout and 3 when the mail has no code", async () => {
		const { server, out, err, run } = run_env()
		await run("new")
		expect(await run("wait", "--timeout", "0.05", "--json")).toBe(EXIT.timeout)
		expect(JSON.parse(err.at(-1)!)).toMatchObject({ error: { code: "timeout" } })
		server.deliver(out[0], { subject: "Welcome" })
		expect(await run("wait", "--code")).toBe(EXIT.missing)
		expect(await run("wait", "--json")).toBe(EXIT.ok)
		expect(JSON.parse(out.at(-1)!)).toMatchObject({ subject: "Welcome", from: "hello@example.com" })
	})

	it("fails with a code, not a crash, when there's no inbox", async () => {
		const { err, run } = run_env()
		expect(await run("wait", "--json")).toBe(EXIT.error)
		expect(JSON.parse(err[0])).toMatchObject({ error: { code: "no_inbox" } })
	})

	it("reads the latest mail, lists, extends and removes", async () => {
		const { server, out, run, path } = run_env()
		await run("new")
		const address = out[0]
		server.deliver(address, { subject: "Hello", text: "Body text" })
		await run("read")
		expect(out).toContain("Body text")
		await run("ls", "--json")
		expect(JSON.parse(out.at(-1)!)[0]).toEqual(
			expect.not.objectContaining({ token: expect.anything() })
		)
		expect(await run("extend", "3h")).toBe(EXIT.ok)
		expect(new Date(JSON.parse(readFileSync(path, "utf8"))[0].expires).getTime()).toBeGreaterThan(
			Date.now() + 2 * HOUR
		)
		expect(await run("rm")).toBe(EXIT.ok)
		expect(server.inboxes.has(address)).toBe(false)
		expect(read_saved(path)).toEqual([])
	})

	it("watches as NDJSON until stopped", async () => {
		const { server, out, env, run } = run_env()
		await run("new")
		const address = out[0]
		const controller = new AbortController()
		const lines: Array<string> = []
		const watching = inbox_command(["watch", "--json"], {
			env,
			fetch: server.fetch,
			out: (line) => {
				lines.push(line)
				if (lines.length === 2) controller.abort()
			},
			err: () => {},
			signal: controller.signal,
		})
		setTimeout(() => {
			server.deliver(address, { subject: "One" })
			server.deliver(address, { subject: "Two" })
		}, 20)
		expect(await watching).toBe(EXIT.ok)
		expect(lines.map((l) => JSON.parse(l).subject)).toEqual(["One", "Two"])
	})
})
