import net from "node:net"
import tls from "node:tls"
import { randomBytes } from "node:crypto"
import type {
	SendOptions,
	CommonProviderOptions,
	MailAddress,
	MailAttachment,
	PreparedMessage,
	RequestSpec,
	BatchResult,
} from "./index.js"
import { ProviderBase, PostboiError } from "./index.js"

/** Options for the SMTP provider constructor. */
type Options = CommonProviderOptions & {
	/** SMTP server hostname, e.g. "smtp.example.com". */
	host: string
	/** SMTP port. Defaults to 587 (STARTTLS). Use 465 for implicit TLS. */
	port?: number | string
	/** Username for AUTH. Omit for an unauthenticated relay. */
	user?: string
	/** Password for AUTH. */
	pass?: string
	/**
	 * Use implicit TLS from the first byte (port 465). `"auto"` (the default) turns it on
	 * only for port 465; otherwise the connection starts plaintext and upgrades via STARTTLS.
	 */
	secure?: boolean | "auto" | string
}

/** The final SMTP server reply after a successful DATA, e.g. "2.0.0 OK: queued as ABC123". */
type SendResponse = { response: string }

/** Strip CR/LF from a header value — the trust boundary that blocks header injection. */
const clean = (value: string): string => value.replace(/[\r\n]/g, " ")

