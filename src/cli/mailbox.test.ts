import { describe, it, expect } from "vitest"
import { mkdtempSync, statSync, writeFileSync } from "node:fs"
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

	it("threads filters by folder, label, unread and search, and archive moves one", async () => {
		const { run, out, server } = harness()
		await run("new")
		const address = out[0]
		const mail = server.deliver(address, { subject: "Refund please" })
		server.deliver(address, { subject: "Lunch?" })
		expect(await run("threads", "--q", "refund", "--unread")).toBe(EXIT.ok)
		expect(server.requests.at(-1)?.query).toMatchObject({ q: "refund", unread: "true" })
		expect(out.at(-1)).toContain("Refund please")
		expect(await run("archive", mail.thread_id)).toBe(EXIT.ok)
		expect(out.at(-1)).toContain("archive")
		await run("threads", "--folder", "archive", "--json")
		expect(JSON.parse(out.at(-1)!).map((t: { subject: string }) => t.subject)).toEqual([
			"Refund please",
		])
		expect(await run("threads", "--folder", "nowhere")).toBe(EXIT.error)
	})

	it("label adds and removes by name, and labels lists them", async () => {
		const { run, out, server } = harness()
		await run("new")
		const mail = server.deliver(out[0])
		expect(await run("label", mail.thread_id, "billing", "urgent")).toBe(EXIT.ok)
		expect(server.requests.at(-1)?.body).toEqual({ add_labels: ["billing", "urgent"] })
		expect(out.at(-1)).toContain("#billing #urgent")
		await run("label", mail.thread_id, "urgent", "--remove")
		expect(server.requests.at(-1)?.body).toEqual({ remove_labels: ["urgent"] })
		await run("labels", "--json")
		expect(JSON.parse(out.at(-1)!)).toMatchObject([
			{ name: "billing", threads: 1 },
			{ name: "urgent", threads: 0 },
		])
		expect(await run("labels", "add", "vip", "--colour", "amber")).toBe(EXIT.ok)
		expect(server.requests.at(-1)?.body).toEqual({ name: "vip", colour: "amber" })
		expect(await run("labels", "add", "x", "--colour", "purple")).toBe(EXIT.error)
	})

	it("draft new, edit, send and rm", async () => {
		const { run, out, err, server } = harness()
		await run("new")
		server.claim(out[0])
		const mail = server.deliver(out[0], { subject: "Order" })
		expect(await run("draft", "new", "--in-reply-to", mail.id, "--text", "Soon")).toBe(EXIT.ok)
		const id = out.at(-1)!
		expect(id).toMatch(/^drf_/)
		expect(err.at(-1)).toContain("Nothing was sent")
		await run("draft", "edit", id, "--text", "Today")
		expect(server.requests.at(-1)).toMatchObject({ method: "PATCH", body: { text: "Today" } })
		await run("drafts")
		expect(out.at(-1)).toContain("Re: Order")
		expect(await run("draft", "send", id)).toBe(EXIT.ok)
		expect(out.at(-1)).toMatch(/^msg_/)
		await run("draft", "new", "--to", "a@x.example")
		const other = out.at(-1)!
		expect(await run("draft", "rm", other)).toBe(EXIT.ok)
		await run("drafts", "--json")
		expect(JSON.parse(out.at(-1)!)).toEqual([])
	})

	it("send and reply say plainly when review held them, and print the draft's id", async () => {
		const { run, out, err, server } = harness()
		await run("new")
		server.claim(out[0])
		server.review(out[0], "all")
		const mail = server.deliver(out[0])
		expect(await run("reply", mail.id, "--text", "On it.")).toBe(EXIT.ok)
		expect(out.at(-1)).toMatch(/^drf_/)
		expect(err.at(-1)).toContain("Held for review, not sent.")
		await run("send", "--to", "a@x.example", "--subject", "Hi", "--text", "Hi", "--json")
		expect(JSON.parse(out.at(-1)!)).toMatchObject({ status: "draft", draft: { held: true } })
	})

	it("send --attach reads the files", async () => {
		const { run, out, server } = harness()
		await run("new")
		server.claim(out[0])
		const file = join(mkdtempSync(join(tmpdir(), "postboi-attach-")), "note.txt")
		writeFileSync(file, "hello")
		await run("send", "--to", "a@x.example", "--subject", "Hi", "--text", "Hi", "--attach", file)
		expect(server.requests.at(-1)?.body?.attachments).toEqual([
			{ filename: "note.txt", content: "aGVsbG8=", type: "text/plain" },
		])
		expect(
			await run("send", "--to", "a@x.example", "--subject", "x", "--text", "x", "--attach", "/nope")
		).toBe(EXIT.error)
	})

	it("forward needs --to, and carries the original's files unless told not to", async () => {
		const { run, out, server } = harness()
		await run("new")
		server.claim(out[0])
		const mail = server.deliver(out[0])
		expect(await run("forward", mail.id)).toBe(EXIT.error)
		expect(await run("forward", mail.id, "--to", "b@x.example", "--no-attachments")).toBe(EXIT.ok)
		expect(server.requests.at(-1)?.body).toMatchObject({ to: ["b@x.example"], attachments: false })
	})

	it("review reads with any key, and changes only with the team's", async () => {
		const { run, out, err, server, env } = harness()
		await run("new")
		const address = out[0]
		server.claim(address)
		expect(await run("review")).toBe(EXIT.ok)
		expect(out.at(-1)).toBe("none")
		expect(await run("review", "all")).toBe(EXIT.error)
		expect(err.at(-1)).toContain("POSTBOI_TOKEN")
		Object.assign(env, { POSTBOI_TOKEN: TEAM_KEY })
		expect(await run("review", "new")).toBe(EXIT.ok)
		expect(server.requests.at(-1)?.auth).toBe(TEAM_KEY)
		expect(server.boxes.get(address)?.review).toBe("new")
		expect(await run("review", "loose")).toBe(EXIT.error)
	})
})
