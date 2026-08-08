import type { SentMessage } from "./mock.js"
import type { InboxMessage } from "./inbox.js"
import { INBOX_PATH } from "./inbox.js"
import { inbox_ui, type InboxUiOptions } from "./inbox_ui.js"
import { SOUNDS } from "./inbox_sounds.js"
import { ART } from "./inbox_art.js"
import { DESKTOP } from "./inbox_desktop.js"

/**
 * The dev inbox's storage and HTTP surface. Kept apart from the transport that mounts it:
 * the `postboi/vite` plugin hands this to Vite's own middleware stack, and `postboi dev`
 * hands it to a bare Node server, but it's the same inbox either way.
 */

/**
 * The slice of Node's `IncomingMessage` this needs, declared structurally so the published
 * types never oblige a consumer to have `@types/node` installed.
 */
export interface InboxRequest {
	url?: string
	method?: string
	headers?: Record<string, string | Array<string> | undefined>
	on(event: string, listener: (...args: Array<unknown>) => void): unknown
}

/** The slice of Node's `ServerResponse` this needs. See {@link InboxRequest}. */
export interface InboxResponse {
	statusCode: number
	setHeader(name: string, value: string): unknown
	write(chunk: string): unknown
	end(chunk?: string | Uint8Array): unknown
	on(event: string, listener: () => void): unknown
}

/** A connect-style middleware — what Vite's `server.middlewares.use` takes. */
export type InboxMiddleware = (
	request: InboxRequest,
	response: InboxResponse,
	next: () => void
) => void

/**
 * A message on its way in. In-process it still carries a `Date`; over HTTP it has already
 * been through JSON and carries the ISO string. The store takes either and settles on one.
 *
 * Sender, subject and attachments went optional when the other channels arrived: a text
 * has none of the three, and the store lists whatever it's given.
 */
export type CapturedMessage = Omit<
	SentMessage,
	"scheduled_at" | "from" | "subject" | "attachments"
> &
	Partial<Pick<SentMessage, "from" | "subject" | "attachments">> & {
		scheduled_at?: Date | string
		/** The id the send handed back, which a later cancellation arrives with. */
		send_id?: string
		/** Which channel captured this. Absent means email. */
		channel?: InboxMessage["channel"]
		/** Channel-specific details, rendered as-is by the UI. */
		meta?: Array<[string, string]>
	}

/** The captured messages, and the means to watch for more. */
export interface InboxStore {
	/** Store a captured message and return it with its assigned id. */
	add(message: CapturedMessage): InboxMessage
	/** Every stored message, newest first. */
	list(): Array<InboxMessage>
	/** One message by id. */
	get(id: string): InboxMessage | undefined
	/**
	 * Mark the message a send returned `send_id` for as cancelled. Returns false when nothing
	 * matches — a cancel for a send from before this inbox started, most likely.
	 */
	cancel(send_id: string): boolean
	/** Empty the inbox. */
	clear(): void
	/** Watch for arrivals and clears. Returns the unsubscribe. */
	subscribe(listener: () => void): () => void
}

/**
 * An in-memory inbox. Memory is the right store for something whose whole lifetime is one
 * `bun run dev`: nothing to migrate, nothing to clean up, and restarting the dev server
 * giving you an empty inbox is what you'd want anyway.
 *
 * @param limit How many messages to keep before dropping the oldest.
 */
