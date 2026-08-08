import type { SentMessage } from "./mock.js"
import type { Channel } from "./errors.js"
import { read_env } from "./env.js"

/**
 * The local development inbox — where mail goes while you're building, instead of a
 * provider. Nothing here is configured by the app: the inbox announces itself (the
 * `postboi/vite` plugin serves it and injects its port, or `postboi dev` writes one to a
 * discovery file), and `mail()` notices. Running the inbox *is* the opt-in, so code that
 * sends is identical in dev and production.
 */

/** Where the inbox accepts captured messages, on whichever host is serving it. */
export const INBOX_ENDPOINT = "/__postboi/api/messages"

/** The inbox UI's path, for the notice printed on the first captured send. */
export const INBOX_PATH = "/__postboi"

/**
 * Where `postboi dev` advertises its port, relative to the project root. Inside
 * `node_modules` on purpose: it's machine-local, disposable, and already ignored by git.
 */
export const INBOX_DISCOVERY = "node_modules/.postboi/inbox.json"

/**
 * A non-email capture, normalised into the mail-ish shape the inbox lists by. The other
 * channels' captures are smaller than mail — no cc, no attachments, one body — so they
 * ride the same store with a `channel` marker and their oddities flattened into `meta`.
 */
export interface ChannelCapture {
	channel: Exclude<Channel, "email">
	to: Array<{ address: string }>
	from?: { address: string }
	/** A chat/push title, or the template name — whatever stands in for a subject line. */
	subject?: string
	/** The message body. Plain text on every non-email channel. */
	text?: string
	/** Channel-specific details worth showing (segments, template language, …), in order. */
	meta?: Array<[string, string]>
	scheduled_at?: Date
}

/** A captured message, plus the fields the inbox lists it by. */
export interface InboxMessage extends Omit<
	SentMessage,
	"scheduled_at" | "from" | "attachments" | "subject"
> {
	/** Identifies this capture within one inbox run. */
	id: string
	/** When the inbox received it (epoch ms). */
	received_at: number
	/** Which channel captured this. Absent means email, which predates the field. */
	channel?: Channel
	/** Channel-specific details, rendered as-is by the UI. */
	meta?: Array<[string, string]>
	/** Optional now that texts and chats — which have no sender address, subject line or
	 * files — land in the same store. */
	from?: SentMessage["from"]
	subject?: string
	attachments?: SentMessage["attachments"]
	/**
	 * Requested delivery time, ISO-8601. A string rather than a `Date` because a captured
	 * message reaches the inbox as JSON, and pretending otherwise only moves the parse.
	 */
	scheduled_at?: string
	/**
	 * The id the send returned to the caller, which is what `cancel()` is later given. The
	 * inbox's own {@link InboxMessage.id} is its own numbering and means nothing outside it.
	 */
	send_id?: string
	/** When `cancel()` was called for this message, ISO-8601. */
	cancelled_at?: string
}

/** A reachable inbox: where to look at it, and how to hand it a message. */
export interface Inbox {
	/** The inbox UI, for the notice printed the first time mail is captured. */
	url: string
	/**
	 * Hand over a captured message. False means the inbox didn't take it — the caller
	 * prints the mail instead, and never falls through to sending it for real.
	 *
	 * @param send_id The id handed back to whoever sent it, so a later `cancel()` can be
	 * matched to this message.
	 */
	deliver(message: SentMessage, send_id?: string): Promise<boolean>
	/**
	 * Hand over a non-email capture — a text, a WhatsApp message, a chat post, a push.
	 * Same endpoint and same contract as {@link deliver}, different shape.
	 */
	capture(payload: ChannelCapture): Promise<boolean>
	/**
	 * Tell the inbox a scheduled send was cancelled. Without this the message sits in the
	 * inbox looking like it is still going out, which is the opposite of what happened.
	 */
	cancel(send_id: string): Promise<boolean>
}

/** Where an inbox is listening, and whether getting there means TLS. */
type Target = { port: number; secure: boolean }

let injected: Target | null = null

/**
 * Record the port the inbox is listening on. Called by the `postboi/vite` plugin, which
 * appends the call to this module's source in the SSR build — the same trick
 * {@link set_bundled_config} uses, for the same reason: the plugin runs in Vite's own
 * module registry and your server code runs in another, so a plain call across them would
 * set this on a copy nothing reads.
 *
 * @param secure The dev server is serving over HTTPS, so the inbox is too — it's mounted on
 * that same server. Posting plaintext at a TLS port fails, and the capture would fall back
 * to the console with the mail never reaching the inbox.
 *
 * @internal
 */
