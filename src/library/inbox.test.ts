import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { create_inbox_store, inbox_middleware, best_rendition } from "./inbox_server.js"
import { resolve_inbox, set_inbox_port, INBOX_PATH } from "./inbox.js"
import { inbox_ui } from "./inbox_ui.js"
import { inbox_sink } from "./channel_inbox.js"
import Mock from "./mock.js"
import MockSms from "./sms/mock.js"
import MockChat from "./chat/mock.js"

/** Stand the inbox up on a real port, so the delivery path is exercised end to end. */
async function start_inbox(): Promise<{
	port: number
	store: ReturnType<typeof create_inbox_store>
	stop(): Promise<void>
}> {
	const store = create_inbox_store()
	const middleware = inbox_middleware(store)
	const server: Server = createServer((request, response) => {
		middleware(request, response, () => {
			response.statusCode = 404
			response.end("nope")
		})
	})
	const port = await new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			resolve(typeof address === "object" && address ? address.port : 0)
		})
	})
	return {
		port,
		store,
		stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

const message = {
	to: [{ address: "ada@example.com" }],
	from: { address: "no-reply@example.com" },
	subject: "Hi",
	html: "<p>Hello</p>",
	attachments: [],
}

describe("inbox store", () => {
	it("stores newest first and hands back an id", () => {
		const store = create_inbox_store()
		const first = store.add({ ...message, subject: "one" })
		const second = store.add({ ...message, subject: "two" })
		expect(first.id).not.toBe(second.id)
		expect(store.list().map((m) => m.subject)).toEqual(["two", "one"])
		expect(store.get(first.id)?.subject).toBe("one")
	})

	it("drops the oldest past the limit", () => {
		const store = create_inbox_store(2)
		store.add({ ...message, subject: "one" })
		store.add({ ...message, subject: "two" })
		store.add({ ...message, subject: "three" })
		expect(store.list().map((m) => m.subject)).toEqual(["three", "two"])
	})

	it("notifies subscribers on add and clear, and stops after unsubscribe", () => {
		const store = create_inbox_store()
		const listener = vi.fn()
		const off = store.subscribe(listener)
		store.add(message)
		store.clear()
		expect(listener).toHaveBeenCalledTimes(2)
		off()
		store.add(message)
		expect(listener).toHaveBeenCalledTimes(2)
	})
})

describe("inbox middleware", () => {
	let inbox: Awaited<ReturnType<typeof start_inbox>>

	beforeEach(async () => {
		inbox = await start_inbox()
	})
	afterEach(() => inbox.stop())

	it("passes non-inbox requests through to the app", async () => {
		const response = await fetch(`http://127.0.0.1:${inbox.port}/some/app/route`)
		expect(response.status).toBe(404)
		expect(await response.text()).toBe("nope")
	})

	it("does not swallow a route that merely starts with the same characters", async () => {
		const response = await fetch(`http://127.0.0.1:${inbox.port}${INBOX_PATH}-elsewhere`)
		expect(await response.text()).toBe("nope")
	})

	it("serves the UI", async () => {
		const response = await fetch(`http://127.0.0.1:${inbox.port}${INBOX_PATH}`)
		expect(response.headers.get("content-type")).toContain("text/html")
		expect(await response.text()).toContain("Your Local Mailbox")
	})

	it("ships sound on, and a way to turn it off", async () => {
		const html = await (await fetch(`http://127.0.0.1:${inbox.port}${INBOX_PATH}`)).text()
		// A "Welcome!" in a shared office is the opposite of useful, so the toggle is not
		// decoration.
		expect(html).toContain('data-sounds="on"')
		expect(html).toContain('id="t-sound"')
	})

	it("starts with each piece turned off when the server says so", async () => {
		const html = inbox_ui({ sounds: false, intro: false })
		expect(html).toContain('data-sounds="off"')
		expect(html).toContain('data-intro="off"')
		// The control stays — the option sets the starting state, it doesn't remove the toggle.
		expect(html).toContain('id="t-sound"')
	})

	it("gives both windows the controls a window manager needs", async () => {
		const html = inbox_ui()
		// Asserted as whole controls rather than by counting attributes: the inline script
		// contains the same selector strings, so a count would drift with the JS.
		expect(html).toContain('aria-label="Minimize" data-act="min"')
		expect(html).toContain('aria-label="Maximize" data-act="max"')
		expect(html).toContain('aria-label="Close" data-act="close" id="reader-close"')
		// The mailbox closes too, and the Start menu is how it comes back.
		expect(html).toContain('id="m-mailbox"')
		// Resize handles on the mailbox, the reader, the messenger and the app frame itself —
		// the reading pane is only ever big enough because you can make it bigger.
		expect(html.match(/class="grip"/g)).toHaveLength(4)
	})

	it("is branded Postboi, not the client it's dressed as", async () => {
		const html = inbox_ui()
		expect(html).toContain("Postboi Local")
		expect(html).not.toContain("America Online")
		expect(html).not.toMatch(/>AOL\.?</)
	})

	it("opens on Sign On, with nothing to fill in", async () => {
		const html = inbox_ui()
		// The click on SIGN ON is what lets the modem be heard: browsers refuse audio until
		// the page has been interacted with, so a cold load could never play it.
		expect(html).toContain('id="so-go"')
		expect(html).toContain('id="so-help"')
		// Credentials are set dressing — there is nothing to authenticate against.
		expect(html).toMatch(/<select id="so-name" disabled>/)
		expect(html).toMatch(/<input id="so-pass" type="password" value="[^"]*" disabled>/)
		expect(html).toMatch(/<select id="so-loc" disabled>/)
		expect(html).not.toContain("SETUP")
	})

	it("behaves like a Windows list, and a Windows app", async () => {
		const html = inbox_ui()
		// Single click selects, double click opens — the convention AOL followed too.
		expect(html).toContain("tr.ondblclick")
		// XP's own arrow everywhere; native apps don't show a hand over buttons.
		expect(html).not.toContain("cursor: pointer")
		// The app window has working controls and a desktop to reveal.
		expect(html).toContain('data-app="min"')
		expect(html).toContain('data-app="max"')
		expect(html).toContain('data-app="close"')
		expect(html).toContain('id="app-task"')
		expect(html).toContain('id="menu-file"')
	})

	it("puts the app on the desktop, and keeps the crash for turning the machine off", async () => {
		const html = inbox_ui()
		// Closing the app leaves a desktop, so there has to be something on it to open it again.
		expect(html).toContain('id="sc-app"')
		expect(html).toContain('id="m-shutdown"')
		// The stop error is reachable from Turn Off Computer and nowhere else; the old
		// "it's now safe" screen went with it.
		expect(html).toContain('id="bsod"')
		expect(html).not.toContain('id="shutdown"')
		expect(html).toContain("app_close()")
	})

	it("files mail into an outbox, and a folder for what hasn't gone yet", async () => {
		const html = inbox_ui()
		expect(html).toContain('id="f-outbox"')
		expect(html).toContain('id="f-sent"')
		expect(html).toContain('id="f-scheduled"')
		expect(html).toContain('id="f-deleted"')
		expect(html).toContain(">Outbox<")
		// These are messages on their way out, not mail that arrived.
		expect(html).not.toMatch(/>(New|Old|Sent) Mail</)
	})

	it("chimes for the first message, not just the second", async () => {
		const html = inbox_ui()
		// The old guard was "seen > 0", which on an inbox that starts empty is false exactly when
		// the next arrival is the first one worth announcing.
		expect(html).toContain("loaded && messages.length > seen")
		expect(html).not.toContain("seen > 0")
	})

	it("leaves nothing in the shell dead while the sign-on is up", async () => {
		const html = inbox_ui()
		// The sign-on is a curtain over an inbox that is already live. Anything in the Start menu
		// or the taskbar draws it back rather than looking clickable and doing nothing.
		expect(html).toContain("function ensure_signed_on()")
		expect(html).toMatch(/\$\("m-mailbox"\)\.onclick = function \(\) \{ ensure_signed_on\(\)/)
	})

	it("defaults every piece on", async () => {
		const html = inbox_ui()
		expect(html).toContain('data-sounds="on"')
		expect(html).toContain('data-intro="on"')
	})

	it("serves each sound as playable audio", async () => {
		for (const name of ["welcome", "mail", "goodbye"]) {
			const response = await fetch(`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/sounds/${name}`)
			expect(response.status, name).toBe(200)
			expect(response.headers.get("content-type")).toBe("audio/wav")
			const bytes = new Uint8Array(await response.arrayBuffer())
			// Decoded back to real RIFF/WAVE, not left as base64 text.
			expect(String.fromCharCode(...bytes.slice(0, 4)), name).toBe("RIFF")
			expect(String.fromCharCode(...bytes.slice(8, 12)), name).toBe("WAVE")
		}
	})

	it("serves each sign-on panel as a PNG", async () => {
		for (const name of ["logo", "locating", "connecting", "intercepting"]) {
			const response = await fetch(`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/art/${name}`)
			expect(response.status, name).toBe(200)
			expect(response.headers.get("content-type")).toBe("image/png")
			const bytes = new Uint8Array(await response.arrayBuffer())
			// Decoded back to a real PNG signature, not left as base64 text.
			expect(Array.from(bytes.slice(0, 4)), name).toEqual([0x89, 0x50, 0x4e, 0x47])
		}
	})

	it("serves each desktop asset with its own type", async () => {
		for (const [name, type] of [
			["wallpaper", "image/jpeg"],
			["start", "image/png"],
			["icon", "image/svg+xml"],
			["avatar", "image/svg+xml"],
		]) {
			const response = await fetch(
				`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/desktop/${name}`
			)
			expect(response.status, name).toBe(200)
			expect(response.headers.get("content-type"), name).toBe(type)
			expect(response.headers.get("accept-ranges"), name).toBe("bytes")
			expect((await response.arrayBuffer()).byteLength, name).toBeGreaterThan(1000)
		}
	})

	it("revalidates assets rather than pinning them for a day", async () => {
		// These sit at fixed paths but their bytes change whenever the package does. Cached
		// outright, an upgrade leaves last week's artwork on screen against this week's UI with
		// no way for the browser to find out.
		for (const path of ["/api/art/locating", "/api/sounds/welcome", "/api/desktop/start"]) {
			const url = `http://127.0.0.1:${inbox.port}${INBOX_PATH}${path}`
			const fresh = await fetch(url)
			expect(fresh.headers.get("cache-control"), path).toBe("no-cache")
			const tag = fresh.headers.get("etag")
			expect(tag, path).toBeTruthy()
			await fresh.arrayBuffer()

			const again = await fetch(url, { headers: { "if-none-match": tag as string } })
			expect(again.status, path).toBe(304)
			// A tag from some earlier build has to come back with the new bytes.
			const stale = await fetch(url, { headers: { "if-none-match": '"nope-nope"' } })
			expect(stale.status, path).toBe(200)
			expect((await stale.arrayBuffer()).byteLength, path).toBeGreaterThan(0)
		}
	})

	it("answers a range request with just that range", async () => {
		const url = `http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/desktop/wallpaper`
		const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
		// A video element asks for ranges rather than the whole file, and some browsers refuse a
		// source that answers with the entire body.
		const response = await fetch(url, { headers: { range: "bytes=10-19" } })
		expect(response.status).toBe(206)
		expect(response.headers.get("content-range")).toBe(`bytes 10-19/${whole.length}`)
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
			Array.from(whole.slice(10, 20))
		)
	})

	it("picks the widest, best rendition out of a master playlist", () => {
		// Mux publishes two at the source resolution, and which of those you take is the whole
		// difference between a sharp clip and the mush that made it worth streaming.
		const manifest = [
			"#EXTM3U",
			"#EXT-X-STREAM-INF:BANDWIDTH=3241700,RESOLUTION=1094x720",
			"https://example.test/720.m3u8",
			"#EXT-X-STREAM-INF:BANDWIDTH=3721300,RESOLUTION=1168x768",
			"https://example.test/768-thin.m3u8",
			"#EXT-X-STREAM-INF:BANDWIDTH=1071400,RESOLUTION=548x360",
			"https://example.test/360.m3u8",
			"#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1,BANDWIDTH=4962100,RESOLUTION=1168x768",
			"https://example.test/768-fat.m3u8",
		].join("\n")
		expect(best_rendition(manifest)).toBe("https://example.test/768-fat.m3u8")
		expect(best_rendition("#EXTM3U")).toBeUndefined()
	})

	it("404s a sound that doesn't exist", async () => {
		const response = await fetch(`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/sounds/nope`)
		expect(response.status).toBe(404)
	})

	it("accepts, lists and clears messages", async () => {
		const posted = await fetch(`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages`, {
			method: "POST",
			body: JSON.stringify({ ...message, subject: "Captured" }),
		})
		expect(posted.status).toBe(201)

		const listed = await fetch(`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages`)
		const { messages } = (await listed.json()) as { messages: Array<{ subject: string }> }
		expect(messages).toHaveLength(1)
		expect(messages[0].subject).toBe("Captured")

		await fetch(`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages`, { method: "DELETE" })
		expect(inbox.store.list()).toHaveLength(0)
	})

	it("serves a message body as its own document", async () => {
		const stored = inbox.store.add({ ...message, html: "<p>Body here</p>" })
		const response = await fetch(
			`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages/${stored.id}/body`
		)
		const body = await response.text()
		// The mail is served intact. The only addition is a cursor rule, so the pointer doesn't
		// revert to the host OS's the moment it crosses into the frame.
		expect(body.endsWith("<p>Body here</p>")).toBe(true)
		expect(body.replace(/^<style>.*?<\/style>/, "")).toBe("<p>Body here</p>")
	})

	it("escapes a text-only body rather than rendering it as markup", async () => {
		const stored = inbox.store.add({ ...message, html: undefined, text: "<script>x</script>" })
		const response = await fetch(
			`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages/${stored.id}/body`
		)
		const text = await response.text()
		expect(text).toContain("&lt;script&gt;")
		expect(text).not.toContain("<script>x")
	})

	it("serves attachments decoded", async () => {
		const stored = inbox.store.add({
			...message,
			attachments: [
				{
					name: "note.txt",
					mime_type: "text/plain",
					content: Buffer.from("hi there").toString("base64"),
				},
			],
		})
		const response = await fetch(
			`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages/${stored.id}/attachments/0`
		)
		expect(await response.text()).toBe("hi there")
		expect(response.headers.get("content-disposition")).toContain("note.txt")
	})

	it("404s an unknown message", async () => {
		const response = await fetch(
			`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages/nope/body`
		)
		expect(response.status).toBe(404)
	})
})

describe("inbox discovery", () => {
	beforeEach(() => {
		set_inbox_port(null as unknown as number)
		delete process.env.POSTBOI_INBOX
	})
	afterEach(() => {
		delete process.env.POSTBOI_INBOX
	})

	it("uses an injected port", async () => {
		set_inbox_port(4321)
		const inbox = await resolve_inbox()
		expect(inbox?.url).toBe(`http://localhost:4321${INBOX_PATH}`)
	})

	it("lets POSTBOI_INBOX override the injected port", async () => {
		set_inbox_port(4321)
		process.env.POSTBOI_INBOX = "9999"
		expect((await resolve_inbox())?.url).toContain("9999")
	})

	it("lets POSTBOI_INBOX=off switch it off entirely", async () => {
		set_inbox_port(4321)
		process.env.POSTBOI_INBOX = "off"
		expect(await resolve_inbox()).toBeNull()
	})

	it("ignores a nonsense port", async () => {
		process.env.POSTBOI_INBOX = "banana"
		expect(await resolve_inbox()).toBeNull()
	})
})

describe("delivery", () => {
	afterEach(() => set_inbox_port(null as unknown as number))

	it("delivers a captured send to a running inbox", async () => {
		const inbox = await start_inbox()
		set_inbox_port(inbox.port)
		const resolved = await resolve_inbox()

		const mail = new Mock({ sink: resolved!.deliver, default: { from: "dev@example.com" } })
		await mail.send({ to: "ada@example.com", subject: "Captured", body: "<p>Hello</p>" })

		expect(inbox.store.list()).toHaveLength(1)
		expect(inbox.store.list()[0].subject).toBe("Captured")
		await inbox.stop()
	})

	it("builds an https url when the dev server is serving over https", async () => {
		set_inbox_port(5173, true)
		expect((await resolve_inbox())?.url).toBe(`https://localhost:5173${INBOX_PATH}`)
		set_inbox_port(5173, false)
		expect((await resolve_inbox())?.url).toBe(`http://localhost:5173${INBOX_PATH}`)
	})

	it("takes a whole url in POSTBOI_INBOX, not only a port", async () => {
		// An https dev server is exactly the case where you might have to say so by hand.
		process.env.POSTBOI_INBOX = "https://localhost:5173"
		expect((await resolve_inbox())?.url).toBe(`https://localhost:5173${INBOX_PATH}`)
		delete process.env.POSTBOI_INBOX
	})

	it("carries a schedule all the way to the inbox", async () => {
		const inbox = await start_inbox()
		set_inbox_port(inbox.port)
		const resolved = await resolve_inbox()

		const mail = new Mock({ sink: resolved!.deliver, default: { from: "dev@example.com" } })
		const when = new Date(Date.now() + 86_400_000)
		await mail.send({
			to: "ada@example.com",
			subject: "Next week",
			body: "<p>Later</p>",
			scheduled_at: when,
		})

		// Without this a mail queued for next Tuesday is indistinguishable in the inbox from one
		// that has already gone, which is the one thing you open the inbox to check.
		expect(mail.sent[0].scheduled_at).toEqual(when)
		expect(inbox.store.list()[0].scheduled_at).toBe(when.toISOString())
		await inbox.stop()
	})

	it("shows a cancelled scheduled send as cancelled, not as still going out", async () => {
		const inbox = await start_inbox()
		set_inbox_port(inbox.port)
		const resolved = await resolve_inbox()

		const mail = new Mock({
			sink: resolved!.deliver,
			on_cancel: resolved!.cancel,
			default: { from: "dev@example.com" },
		})
		const { id } = await mail.send({
			to: "ada@example.com",
			subject: "Reminder",
			body: "<p>See you tomorrow.</p>",
			scheduled_at: new Date(Date.now() + 86_400_000),
		})
		expect(inbox.store.list()[0].send_id).toBe(id)
		expect(inbox.store.list()[0].cancelled_at).toBeUndefined()

		await mail.cancel(id)
		// The id the caller holds is the mock's, not the inbox's own numbering — matching them up
		// is the whole reason the send id is captured alongside the message.
		expect(inbox.store.list()[0].cancelled_at).toEqual(expect.any(String))
		expect(mail.canceled).toEqual([id])
		await inbox.stop()
	})

	it("survives cancelling a send the inbox never saw", async () => {
		const inbox = await start_inbox()
		set_inbox_port(inbox.port)
		const resolved = await resolve_inbox()
		// An id from before this inbox started. Nothing to mark, and nothing to blow up over.
		expect(await resolved!.cancel("mock-999")).toBe(false)
		expect(inbox.store.cancel("mock-999")).toBe(false)
		await inbox.stop()
	})

	it("prints the mail instead when the inbox has gone away", async () => {
		const inbox = await start_inbox()
		set_inbox_port(inbox.port)
		const resolved = await resolve_inbox()
		await inbox.stop()

		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const mail = new Mock({ sink: resolved!.deliver, default: { from: "dev@example.com" } })
		await mail.send({ to: "ada@example.com", subject: "Orphaned", body: "<p>Hello</p>" })

		// Never a silent success: an unreachable inbox falls back to the console, and the
		// message is still captured for assertions.
		expect(log).toHaveBeenCalled()
		expect(String(log.mock.calls[0][0])).toContain("Orphaned")
		expect(mail.sent).toHaveLength(1)
		log.mockRestore()
	})
})

/** The channel sinks post fire-and-forget, so the store fills a beat after send resolves. */
async function until(predicate: () => boolean, ms = 1500): Promise<void> {
	const start = Date.now()
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for the inbox")
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

describe("channel captures", () => {
	afterEach(() => set_inbox_port(null as unknown as number))

	it("lands a dev-intercepted text in the inbox, normalised and tagged", async () => {
		const inbox = await start_inbox()
		set_inbox_port(inbox.port)
		const log = vi.spyOn(console, "log").mockImplementation(() => {})

		const text = new MockSms({ log: true, sink: inbox_sink("sms"), default: { country: "GB" } })
		await text.send({ to: "07788 223344", message: "Your code is 4291" })
		await until(() => inbox.store.list().length === 1)

		const stored = inbox.store.list()[0]
		expect(stored.channel).toBe("sms")
		expect(stored.to).toEqual([{ address: "+447788223344" }])
		expect(stored.text).toBe("Your code is 4291")
		expect(stored.meta?.[0][0]).toBe("Segments")
		// Taken by the inbox: the console gets a pointer, not the text itself.
		await until(() => log.mock.calls.some((args) => String(args[0]).includes("dev inbox")))
		expect(log.mock.calls.some((args) => String(args[0]).includes("Your code is 4291"))).toBe(false)
		log.mockRestore()
		await inbox.stop()
	})

	it("falls back to the console when no inbox is listening", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const text = new MockSms({ log: true, sink: inbox_sink("sms"), default: { country: "GB" } })
		await text.send({ to: "07788 223344", message: "Fallback text" })
		await until(() => log.mock.calls.some((args) => String(args[0]).includes("Fallback text")))
		expect(log.mock.calls.some((args) => String(args[0]).includes("Fallback text"))).toBe(true)
		log.mockRestore()
	})

	it("keeps a chat capture's title alongside its body", async () => {
		const inbox = await start_inbox()
		set_inbox_port(inbox.port)

		const chat = new MockChat({ sink: inbox_sink("chat") })
		await chat.send({ message: "Deploy finished in 42s", title: "Deploy" })
		await until(() => inbox.store.list().length === 1)

		expect(inbox.store.list()[0]).toMatchObject({
			channel: "chat",
			subject: "Deploy",
			text: "Deploy finished in 42s",
		})
		await inbox.stop()
	})

	it("ships the Messenger window in the UI document", () => {
		const html = inbox_ui()
		expect(html).toContain('id="messenger"')
		expect(html).toContain('id="msn-nudge"')
		expect(html).toContain("Conversation")
	})
})