export function create_inbox_store(limit = 200): InboxStore {
	const messages: Array<InboxMessage> = []
	const listeners = new Set<() => void>()
	let counter = 0

	const notify = () => {
		for (const listener of listeners) listener()
	}

	return {
		add(message) {
			const stored: InboxMessage = {
				...message,
				scheduled_at: message.scheduled_at
					? new Date(message.scheduled_at).toISOString()
					: undefined,
				id: `${++counter}`,
				received_at: Date.now(),
			}
			messages.unshift(stored)
			if (messages.length > limit) messages.length = limit
			notify()
			return stored
		},
		list: () => messages,
		get: (id) => messages.find((message) => message.id === id),
		cancel(send_id) {
			const message = messages.find((m) => m.send_id === send_id)
			if (!message || message.cancelled_at) return false
			message.cancelled_at = new Date().toISOString()
			notify()
			return true
		},
		clear() {
			messages.length = 0
			notify()
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
}

function send_json(response: InboxResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body)
	response.statusCode = status
	response.setHeader("content-type", "application/json")
	// The inbox is a dev tool showing the newest state; a cached list is never what you want.
	response.setHeader("cache-control", "no-store")
	response.end(text)
}

/**
 * Look a named asset up without walking into `Object.prototype`.
 *
 * The name comes off the URL, and `constructor` is as lowercase as `wallpaper` — a plain
 * index would hand back the `Object` function, sail past the not-found check, and throw
 * somewhere that takes the whole dev server with it.
 */
function own<T>(record: Record<string, T>, name: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined
}

/** FNV-1a over the encoded bytes. Cheap, and only ever computed once per asset. */
const etags = new Map<string, string>()
function etag_for(data: string): string {
	const cached = etags.get(data)
	if (cached) return cached
	let hash = 0x811c9dc5
	for (let i = 0; i < data.length; i++) {
		hash ^= data.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	const tag = `"${data.length.toString(36)}-${hash.toString(36)}"`
	etags.set(data, tag)
	return tag
}

/**
 * Serve a baked-in binary — artwork, a sound, a piece of the desktop.
 *
 * Revalidated rather than simply cached for a day. These live at fixed paths but their bytes
 * change whenever the package does, so a plain `max-age` leaves a browser showing last
 * week's artwork against this week's UI with no way to know it. The tag means a repeat
 * visit costs one 304 and the bytes still come from disk.
 *
 * Ranges are answered because video elements ask for them, and some browsers refuse a source
 * that replies to a range request with the whole body.
 */
function send_asset(
	request: InboxRequest,
	response: InboxResponse,
	type: string,
	data: string
): void {
	send_bytes(request, response, type, Buffer.from(data, "base64"), etag_for(data))
}

function send_bytes(
	request: InboxRequest,
	response: InboxResponse,
	type: string,
	bytes: Buffer,
	tag: string
): void {
	response.setHeader("content-type", type)
	response.setHeader("cache-control", "no-cache")
	response.setHeader("etag", tag)
	response.setHeader("accept-ranges", "bytes")
	const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers?.range ?? ""))
	if (!range && String(request.headers?.["if-none-match"] ?? "") === tag) {
		response.statusCode = 304
		return void response.end()
	}
	if (range && (range[1] !== "" || range[2] !== "")) {
		const start = range[1] === "" ? bytes.length - Number(range[2]) : Number(range[1])
		const end = range[1] === "" || range[2] === "" ? bytes.length - 1 : Number(range[2])
		if (start < 0 || start > end || end >= bytes.length) {
			response.statusCode = 416
			response.setHeader("content-range", `bytes */${bytes.length}`)
			return void response.end()
		}
		response.statusCode = 206
		response.setHeader("content-range", `bytes ${start}-${end}/${bytes.length}`)
		return void response.end(bytes.subarray(start, end + 1))
	}
	response.statusCode = 200
	response.end(bytes)
}

/**
 * The desktop clip, which is streamed rather than shipped.
 *
 * An encode small enough to publish inside the package looked like a photograph put through a
 * fax machine, so the clip lives on Mux and this fetches it once per server. Mux serves it as
 * HLS with no plain-MP4 rendition, but the segments are CMAF — an init segment followed by
 * media segments — and a fragmented MP4 is exactly what you get by laying those end to end.
 * So the stitching happens here and the browser is handed an ordinary MP4, which means no
 * player library, no media-source plumbing, and it works in whatever you have open.
 *
 * The manifest is re-read every time because the segment URLs it points at are signed and
 * expire; only the stitched result is kept.
 */
const MUX_PLAYBACK_ID = "F65OquEDg7w5qO5EwhQoPR9Y4FRRC2d7mg6yJRi3jgc"

let clip: Promise<Buffer | null> | undefined

/**
 * The best rendition's URL from a master playlist: widest, and among equals the fattest.
 * Mux publishes two at the source resolution and the choice between them is quality, which
 * is the whole reason the clip is coming over the wire instead of out of the package.
 */
export function best_rendition(manifest: string): string | undefined {
	const lines = manifest.split("\n").map((line) => line.trim())
	let best: { width: number; bandwidth: number; url: string } | undefined
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue
		const width = Number(/RESOLUTION=(\d+)x/.exec(lines[i])?.[1] ?? 0)
		const bandwidth = Number(/[^-]BANDWIDTH=(\d+)/.exec(lines[i])?.[1] ?? 0)
		const url = lines.slice(i + 1).find((line) => line && !line.startsWith("#"))
		if (!url) continue
		const better =
			!best || width > best.width || (width === best.width && bandwidth > best.bandwidth)
		if (better) best = { width, bandwidth, url }
	}
	return best?.url
}

