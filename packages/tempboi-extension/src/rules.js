/**
 * The extension's pure half: no `chrome`, no `fetch`, no DOM. The popup, the options page
 * and the worker all read these, and rules.test.js tests them directly.
 */

/** Where anonymous inboxes live. The options page can point elsewhere (a preview, `bun dev`). */
export const DEFAULT_SERVER = "https://tempboi.email"

/** Every inbox token starts with this (tempboi.ts `TOKEN_PREFIX` in the app). */
export const TOKEN_PREFIX = "tb_"

/** An anonymous inbox's whole-life cap. The server enforces it; we only offer what fits. */
export const ANONYMOUS_MAX_MS = 24 * 60 * 60 * 1000

/** How much one press of "+1h" adds. */
export const EXTEND_STEP_MS = 60 * 60 * 1000

/** The lifetimes the options page offers a new inbox, as the API's own spelling. */
export const LIFETIMES = [
	{ ttl: "1h", label: "1 hour" },
	{ ttl: "6h", label: "6 hours" },
	{ ttl: "1d", label: "1 day" },
]

/** How long the popup's long poll holds, in seconds. The server's own ceiling is 25. */
export const POLL_SECONDS = 25

/**
 * The worker's alarm, in minutes. With push the alarm is only a backstop for a push the
 * push service dropped; without it (a server with no key, a browser that refused) it is
 * how mail is found, at Chrome's floor of half a minute.
 */
export const ALARM_MINUTES = { pushed: 5, polled: 0.5 }

/**
 * tempboi.email's VAPID public key: public by definition, and the same one the app's build
 * script bakes into the page. An inbox's answer carries its server's key as `push.key`,
 * which wins; this covers a server that answers without one yet.
 */
export const TEMPBOI_PUSH_KEY =
	"BMOvqNa2X4FY7RtGBfHn0Lpg1II-PafsAq1IdktdxwU3y9sKm2YyP_r9kt-B11odlAj62DeC3v5qYUFTbMrLiA4"

/**
 * Where and with what key to follow an inbox by push, or undefined when it can't be.
 * The inbox's own answer says; failing that, tempboi.email is known to push.
 */
export function push_target(inbox) {
	if (!inbox || inbox.gone) return undefined
	if (inbox.push?.key && inbox.push?.url) return { key: inbox.push.key, url: inbox.push.url }
	if (inbox.server !== DEFAULT_SERVER) return undefined
	return {
		key: TEMPBOI_PUSH_KEY,
		url: `${DEFAULT_SERVER}/v1/inboxes/${encodeURIComponent(inbox.address)}/push`,
	}
}

/** A base64url VAPID key as the bytes `pushManager.subscribe` wants. */
export function key_bytes(key) {
	const base64 = key.replace(/-/g, "+").replace(/_/g, "/")
	const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))
	return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

/** Whether a subscription was made with this key: a new key needs a new subscription. */
export function same_key(subscribed_with, key) {
	if (!subscribed_with) return false
	const a = new Uint8Array(subscribed_with)
	const b = key_bytes(key)
	return a.length === b.length && a.every((byte, n) => byte === b[n])
}

/** A server URL as settings keep it: an http(s) origin, no trailing slash, or undefined. */
export function server_origin(value) {
	if (typeof value !== "string" || !value.trim()) return undefined
	try {
		const url = new URL(value.trim())
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
		// A preview or `bun dev` serves the API at its origin; the page under /tempboi.
		return url.origin
	} catch {
		return undefined
	}
}

/**
 * The token in whatever was pasted: the token itself, or the whole command the page's
 * terminal strip copies (`POSTBOI_INBOX_TOKEN=tb_… npx tempboi watch`).
 */