/** RFC 2047 encode a header word only when it contains non-ASCII. */
function enc_word(value: string): string {
	const v = clean(value)
	// eslint-disable-next-line no-control-regex
	if (/^[\x00-\x7F]*$/.test(v)) return v
	return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`
}

/** Format an address as `Encoded Name <addr>` (or bare `addr`), CR/LF stripped. */
function format_address(a: MailAddress): string {
	return a.name ? `${enc_word(a.name)} <${clean(a.address)}>` : clean(a.address)
}

/** Wrap a base64 string to 76-character lines, as MIME requires. */
const wrap = (b64: string): string => b64.replace(/.{1,76}/g, "$&\r\n").trimEnd()

/** A single MIME entity: its headers (already formatted) and an encoded body. */
type Part = { headers: Array<string>; body: string }

/** A leaf part with base64 transfer encoding from a UTF-8 string. */
function leaf(content_type: string, text: string): Part {
	return {
		headers: [`Content-Type: ${content_type}`, "Content-Transfer-Encoding: base64"],
		body: wrap(Buffer.from(text, "utf8").toString("base64")),
	}
}

/** A leaf part for an attachment (its content is already base64). */
function attachment_part(a: MailAttachment): Part {
	const name = clean(a.name)
	return {
		headers: [
			`Content-Type: ${a.mime_type || "application/octet-stream"}; name="${name}"`,
			"Content-Transfer-Encoding: base64",
			`Content-Disposition: attachment; filename="${name}"`,
		],
		body: wrap(a.content),
	}
}

/** Combine parts under a multipart/* container with a fresh boundary. */
function multipart(subtype: string, parts: Array<Part>): Part {
	const boundary = `=_postboi_${randomBytes(12).toString("hex")}`
	const lines: Array<string> = []
	for (const p of parts) {
		lines.push(`--${boundary}`, ...p.headers, "", p.body)
	}
	lines.push(`--${boundary}--`)
	return {
		headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
		body: lines.join("\r\n"),
	}
}

/**
 * A minimal lock-step SMTP client. SMTP is request/response with no pipelining here, so a
 * single in-flight reader is enough. Owns the socket, STARTTLS upgrade and reply parsing.
 */
class Connection {
	#socket: net.Socket | tls.TLSSocket
	#buffer = ""
	#waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null
	#failure: Error | null = null
	encrypted: boolean

	private constructor(socket: net.Socket | tls.TLSSocket, encrypted: boolean) {
		this.#socket = socket
		this.encrypted = encrypted
		this.#attach(socket)
	}

	#attach(socket: net.Socket | tls.TLSSocket): void {
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

	/** Index in the buffer just past the first complete reply (a `NNN<space>` line), or -1. */
	#complete(): number {
		let pos = 0
		for (;;) {
			const nl = this.#buffer.indexOf("\r\n", pos)
			if (nl === -1) return -1
			if (/^\d{3} /.test(this.#buffer.slice(pos, nl))) return nl + 2
			pos = nl + 2
		}
	}

	#drain(): void {
		if (!this.#waiter) return
		const end = this.#complete()
		if (end === -1) return
		const block = this.#buffer.slice(0, end)
		this.#buffer = this.#buffer.slice(end)
		const lines = block.split("\r\n").filter(Boolean)
		const code = Number(lines[lines.length - 1].slice(0, 3))
		// Reply text drops the leading "NNN-"/"NNN " from each line.
		const text = lines.map((l) => l.slice(4)).join(" ")
		const w = this.#waiter
		this.#waiter = null
		w.resolve({ code, text })
	}

	#read(): Promise<Reply> {
		if (this.#failure) return Promise.reject(this.#failure)
		return new Promise((resolve, reject) => {
			this.#waiter = { resolve, reject }
			this.#drain()
		})
	}

	/** Send a command (if any) and return the reply, asserting it falls in `expect`. */
	async cmd(line: string | null, expect: Array<number>): Promise<Reply> {
		if (line !== null) this.#socket.write(line + "\r\n")
		const reply = await this.#read()
		if (!expect.includes(reply.code)) {
			throw new PostboiError({
				provider: "smtp",
				message: reply.text || `SMTP command rejected (${reply.code})`,
				code: reply.code,
				raw: reply,
			})
		}
		return reply
	}

	/** Upgrade an established plaintext socket to TLS (after a 220 STARTTLS reply). */
	upgrade(host: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const secure = tls.connect({ socket: this.#socket, servername: host }, () => {
				this.#buffer = ""
				this.#socket = secure
				this.encrypted = true
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
	static connect(opts: {
		host: string
		port: number
		secure: boolean
		timeout: number
	}): Promise<Connection> {
		return new Promise((resolve, reject) => {
			const socket = opts.secure
				? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
				: net.connect({ host: opts.host, port: opts.port })
			socket.setTimeout(opts.timeout)
			const event = opts.secure ? "secureConnect" : "connect"
			socket.once("error", reject)
			socket.once(event, () => {
				socket.removeListener("error", reject)
				resolve(new Connection(socket, opts.secure))
			})
		})
	}
}

type Reply = { code: number; text: string }

/**
 * SMTP provider — sends over any SMTP server using only Node's `net`/`tls` (zero deps).
 * Use it for self-hosted mail, providers without an HTTP API, or local dev (e.g. Mailpit).
 *
 * @example
 * ```ts
 * import SMTP from "postboi/smtp"
 *
 * const mail = new SMTP({
 *   host: "smtp.example.com",
 *   port: 587,
 *   user: "apikey",
 *   pass: process.env.SMTP_PASS,
 *   default: { from: "no-reply@example.com" },
 * })
 * await mail.send({ to: "contact@example.com", subject: "Hello", body: "<p>Hi</p>" })
 * ```
 */
export default class SMTP extends ProviderBase<SendResponse> {
	protected readonly provider = "smtp"
	#host: string
	#port: number
	#user?: string
	#pass?: string
	#secure: boolean
	#timeout: number

	constructor({ host, port, user, pass, secure, ...options }: Options) {
		super(options)
		if (!host) {
			throw new PostboiError({ provider: "smtp", message: "SMTP host is required" })
		}
		this.#host = host
		this.#port = Number(port ?? 587)
		this.#user = user || undefined
		this.#pass = pass || undefined
		const sec = secure ?? "auto"
		this.#secure =
			sec === true || sec === "true" || sec === "1"
				? true
				: sec === false || sec === "false" || sec === "0"
					? false
					: this.#port === 465 // "auto"
		this.#timeout = options.timeout ?? 30000
	}

	async send(options: SendOptions): Promise<SendResponse>
	async send(
		options: Array<SendOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<SendResponse>>>
	async send(
		options: SendOptions | Array<SendOptions>,
		batch: { concurrency?: number } = {}
	): Promise<SendResponse | Array<BatchResult<SendResponse>>> {
		if (Array.isArray(options)) return this.send_batch(options, batch)
		return this.with_hooks(options, (message) => this.#deliver(message))
	}

	/** Build the RFC 5322 message body (headers + MIME) from a prepared message. */
	async #compose(message: PreparedMessage): Promise<string> {
		const from = this.parse_email_address(message.from)
		const to = this.parse_addresses(message.to)
		const cc = message.cc ? this.parse_addresses(message.cc) : []
		const reply_to = message.reply_to ? this.parse_addresses(message.reply_to) : []

		const text_part = message.text ? leaf("text/plain; charset=utf-8", message.text) : undefined
		const html_part = message.html ? leaf("text/html; charset=utf-8", message.html) : undefined
		let content: Part =
			text_part && html_part
				? multipart("alternative", [text_part, html_part])
				: (html_part ?? text_part ?? leaf("text/plain; charset=utf-8", ""))

		if (message.attachments) {
			const atts = (await this.parse_attachments(message.attachments)).map(attachment_part)
			content = multipart("mixed", [content, ...atts])
		}

		const headers: Array<string> = [
			`From: ${format_address(from)}`,
			`To: ${to.map(format_address).join(", ")}`,
		]
		if (cc.length) headers.push(`Cc: ${cc.map(format_address).join(", ")}`)
		if (reply_to.length) headers.push(`Reply-To: ${reply_to.map(format_address).join(", ")}`)
		headers.push(
			`Subject: ${enc_word(message.subject)}`,
			`Date: ${new Date().toUTCString()}`,
			`Message-ID: <${randomBytes(16).toString("hex")}@${from.address.split("@")[1] ?? "postboi"}>`,
			"MIME-Version: 1.0"
		)
		for (const [name, value] of Object.entries(message.headers ?? {})) {
			headers.push(`${clean(name)}: ${clean(value)}`)
		}

		return [...headers, ...content.headers, "", content.body].join("\r\n")
	}

	async #deliver(message: PreparedMessage): Promise<SendResponse> {
		const from = this.parse_email_address(message.from)
		const recipients = [
			...this.parse_addresses(message.to),
			...(message.cc ? this.parse_addresses(message.cc) : []),
			...(message.bcc ? this.parse_addresses(message.bcc) : []),
		]
		const raw = await this.#compose(message)

		const conn = await Connection.connect({
			host: this.#host,
			port: this.#port,
			secure: this.#secure,
			timeout: this.#timeout,
		}).catch((e: Error) => {
			throw new PostboiError({
				provider: "smtp",
				message: `SMTP connection failed: ${e.message}`,
				raw: e,
			})
		})

		try {
			await conn.cmd(null, [220]) // greeting
			let caps = await this.#ehlo(conn)

			if (!conn.encrypted && caps.has("STARTTLS")) {
				await conn.cmd("STARTTLS", [220])
				await conn.upgrade(this.#host)
				caps = await this.#ehlo(conn)
			}

			if (this.#user && this.#pass) {
				if (!conn.encrypted) {
					throw new PostboiError({
						provider: "smtp",
						message: "Refusing to send credentials over an unencrypted connection",
						code: "insecure_auth",
					})
				}
				await this.#auth(conn, caps)
			}

			await conn.cmd(`MAIL FROM:<${clean(from.address)}>`, [250])
			for (const r of recipients) await conn.cmd(`RCPT TO:<${clean(r.address)}>`, [250, 251])
			await conn.cmd("DATA", [354])
			// Dot-stuff and terminate the DATA payload.
			const reply = await conn.cmd(raw.replace(/^\./gm, "..") + "\r\n.", [250])
			conn.cmd("QUIT", [221]).catch(() => {})
			return { response: reply.text }
		} finally {
			conn.destroy()
		}
	}

	/** EHLO and return the advertised capabilities (upper-cased, first token per line). */
	async #ehlo(conn: Connection): Promise<Set<string>> {
		const reply = await conn.cmd(`EHLO ${this.#ehlo_name()}`, [250])
		return new Set(reply.text.toUpperCase().split(" "))
	}

	#ehlo_name(): string {
		// A bare hostname is enough; brackets keep odd hostnames valid.
		return this.#host.includes(".") ? this.#host : `[${this.#host}]`
	}

	async #auth(conn: Connection, caps: Set<string>): Promise<void> {
		const user = this.#user!
		const pass = this.#pass!
		if (caps.has("LOGIN") && !caps.has("PLAIN")) {
			await conn.cmd("AUTH LOGIN", [334])
			await conn.cmd(Buffer.from(user).toString("base64"), [334])
			await conn.cmd(Buffer.from(pass).toString("base64"), [235])
			return
		}
		const token = Buffer.from(`\0${user}\0${pass}`).toString("base64")
		await conn.cmd(`AUTH PLAIN ${token}`, [235])
	}

	// SMTP is not HTTP — the request hooks of ProviderBase are unused.
	protected build_request(): RequestSpec {
		throw new Error("smtp provider does not build HTTP requests")
	}

	protected parse_response(): SendResponse {
		throw new Error("smtp provider does not parse HTTP responses")
	}
}
