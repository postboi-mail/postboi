import { describe, it, expect } from "vitest"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	mailbox_command,
	mailboxes_path,
	parse_mailbox_args,
	pick_mailbox,
	read_saved,
	remember,
} from "./mailbox.js"
import { EXIT } from "./inbox.js"
import { fake_agentboi, TEAM_KEY } from "../testing/fake_agentboi.js"

function harness(extra: Record<string, string> = {}) {
	const server = fake_agentboi()
	const home = mkdtempSync(join(tmpdir(), "postboi-mailbox-"))
	const env = { XDG_CONFIG_HOME: home, POSTBOI_MAILBOX_URL: server.base, ...extra }
	const out: Array<string> = []
	const err: Array<string> = []
	const run = (...args: Array<string>) =>
		mailbox_command(args, {
			env,
			fetch: server.fetch,
			out: (line) => out.push(line),
			err: (line) => err.push(line),
		})
	return { server, env, out, err, run, path: mailboxes_path(env) }
}

describe("arguments", () => {
	it("reads value flags and switches apart", () => {
		expect(parse_mailbox_args(["reply", "in_1", "--text", "Hi", "--json"])).toEqual({
			sub: "reply",
			positional: ["in_1"],
			flags: { text: "Hi", json: true },
		})
	})
})

describe("which mailbox a command means", () => {
	const saved = [
		{ address: "a-0001@agentboi.email", key: "mb_a", base: "https://agentboi.email" },
		{ address: "b-0002@agentboi.email", key: "mb_b", base: "https://agentboi.email" },
	]

	it("POSTBOI_MAILBOX_KEY wins, then a named one, then the most recent", () => {
		expect(pick_mailbox(saved, { POSTBOI_MAILBOX_KEY: "mb_env" })).toMatchObject({ key: "mb_env" })
		expect(pick_mailbox(saved, {}, "b-0002+tag@agentboi.email")).toMatchObject({ key: "mb_b" })
		expect(pick_mailbox(saved, {})).toMatchObject({ key: "mb_a" })
	})

	it("says how to make one when there is none", () => {
		expect(pick_mailbox([], {})).toMatchObject({ code: "no_mailbox" })
	})
})

describe("postboi mailbox", () => {
	it("new makes one, prints its address, says where to claim it, and keeps the key 0600", async () => {
		const { run, out, err, path } = harness()
		expect(await run("new", "--address", "orders")).toBe(EXIT.ok)
		expect(out[0]).toMatch(/^orders-\d{4}@agentboi\.email$/)
		expect(err.join("\n")).toContain("/claim/")
		expect(read_saved(path)[0].key).toMatch(/^mb_/)
		expect(statSync(path).mode & 0o777).toBe(0o600)
	})

	it("new with POSTBOI_TOKEN makes the team's", async () => {
		const { run, err, server } = harness({ POSTBOI_TOKEN: TEAM_KEY })
		await run("new")
		expect(server.requests[0].auth).toBe(TEAM_KEY)
		expect(err.join("\n")).not.toContain("claim")
	})

	it("new --env prints the export line", async () => {
		const { run, out, server } = harness()
		await run("new", "--env")
		expect(out[0]).toMatch(
			new RegExp(`^export POSTBOI_MAILBOX_KEY=mb_\\S+ POSTBOI_MAILBOX_URL=${server.base}$`)
		)
	})

	it("wait --code prints only the code, and exits 3 when there isn't one", async () => {
		const { run, out, server } = harness()
		await run("new")
		const address = out[0]
		server.deliver(address, { subject: "Your code", code: "482913" })
		expect(await run("wait", "--code")).toBe(EXIT.ok)
		expect(out.at(-1)).toBe("482913")
		server.deliver(address, { subject: "No code here" })
		expect(await run("wait", "--subject", "no code", "--code")).toBe(EXIT.missing)
	})

	it("wait times out with exit 2", async () => {
		const { run } = harness()
		await run("new")
		expect(await run("wait", "--timeout", "0.05")).toBe(EXIT.timeout)
	})

	it("read latest prints what they wrote and who is talking", async () => {
		const { run, out, server } = harness()
		await run("new")
		server.deliver(out[0], { subject: "Book Thursday", trust: "owner", reply_text: "Book it." })
		await run("read")
		const text = out.join("\n")
		expect(text).toContain("owner")
		expect(text).toContain("Book it.")
	})

	it("reply is refused while unclaimed, and sends once claimed", async () => {
		const { run, out, err, server } = harness()
		await run("new")
		const address = out[0]
		const mail = server.deliver(address)
		expect(await run("reply", mail.id, "--text", "On it.")).toBe(EXIT.error)
		expect(err.at(-1)).toContain("unclaimed")
		server.claim(address)
		expect(await run("reply", mail.id, "--text", "On it.")).toBe(EXIT.ok)
		expect(out.at(-1)).toMatch(/^msg_/)
	})

	it("send needs a recipient and a subject", async () => {
		const { run, out, server } = harness()
		await run("new")
		server.claim(out[0])
		expect(await run("send", "--text", "Hi")).toBe(EXIT.error)
		expect(
			await run("send", "--to", "a@x.example,b@x.example", "--subject", "Hi", "--text", "Hi")
		).toBe(EXIT.ok)
		expect(server.requests.at(-1)?.body).toMatchObject({ to: ["a@x.example", "b@x.example"] })
	})

	it("key rotates, and the new key is the one remembered", async () => {
		const { run, out, path } = harness()
		await run("new")
		const before = read_saved(path)[0].key
		await run("key")
		expect(out.at(-1)).not.toBe(before)
		expect(read_saved(path)[0].key).toBe(out.at(-1))
	})

	it("ls lists without keys in --json, and rm forgets", async () => {
		const { run, out, path } = harness()
		await run("new")
		await run("ls", "--json")
		expect(out.at(-1)).not.toContain("mb_")
		await run("rm")
		expect(read_saved(path)).toEqual([])
	})

	it("with no subcommand it prints its help rather than making anything", async () => {
		const { run, out, server } = harness()
		expect(await run()).toBe(EXIT.ok)
		expect(out.join("\n")).toContain("mailbox new")
		expect(server.requests).toEqual([])
	})

	it("an unknown subcommand says what there is", async () => {
		const { run, err } = harness()
		expect(await run("frobnicate")).toBe(EXIT.error)
		expect(err.at(-1)).toContain("Try new, watch")
	})

	it("remember keeps the most recent first", () => {
		const { path } = harness()
		remember(path, { address: "a@agentboi.email", key: "mb_a", base: "x" })
		remember(path, { address: "b@agentboi.email", key: "mb_b", base: "x" })
		expect(read_saved(path).map((e) => e.address)).toEqual(["b@agentboi.email", "a@agentboi.email"])
	})
})