async function fetch_clip(): Promise<Buffer | null> {
	if (clip) return clip
	clip = (async () => {
		const master = await fetch(`https://stream.mux.com/${MUX_PLAYBACK_ID}.m3u8`)
		if (!master.ok) throw new Error(`mux: ${master.status}`)
		const rendition = best_rendition(await master.text())
		if (!rendition) throw new Error("mux: no rendition")

		const media = await fetch(rendition)
		if (!media.ok) throw new Error(`mux: ${media.status}`)
		const playlist = await media.text()
		const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1]
		if (!init) throw new Error("mux: not fragmented mp4")
		const segments = playlist
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("http"))

		// In order, because the concatenation is the file.
		const parts: Array<Buffer> = []
		for (const url of [init, ...segments]) {
			const part = await fetch(url)
			if (!part.ok) throw new Error(`mux: ${part.status}`)
			parts.push(Buffer.from(await part.arrayBuffer()))
		}
		return Buffer.concat(parts)
	})().catch(() => {
		// Offline, or Mux having a bad day. The wallpaper is the same opening frame, so the
		// desktop looks right either way — and a retry costs one manifest read.
		clip = undefined
		return null
	})
	return clip
}

/** Collect a request body. Capped — an attachment-heavy send is still only a few MB. */
function read_body(request: InboxRequest, limit = 32 * 1024 * 1024): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = ""
		let size = 0
		request.on("data", (chunk: unknown) => {
			const text = String(chunk)
			size += text.length
			if (size > limit) return reject(new Error("inbox: message too large"))
			body += text
		})
		request.on("end", () => resolve(body))
		request.on("error", (error: unknown) => reject(error))
	})
}

/**
 * A message's HTML, as its own document for the preview iframe. Served separately rather
 * than injected into the UI so the email's CSS can't reach the inbox chrome around it —
 * the mail renders in the isolation a real client would give it.
 */
const BODY_CURSORS =
	`<style>` +
	`html{cursor:url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAj0lEQVR4nO2WQQqAMAwEN8H/fzkebKU2tQrazSUDYlsPOyw0CACGQLS8wyQUAMwsTKI2ECah7SZCQvsDtoQTYEsMBZgStwIsiakAQ+JRYLXENvsoIs4FgDv8gmtgECrd8ysXgUH4ck6BEi7H8hCh3YImnE5toA+ntaCDcCqzOUBp4dUgisYQ/N+YJEmSLGUHGtQ1GJ7uSPQAAAAASUVORK5CYII=") 0 0,default}` +
	`p,pre,td,th,li,h1,h2,h3,h4,h5,h6,span,a,div,blockquote{` +
	`cursor:url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZUlEQVR4nO2WsQ7AIAgFpfH/f/l1sQuLvMbawbvJKCEnmEhrcDpRDZQkK3FEKXc3k5biHNfLEfgCqwL5Zk9FzO6sYbwJjeVrg99bgAACCCCAAAIIlAeS2Z+fz7fOhHn/nJkQYAU3Z9MlJ47DlFIAAAAASUVORK5CYII=") 15 15,text}` +
	`</style>`

function body_document(message: InboxMessage): string {
	// The cursors are the only thing added to the mail. A frame has its own document, so
	// without them the pointer reverts to the host OS's the moment it crosses into the
	// message — which is precisely the seam the rest of this is dressed up to hide. Nothing
	// else is touched: no mail client renders a cursor, so nothing here can render wrong.
	if (message.html) return BODY_CURSORS + message.html
	const text = message.text ?? ""
	const escaped = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
	return `<!doctype html><meta charset="utf-8">${BODY_CURSORS}<pre style="font:13px ui-monospace,monospace;white-space:pre-wrap;word-wrap:break-word;margin:12px">${escaped}</pre>`
}

/**
 * A `content-disposition` for a downloaded attachment.
 *
 * The name is whatever the sending code attached, and that is routinely user input — a file
 * picked in a contact form, say. A quote breaks the parse, and a newline is a header
 * injection that Node refuses outright by throwing, which on the bare `postboi dev` server
 * takes the whole process with it. So: a scrubbed ASCII name for old parsers, and the real
 * one encoded alongside for everything since RFC 6266.
 */
