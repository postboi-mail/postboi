import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { create_inbox_store, inbox_middleware, best_rendition } from "./inbox_server.js"
import { resolve_inbox, set_inbox_port, INBOX_PATH } from "./inbox.js"
import { inbox_ui } from "./inbox_ui.js"
import { DESKTOP } from "./inbox_desktop.js"
import { POOM_SPRITES } from "./inbox_poom.js"
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
		// Resize handles on the mailbox, the reader, the messenger, the three channel app
		// windows (WhatsApp, chat, notifications), the capture viewer, POOM.EXE and the app
		// frame itself — the reading pane is only ever big enough because you can make it
		// bigger, and a client capture is a tall render you want room for. The Pokia has
		// none: a handset is not resizable, which is rather the point of it.
		expect(html.match(/class="grip"/g)).toHaveLength(9)
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

	it("opens a client capture in its own window, not a new browser tab", () => {
		const html = inbox_ui()
		// The viewer is a window on the desktop like every other thing here.
		expect(html).toContain('id="shotwin"')
		expect(html).toContain('id="shot-img"')
		// A capture cell is a button into that window — never a link off to a raw PNG on a
		// blank tab, which loses which client it came from.
		expect(html).toContain('class="r-open"')
		expect(html).not.toContain('target="_blank" rel="noreferrer">')
		// And it steps through the run's other captures without going back to the grid.
		expect(html).toContain('id="shot-prev"')
		expect(html).toContain('id="shot-next"')
	})

	it("has a system message box for a refusal it cannot fix itself", () => {
		const html = inbox_ui()
		// A dialog, not a console line: an exhausted render allowance needs a decision.
		expect(html).toContain('id="alertwin"')
		expect(html).toContain('id="alert-text"')
		// ...and a way out of it, on the account the run was ordered from.
		expect(html).toContain('id="alert-upgrade"')
		expect(html).toContain('id="alert-topup"')
		expect(html).toContain('id="alert-ok"')
		// The failed cell says why too, so dismissing the dialog doesn't lose the reason —
		// and it's a button, so the dialog can be brought back after it's dismissed.
		expect(html).toContain('p.error || "no capture"')
		// Wired by class, never an id minted inside the previews loop — a run with
		// two refusals (a failed capture beside the allowance marker) would mint
		// duplicate ids and leave the second button dead.
		expect(html).toContain('class="r-hold r-why" data-err=')
		expect(html).not.toContain('id="rwhy"')
		// A run that rendered nothing offers its order key again, so credits bought in the
		// tab you just came back from have something to be spent on.
		expect(html).toContain("Try again")
		// ...and returning focus re-asks, because a top-up lands by webhook and nothing
		// here is told about it.
		expect(html).toContain('window.addEventListener("focus"')
	})

	it("serves a script that parses and markup whose windows all close", () => {
		const html = inbox_ui()
		// The page is one inline script; a single truncated block kills the whole
		// desktop, and substring assertions can't see it. Actually parse it — this
		// exact gap shipped an unclosed listener that made the entire UI inert.
		const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? ""
		expect(script.length).toBeGreaterThan(1000)
		expect(() => new Function(script)).not.toThrow()
		// Every <div> closes: an unclosed window swallows its later siblings into a
		// display:none parent (this shipped too — POOM and the Pokia vanished).
		const opens = (html.match(/<div[\s>]/g) ?? []).length
		const closes = (html.match(/<\/div>/g) ?? []).length
		expect(opens).toBe(closes)
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
	afterEach(() => {
		set_inbox_port(null as unknown as number)
		vi.unstubAllEnvs()
	})

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
		// The only test that lets discovery run to the end, so it is the only one that reads
		// node_modules/.postboi/inbox.json — which a hard-killed `postboi dev` leaves behind
		// holding an ephemeral port. The full suite binds enough ephemeral ports for one of its
		// own inbox servers to land on that stale number and take the capture, and then nothing
		// prints. "No inbox" has to be stated, the way postboi.test.ts states it.
		vi.stubEnv("POSTBOI_INBOX", "off")
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

	it("ships a window per channel — and the handset without an XP frame", () => {
		const html = inbox_ui()
		for (const id of ["wawin", "platwin", "pushwin", "pokia", "nk-lcd", "wachat", "pushbody"]) {
			expect(html).toContain(`id="${id}"`)
		}
		// The handset is a child of the desktop but never a .window: no title bar, no
		// frame — the shell is the chrome, the way a Winamp skin was.
		expect(html).toContain('id="pokia" class="child conv"')
		// And it is a Pokia, not the brand it is plainly doing an impression of.
		expect(html).not.toContain("NOKIA")
		// The four chat wardrobes the platform picker can dress the window in.
		for (const plat of ["plat-slack", "plat-discord", "plat-teams", "plat-telegram"]) {
			expect(html).toContain(plat)
		}
	})

	it("chips each row with the platform it went out on, in its own column", () => {
		const html = inbox_ui()
		// The label comes off the platform, not the channel: a Slack capture says Slack.
		for (const tag of ["Slack", "Discord", "Teams", "Telegram", "Bluesky"]) {
			expect(html).toContain(`tag: "${tag}"`)
		}
		// Its own cell, so the chips line up down the list instead of trailing the subject.
		expect(html).toContain('<td class="chanco">')
		expect(html).toContain("td.chanco {")
	})

	it("ships the two things on the desktop that aren't mail", () => {
		const html = inbox_ui()
		// Snake, on the handset's screen, over the same LCD the texts are drawn on.
		expect(html).toContain('id="nk-game"')
		expect(html).toContain('id="nk-screen"')
		// The weapon sprites are Freedoom's, so the notice they are licensed on has to go
		// out with them — in the page itself, not only in a file beside it.
		expect(html).toContain("Freedoom project")
		expect(Object.keys(POOM_SPRITES)).toContain("gunfire")
		// POOM.EXE, and the face that takes the hits in its status bar.
		expect(html).toContain('id="poom"')
		expect(html).toContain('id="poom-view"')
		expect(html).toContain('id="poom-faces"')
		expect(html).toContain('id="sc-poom"')
		// Every mood ships, or the face can't change when something bites you — or when
		// nothing can.
		for (const mood of [
			"face",
			"nervous",
			"crying",
			"exhausted",
			"celebrating",
			"goat",
			"wink",
			"goatwink",
		]) {
			expect(DESKTOP[mood]).toBeDefined()
		}
		// The cheat, and the frame the weapon rests in when it isn't being fired.
		expect(html).toContain('"iddqd"')
		expect(html).toContain('"gunidle"')
	})

	it("keeps the platform on a chat capture so the window can dress as it", async () => {
		const inbox = await start_inbox()
		set_inbox_port(inbox.port)

		const chat = new MockChat({ sink: inbox_sink("chat"), platform: "slack" })
		await chat.send({ message: "Deploy finished" })
		await until(() => inbox.store.list().length === 1)

		expect(inbox.store.list()[0]).toMatchObject({ channel: "chat", provider: "slack" })
		await inbox.stop()
	})
})