export function clean_token(value) {
	const found = /(?:^|[\s="'])(tb_[A-Za-z0-9_-]{8,})(?=$|[\s"'])/.exec(String(value ?? "").trim())
	return found?.[1]
}

/**
 * The server named in a pasted command, when it names one. The page's terminal strip
 * adds `POSTBOI_INBOX_URL=…` whenever it isn't tempboi.email (a preview, `bun dev`),
 * since nothing in a token says which server made it.
 */
export function pasted_server(value) {
	const found = /POSTBOI_INBOX_URL=["']?([^\s"']+)/.exec(String(value ?? ""))
	return found ? server_origin(found[1]) : undefined
}

/** A chosen name as the server will take it: lowercase letters, numbers, hyphens, up to 24. */
export function clean_name(value) {
	const name = String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/@.*$/, "")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return name.slice(0, 24) || undefined
}

/** "42m", "1h 5m", "59s" until `expires`; "Expired" once it has passed. */
export function time_left(expires, now = Date.now()) {
	const ms = new Date(expires).getTime() - now
	if (!Number.isFinite(ms) || ms <= 0) return "Expired"
	const seconds = Math.floor(ms / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const rest = minutes % 60
	return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** "now", "3m", "2h", "4d": how long ago, short enough for a list row. */
export function ago(when, now = Date.now()) {
	const seconds = Math.max(0, Math.floor((now - new Date(when).getTime()) / 1000))
	if (!Number.isFinite(seconds) || seconds < 45) return "now"
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours}h`
	return `${Math.round(hours / 24)}d`
}

/**
 * The `ttl` a PATCH needs to add `add_ms` to what is left, in seconds. The server reads
 * `ttl` as "live this long from now" and caps it at the inbox's whole life, so this is
 * the remaining time plus the step, never less than the step itself.
 */
export function extended_ttl(expires, add_ms = EXTEND_STEP_MS, now = Date.now()) {
	const left = Math.max(0, new Date(expires).getTime() - now)
	return Math.ceil((left + add_ms) / 1000)
}

/** Whether "+1h" can still add anything to an anonymous inbox. */
export function can_extend(created, expires, max_ms = ANONYMOUS_MAX_MS) {
	const end = new Date(created).getTime() + max_ms
	return new Date(expires).getTime() < end - 60 * 1000
}

/** The name to show for a sender: their display name, else their address, else "Unknown". */
export function sender(message) {
	return message?.from_name?.trim() || message?.from?.trim() || "Unknown sender"
}

/** One letter for a sender without a mark. */
export function initial(message) {
	const letter = sender(message).replace(/^[^A-Za-z0-9]+/, "")[0]
	return letter ? letter.toUpperCase() : "?"
}

/**
 * Fold a page of summaries into what is held: by id, newest first, capped. A message
 * the popup and the worker both fetched is the same message, so the merge is idempotent,
 * and the cursor only ever moves forward.
 */
export function merge(held, page, cap = 100) {
	const by_id = new Map((held.messages ?? []).map((message) => [message.id, message]))
	const fresh = []
	for (const message of page.data ?? []) {
		if (!by_id.has(message.id)) fresh.push(message)
		by_id.set(message.id, message)
	}
	const messages = [...by_id.values()].sort((a, b) => b.seq - a.seq).slice(0, cap)
	return {
		messages,
		cursor: Math.max(held.cursor ?? 0, page.cursor ?? 0),
		fresh: fresh.sort((a, b) => a.seq - b.seq),
	}
}

/** How many held messages haven't been opened. */
export function unread_count(messages, seen) {
	const opened = new Set(seen ?? [])
	return (messages ?? []).filter((message) => !opened.has(message.id)).length
}

/** The newest code among held messages, with the message it came from. */
export function latest_code(messages) {
	const message = (messages ?? []).find((each) => each.code)
	return message ? { code: message.code, message } : undefined
}

/**
 * The inbox's page on the web with one message open. The page reads `?m=` once the inbox
 * is up; the token stays after the `#`, where the server never sees it.
 */
export function message_page(web, id) {
	const url = new URL(web)
	url.searchParams.set("m", id)
	return url.toString()
}

export function escape_html(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
}

/**
 * The document the reader's sandboxed frame is given. The html is a stranger's and is
 * stored as received, so it is never run and never trusted: the frame has no scripts, and
 * this CSP holds back everything remote but links unless images were asked for. A remote
 * image is a read receipt, which is why the page holds them back too.
 */
export function reader_document(message, { images = false } = {}) {
	const csp = [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		`img-src data: cid:${images ? " https: http:" : ""}`,
		`font-src data:${images ? " https:" : ""}`,
	].join("; ")
	const head = [
		'<meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${csp}">`,
		'<meta name="referrer" content="no-referrer">',
		'<base target="_blank">',
		// Mail is written for white paper, so the frame is light whatever the popup is.
		'<meta name="color-scheme" content="light">',
		"<style>html{background:#fff}body{margin:0;padding:16px;overflow-wrap:anywhere;font:14px/1.5 system-ui,sans-serif;color:#111}img{max-width:100%;height:auto}pre.text{white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:0}</style>",
	].join("")
	if (message?.html)
		return `<!doctype html><html><head>${head}</head><body>${message.html}</body></html>`
	const text = escape_html(message?.text ?? "").replace(
		/https?:\/\/[^\s<>"']+/g,
		(url) => `<a href="${url}" rel="noreferrer">${url}</a>`
	)
	return `<!doctype html><html><head>${head}</head><body><pre class="text">${text || "(No text in this message.)"}</pre></body></html>`
}

/** Whether the html asks for anything remote that the reader held back. */
export function has_remote_images(html) {
	return /<img[^>]+src\s*=\s*["']?https?:|url\(\s*["']?https?:/i.test(html ?? "")
}

/** "12 KB", "1.4 MB". */
export function file_size(bytes) {
	if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes | 0)} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A notification's words for a new message. */
export function notification_for(message) {
	const title = message.code ? `Code ${message.code}` : `New mail from ${sender(message)}`
	const body = message.subject?.trim() || "(No subject)"
	return {
		title,
		message: message.code ? `${sender(message)}: ${body}` : body,
	}
}