function content_disposition(name: string): string {
	// eslint-disable-next-line no-control-regex
	const plain = name.replace(/[\u0000-\u001f\u007f"\\]/g, "_")
	const ascii = plain.replace(/[^\u0020-\u007e]/g, "_") || "attachment"
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** A media type safe to echo back, or the generic one. Same reasoning as the filename. */
function safe_mime(type: string | undefined): string {
	return type && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream"
}

/**
 * The inbox's HTTP surface, mounted under {@link INBOX_PATH}. Requests for anything else
 * fall through to `next()`, so this is safe to stack in front of an app's own routes.
 */
export function inbox_middleware(
	store: InboxStore,
	base: string = INBOX_PATH,
	ui: InboxUiOptions = {}
): InboxMiddleware {
	return (request, response, next) => {
		const url = request.url ?? ""
		const path = url.split("?")[0].replace(/\/+$/, "") || "/"
		if (path !== base && !path.startsWith(`${base}/`)) return next()
		const route = path.slice(base.length) || "/"
		const method = request.method ?? "GET"

		if (route === "/" && method === "GET") {
			response.statusCode = 200
			response.setHeader("content-type", "text/html; charset=utf-8")
			response.setHeader("cache-control", "no-store")
			return void response.end(inbox_ui(ui))
		}

		const art_match = /^\/api\/art\/([a-z]+)$/.exec(route)
		if (art_match && method === "GET") {
			const png = own(ART, art_match[1])
			if (!png) return void send_json(response, 404, { error: "no such art" })
			return void send_asset(request, response, "image/png", png)
		}

		if (route === "/api/desktop/blissy" && method === "GET") {
			return void fetch_clip()
				.then((bytes) => {
					if (!bytes) return send_json(response, 503, { error: "clip unavailable" })
					send_bytes(request, response, "video/mp4", bytes, `"clip-${bytes.length}"`)
				})
				.catch(() => send_json(response, 503, { error: "clip unavailable" }))
		}

		const desktop_match = /^\/api\/desktop\/([a-z]+)$/.exec(route)
		if (desktop_match && method === "GET") {
			const asset = own(DESKTOP, desktop_match[1])
			if (!asset) return void send_json(response, 404, { error: "no such desktop asset" })
			return void send_asset(request, response, asset.type, asset.data)
		}

		const sound_match = /^\/api\/sounds\/([a-z]+)$/.exec(route)
		if (sound_match && method === "GET") {
			const sound = own(SOUNDS, sound_match[1])
			if (!sound) return void send_json(response, 404, { error: "no such sound" })
			return void send_asset(request, response, sound.type, sound.data)
		}

		if (route === "/api/messages" && method === "POST") {
			return void read_body(request)
				.then((body) => {
					const message = store.add(JSON.parse(body) as CapturedMessage)
					send_json(response, 201, { id: message.id })
				})
				.catch((error: unknown) => {
					send_json(response, 400, { error: String(error) })
				})
		}

		if (route === "/api/messages/cancel" && method === "POST") {
			return void read_body(request)
				.then((body) => {
					const { send_id } = JSON.parse(body) as { send_id?: string }
					const found = typeof send_id === "string" && store.cancel(send_id)
					send_json(response, found ? 200 : 404, { ok: found })
				})
				.catch((error: unknown) => {
					send_json(response, 400, { error: String(error) })
				})
		}

		if (route === "/api/messages" && method === "GET") {
			return void send_json(response, 200, { messages: store.list() })
		}

		if (route === "/api/messages" && method === "DELETE") {
			store.clear()
			return void send_json(response, 200, { ok: true })
		}

		// Live updates. One long-lived response per open tab, closed when the tab goes away.
		if (route === "/api/events" && method === "GET") {
			response.statusCode = 200
			response.setHeader("content-type", "text/event-stream")
			response.setHeader("cache-control", "no-store")
			response.setHeader("connection", "keep-alive")
			response.write(": open\n\n")
			const unsubscribe = store.subscribe(() => response.write("data: change\n\n"))
			request.on("close", () => unsubscribe())
			response.on("close", () => unsubscribe())
			return
		}

		const body_match = /^\/api\/messages\/([^/]+)\/body$/.exec(route)
		if (body_match && method === "GET") {
			const message = store.get(body_match[1])
			if (!message) return void send_json(response, 404, { error: "no such message" })
			response.statusCode = 200
			response.setHeader("content-type", "text/html; charset=utf-8")
			response.setHeader("cache-control", "no-store")
			return void response.end(body_document(message))
		}

		const attachment_match = /^\/api\/messages\/([^/]+)\/attachments\/(\d+)$/.exec(route)
		if (attachment_match && method === "GET") {
			const message = store.get(attachment_match[1])
			const attachment = message?.attachments?.[Number(attachment_match[2])]
			if (!attachment) return void send_json(response, 404, { error: "no such attachment" })
			response.statusCode = 200
			response.setHeader("content-type", safe_mime(attachment.mime_type))
			response.setHeader("content-disposition", content_disposition(attachment.name ?? ""))
			// Providers take base64, so that's what the mock captured — decode it back for download.
			return void response.end(Buffer.from(attachment.content, "base64"))
		}

		send_json(response, 404, { error: "not found" })
	}
}
