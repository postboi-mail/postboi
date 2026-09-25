/**
 * A minimal POP3 client (RFC 1939 + the RFC 2595 STLS upgrade) — just enough to read a
 * bounce mailbox: greeting, STLS, USER/PASS, UIDL, RETR, DELE, QUIT. Zero dependencies,
 * mirroring the SMTP provider's hand-rolled connection.
 */
import type { Socket } from "node:net"
import type { TLSSocket } from "node:tls"
import { PostboiError } from "../index.js"

// node:net/node:tls are loaded lazily (same pattern as smtp.ts) so bundlers targeting
// non-node platforms can bundle postboi/webhooks without resolving them. esbuild demotes
// an unresolvable dynamic import to a warning only when it sits in a try block, so the
// try is load-bearing. Every socket is created via Pop3Connection.connect, which loads
// both before anything touches them.
let net: typeof import("node:net") | undefined
let tls: typeof import("node:tls") | undefined
async function load_node(): Promise<void> {
	if (net && tls) return
	try {
		net = await import("node:net")
		tls = await import("node:tls")
	} catch {
		throw new PostboiError({
			provider: "smtp",
			message:
				"The POP3 poller needs a Node.js runtime, and node:net/node:tls are unavailable here.",
			code: "node_required",
		})
	}
}

const CRLF = "\r\n"
const TERMINATOR = "\r\n.\r\n"

/**
 * A lock-step POP3 connection: one command in flight, replies read as either a single
 * `+OK`/`-ERR` line or a dot-terminated multi-line block. Owns the socket and the STLS
 * upgrade.
 */
export class Pop3Connection {
	#socket: Socket | TLSSocket
	#buffer = ""
	#waiter: { multi: boolean; resolve: (r: string) => void; reject: (e: Error) => void } | null =
		null
	#failure: Error | null = null

	private constructor(socket: Socket | TLSSocket) {
		this.#socket = socket
		this.#attach(socket)
	}

	#attach(socket: Socket | TLSSocket): void {
		socket.setEncoding("utf8")
		socket.on("data", (chunk: string) => {
			this.#buffer += chunk
			this.#drain()
		})
		socket.on("error", (e: Error) => this.#fail(e))
		socket.on("close", () => this.#fail(new Error("connection closed")))
		socket.on("timeout", () => {
			socket.destroy()
			this.#fail(new Error("connection timed out"))
		})
	}

	#fail(error: Error): void {
		this.#failure ??= error
		const w = this.#waiter
		this.#waiter = null
		w?.reject(error)
	}

	#drain(): void {
		const w = this.#waiter
		if (!w) return
		// An -ERR reply is always a single line, even for multi-line commands.
		const line_end = this.#buffer.indexOf(CRLF)
		if (line_end === -1) return
		const first = this.#buffer.slice(0, line_end)
		if (w.multi && first.startsWith("+OK")) {
			const end = this.#buffer.indexOf(TERMINATOR)
			if (end === -1) return
			const block = this.#buffer.slice(0, end)
			this.#buffer = this.#buffer.slice(end + TERMINATOR.length)
			this.#waiter = null
			w.resolve(block)
			return
		}
		this.#buffer = this.#buffer.slice(line_end + CRLF.length)
		this.#waiter = null
		w.resolve(first)
	}

	#read(multi: boolean): Promise<string> {
		if (this.#failure) return Promise.reject(this.#failure)
		return new Promise((resolve, reject) => {
			this.#waiter = { multi, resolve, reject }
			this.#drain()
		})
	}

	async #exchange(line: string | null, multi: boolean): Promise<string> {
		if (line !== null) this.#socket.write(line + CRLF)
		const reply = await this.#read(multi)
		if (!reply.startsWith("+OK")) {
			throw new PostboiError({
				provider: "smtp",
				message: reply.replace(/^-ERR\s*/, "") || "POP3 command rejected",
				code: "pop3_error",
				raw: reply,
			})
		}
		return reply
	}

	/** Send a command expecting a single-line reply; throws on `-ERR`. */
	cmd(line: string | null): Promise<string> {
		return this.#exchange(line, false)
	}

	/**
	 * Send a command expecting a multi-line reply; returns the data after the `+OK` line
	 * with byte-stuffed leading dots undone, throws on `-ERR`.
	 */
	async cmd_multi(line: string): Promise<string> {
		const block = await this.#exchange(line, true)
		const nl = block.indexOf(CRLF)
		// An empty listing is just "+OK" before the terminator — no data line at all.
		const data = nl === -1 ? "" : block.slice(nl + CRLF.length)
		return data.replace(/^\.\./gm, ".")
	}

	/** Upgrade an established plaintext socket to TLS (after a +OK STLS reply). */
	upgrade(host: string): Promise<void> {
		return new Promise((resolve, reject) => {
			// tls! — a Pop3Connection only exists after connect ran load_node().
			const secure = tls!.connect({ socket: this.#socket, servername: host }, () => {
				this.#buffer = ""
				this.#socket = secure
				this.#attach(secure)
				resolve()
			})
			secure.once("error", reject)
		})
	}

	destroy(): void {
		this.#socket.destroy()
	}

	/** Open a connection and read the server greeting. */
	static async connect(opts: {
		host: string
		port: number
		secure: boolean
		timeout: number
	}): Promise<Pop3Connection> {
		await load_node()
		return new Promise((resolve, reject) => {
			const socket = opts.secure
				? tls!.connect({ host: opts.host, port: opts.port, servername: opts.host })
				: net!.connect({ host: opts.host, port: opts.port })
			socket.setTimeout(opts.timeout)
			const event = opts.secure ? "secureConnect" : "connect"
			socket.once("error", reject)
			socket.once(event, () => {
				socket.removeListener("error", reject)
				resolve(new Pop3Connection(socket))
			})
		})
	}
}

/** Open, upgrade (implicit TLS or STLS) and authenticate a POP3 session. */
export async function pop3_session(opts: {
	host: string
	port: number
	secure: boolean
	user: string
	pass: string
	timeout: number
}): Promise<Pop3Connection> {
	const connection = await Pop3Connection.connect(opts)
	try {
		await connection.cmd(null) // greeting
		if (!opts.secure) {
			// Opportunistic upgrade, same posture as the SMTP provider's STARTTLS: servers
			// that don't offer STLS answer -ERR and the session continues in plaintext.
			const stls = await connection.cmd("STLS").catch(() => undefined)
			if (stls !== undefined) await connection.upgrade(opts.host)
		}
		await connection.cmd(`USER ${opts.user}`)
		await connection.cmd(`PASS ${opts.pass}`)
		return connection
	} catch (error) {
		connection.destroy()
		throw error
	}
}