describe("inbox screenshots (hosted testing API)", () => {
	let inbox: Awaited<ReturnType<typeof start_inbox>>
	const real_fetch = globalThis.fetch

	beforeEach(async () => {
		inbox = await start_inbox()
	})

	afterEach(async () => {
		await inbox.stop()
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	/** Route hosted-API calls to a stub; everything else (the inbox itself) stays real. */
	function stub_hosted(handler: (url: string, init?: RequestInit) => Response) {
		const seen: Array<{ url: string; init?: RequestInit }> = []
		vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			if (!url.startsWith("https://hosted.test")) return real_fetch(input as string, init)
			seen.push({ url, init })
			return Promise.resolve(handler(url, init))
		}) as typeof globalThis.fetch)
		return seen
	}

	it("reports the token's absence rather than erroring", async () => {
		const stored = inbox.store.add(message)
		const answer = await real_fetch(
			`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages/${stored.id}/screenshots`
		)
		expect(answer.status).toBe(200)
		// The billing links ride along even with no token: they're derived from the host,
		// not from the account, and the dialog that offers them needs somewhere to point.
		expect(await answer.json()).toEqual({
			enabled: false,
			run_id: null,
			previews: [],
			billing: {
				packs: "https://postboi.app/dashboard/testing",
				plan: "https://postboi.app/dashboard/settings/billing",
			},
		})

		const order = await real_fetch(
			`http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages/${stored.id}/screenshots`,
			{ method: "POST" }
		)
		expect(order.status).toBe(400)
	})

	it("orders a run, pastes the capture in, and proxies status and images", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "tok-1")
		vi.stubEnv("POSTBOI_API_URL", "https://hosted.test")
		const seen = stub_hosted((url) => {
			if (url.endsWith("/v1/testing")) {
				return new Response(JSON.stringify({ id: "test_abc" }), { status: 201 })
			}
			if (url.endsWith("/v1/testing/test_abc/source")) {
				return new Response(JSON.stringify({ ok: true }), { status: 200 })
			}
			// An older server: no `screenshots` on the run, so the list comes from /previews.
			if (url.endsWith("/v1/testing/test_abc")) {
				return new Response(JSON.stringify({ id: "test_abc", status: "received" }))
			}
			if (url.endsWith("/v1/testing/test_abc/previews")) {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "prev_1", client_name: "Outlook (Windows)", status: "ready" },
							{ id: "prev_2", client_name: "Gmail (web)", status: "pending" },
						],
					}),
					{ status: 200 }
				)
			}
			if (url.endsWith("/v1/testing/test_abc/previews/prev_1")) {
				return new Response(new Uint8Array([137, 80]), {
					headers: { "content-type": "image/png" },
				})
			}
			return new Response("nope", { status: 404 })
		})
		const stored = inbox.store.add(message)
		const base = `http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages/${stored.id}/screenshots`

		const order = await real_fetch(base, { method: "POST" })
		expect(order.status).toBe(201)
		expect(await order.json()).toEqual({ run_id: "test_abc" })
		// The token travelled as a bearer, and the capture's HTML went in whole.
		expect((seen[0].init?.headers as Record<string, string>).authorization).toBe("Bearer tok-1")
		expect(JSON.parse(String(seen[1].init?.body)).html).toBe("<p>Hello</p>")

		const listed = await real_fetch(base)
		const status = (await listed.json()) as { previews: Array<{ id: string; status: string }> }
		expect(status.previews.map((preview) => preview.status)).toEqual(["ready", "pending"])

		const image = await real_fetch(`${base}/prev_1`)
		expect(image.status).toBe(200)
		expect(image.headers.get("content-type")).toBe("image/png")
		expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([137, 80]))
	})

	it("turns a current server's notes back into the refusal rows the pane explains", async () => {
		vi.stubEnv("POSTBOI_TOKEN", "tok-1")
		vi.stubEnv("POSTBOI_API_URL", "https://hosted.test")
		const seen = stub_hosted((url) => {
			if (url.endsWith("/v1/testing")) {
				return new Response(JSON.stringify({ id: "test_new" }), { status: 201 })
			}
			if (url.endsWith("/v1/testing/test_new/source")) {
				return new Response(JSON.stringify({ id: "test_new", status: "received" }))
			}
			if (url.endsWith("/v1/testing/test_new")) {
				return new Response(
					JSON.stringify({
						id: "test_new",
						status: "received",
						screenshots: { state: "done", notes: ["Out of renders: 3 clients skipped."] },
						previews: [{ id: "prev_1", client_name: "Gmail (web)", status: "ready" }],
					})
				)
			}
			return new Response("nope", { status: 404 })
		})
		const stored = inbox.store.add(message)
		const base = `http://127.0.0.1:${inbox.port}${INBOX_PATH}/api/messages/${stored.id}/screenshots`
		await real_fetch(base, { method: "POST" })

		const listed = await real_fetch(base)
		const status = (await listed.json()) as {
			previews: Array<{ client_name: string; status: string; error?: string }>
		}
		expect(status.previews).toEqual([
			{ id: "prev_1", client_name: "Gmail (web)", status: "ready" },
			{
				id: "note_0",
				client_name: "Screenshots",
				status: "failed",
				error: "Out of renders: 3 clients skipped.",
			},
		])
		expect(seen.some((call) => call.url.endsWith("/previews"))).toBe(false)
	})
})