export function set_inbox_port(port: number, secure = false): void {
	injected = valid_port(port) ? { port, secure } : null
}

/** Is this an env value asking for the inbox to stay out of the way? */
function is_off(value: string): boolean {
	return /^(off|false|0|no)$/i.test(value)
}

function valid_port(value: number): boolean {
	return Number.isInteger(value) && value > 0 && value < 65536
}

/**
 * Read the port `postboi dev` advertised. Node/Bun only — under Workers there's no
 * filesystem, which is why the Vite plugin injects the port instead.
 */
async function read_discovery(): Promise<Target | null> {
	if (typeof process === "undefined" || !process.versions?.node) return null
	try {
		const { readFileSync } = await import("node:fs")
		const { join } = await import("node:path")
		const raw = readFileSync(join(process.cwd(), INBOX_DISCOVERY), "utf8")
		const written = JSON.parse(raw) as { port?: unknown; secure?: unknown }
		if (typeof written.port !== "number" || !valid_port(written.port)) return null
		return { port: written.port, secure: written.secure === true }
	} catch {
		// Missing (no inbox running), unparseable, or no fs — all mean "no inbox".
		return null
	}
}

/**
 * Find the inbox's port, in precedence order: an explicit `POSTBOI_INBOX` (which can also
 * switch it off), then a port the Vite plugin injected, then the discovery file.
 *
 * Deliberately unmemoised. The inbox can start after the app has already sent — checking
 * each time is one failed `readFileSync` on a path that isn't there, on a code path that
 * only runs in development.
 */
async function discover(): Promise<Target | null> {
	const env = read_env("POSTBOI_INBOX")?.trim()
	if (env) {
		if (is_off(env)) return null
		// A whole URL as well as a bare port, because an https dev server is exactly the case
		// where you might have to say so by hand.
		if (/^https?:\/\//i.test(env)) {
			try {
				const url = new URL(env)
				const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
				return valid_port(port) ? { port, secure: url.protocol === "https:" } : null
			} catch {
				return null
			}
		}
		const port = Number(env)
		return valid_port(port) ? { port, secure: false } : null
	}
	if (injected !== null) return injected
	return read_discovery()
}

/**
 * POST over TLS, ignoring the certificate.
 *
 * A dev server's HTTPS is almost always self-signed, and `fetch` rejects it — which would
 * mean the mail silently going to the console instead of the inbox. Verification buys
 * nothing here anyway: the target is a port on this machine that this process was told
 * about, and the payload is a mail that is explicitly not being sent.
 */
async function post_insecure(port: number, path: string, body: string): Promise<boolean> {
	const https = await import("node:https")
	return new Promise<boolean>((resolve) => {
		const request = https.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers: { "content-type": "application/json" },
				rejectUnauthorized: false,
			},
			(response) => {
				response.resume()
				resolve((response.statusCode ?? 500) < 400)
			}
		)
		request.on("error", () => resolve(false))
		request.end(body)
	})
}

/** POST to a listening inbox. */
async function post(target: Target, path: string, payload: unknown): Promise<boolean> {
	const body = JSON.stringify(payload)
	const scheme = target.secure ? "https" : "http"
	try {
		const response = await fetch(`${scheme}://127.0.0.1:${target.port}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		})
		return response.ok
	} catch {
		// Over TLS the likeliest cause is a certificate nothing trusts, which is worth one more
		// try. Otherwise: a dev server killed hard leaves its port behind in the discovery file.
		if (!target.secure) return false
	}
	try {
		return await post_insecure(target.port, path, body)
	} catch {
		return false
	}
}

/**
 * The inbox to route this send to, or null when none is listening. Callers gate this on
 * development themselves — nothing here checks, so a test can drive it directly.
 */
export async function resolve_inbox(): Promise<Inbox | null> {
	const target = await discover()
	if (target === null) return null
	return {
		url: `${target.secure ? "https" : "http"}://localhost:${target.port}${INBOX_PATH}`,
		deliver: (message, send_id) => post(target, INBOX_ENDPOINT, { ...message, send_id }),
		capture: (payload) => post(target, INBOX_ENDPOINT, payload),
		cancel: (send_id) => post(target, `${INBOX_ENDPOINT}/cancel`, { send_id }),
	}
}
