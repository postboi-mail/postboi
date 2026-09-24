import { ensure_env_loaded, read_env } from "./env.js"
import { PostboiError } from "./errors.js"

/**
 * `postboi/inbox`: throwaway inboxes at tempboi.email, for tests and agents that need to
 * receive a real email (a sign-up code, a magic link) without an account.
 *
 * Only `fetch`, so it runs in Node, Bun, Deno and Workers. The wire is snake_case and
 * stays in this file; what callers see is single words (`mail.name`, `mail.received` as
 * a Date). Waiting is long-polling rather than a socket on purpose: it gets through the
 * proxies in front of agent sandboxes and CI.
 */

/** Where anonymous inboxes live. `POSTBOI_INBOX_URL` or `base` points elsewhere. */
export const TEMP_INBOX_URL = "https://tempboi.email"

/** How long one long-poll holds, in seconds. The server's own ceiling is 25. */
const POLL_SECONDS = 25
/** The server's ceiling on one `/wait`, in seconds. */
const WAIT_SECONDS = 90
/** Slack on top of a long-poll's own hold before we call the request lost. */
const GRACE_MS = 15_000

/**
 * A duration: a number of **milliseconds**, like `setTimeout`, or a string the server
 * would read (`"90s"`, `"15m"`, `"2h"`, `"1d"`, `"500ms"`).
 */
export type Duration = number | string

/** Text to match: a case-insensitive substring, or a RegExp tested here in the client. */
export type Match = string | RegExp

/** Failure talking to tempboi.email. `code` is the server's (`not_found`, `invalid_token`, …). */
export class InboxError extends PostboiError {
	constructor(args: { message: string; status?: number; code?: string; raw?: unknown }) {
		super({ provider: "tempboi", channel: "email", ...args })
		this.name = "InboxError"
	}
}

/** `inbox.wait()` ran out of time. `cursor` is where the inbox stood, for a later `after`. */
export class InboxTimeoutError extends InboxError {
	readonly cursor: number
	constructor(message: string, cursor: number) {
		super({ message, code: "timeout", status: 408 })
		this.name = "InboxTimeoutError"
		this.cursor = cursor
	}
}

// ---------------------------------------------------------------------------------------
// The wire. Internal: nothing below is exported under these names.

interface WireInbox {
	address: string
	token?: string
	domain: string
	created: string
	expires: string
	count: number
	/** The highest `seq` filed so far. */
	cursor: number
	urls: { web: string; messages: string; wait: string }
}

type WireLink = { url: string; text: string | null; kind: "verify" | "unsubscribe" | "other" }
type WireAttachment = { filename: string | null; type: string; size: number; url: string }

interface WireSummary {
	id: string
	seq: number
	to: string
	tag: string | null
	from: string
	from_name: string | null
	subject: string | null
	text: string | null
	received: string
	code: string | null
	codes: Array<string>
	link: string | null
	links: Array<WireLink>
	auth: { spf?: string; dkim?: string; dmarc?: string }
	attachments: Array<WireAttachment>
	size: number
	truncated: boolean
}

interface WireMessage extends WireSummary {
	html: string | null
	headers: Array<[string, string]>
	urls: { raw: string }
}

interface WirePage {
	data: Array<WireSummary>
	/** The highest `seq` among `data`, or the `after` that was asked for when there's none. */
	cursor: number
	expires?: string
}

// ---------------------------------------------------------------------------------------

/** `"15m"` → 900000. Numbers are already milliseconds. */
export function duration_ms(value: Duration): number {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0) throw new TypeError(`Invalid duration: ${value}`)
		return value
	}
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(value)
	if (!match) throw new TypeError(`Invalid duration: "${value}" (try "90s", "15m", "2h" or "1d")`)
	const unit = (match[2] ?? "s").toLowerCase()
	const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000
	return Math.round(Number(match[1]) * scale)
}

/** A mail as the caller sees it. */
export class Mail {
	/** `tmsg_…` */
	readonly id: string
	/** Its place in the inbox: starts at 1 and only goes up. */
	readonly seq: number
	/** The exact address it was sent to, plus-tag included. */
	readonly to: string
	/** The plus-tag it arrived under (`signup` from `…+signup@…`), or null. */
	readonly tag: string | null
	/** The sender's address. */
	readonly from: string
	/** The sender's display name, when there was one. */
	readonly name: string | null
	readonly subject: string | null
	readonly text: string | null
	/** As received and **not sanitised**: render it sandboxed. Null on a partial mail. */
	readonly html: string | null
	readonly headers: Array<[string, string]>
	readonly received: Date
	/** The best one-time code found in it, e.g. "482913". */
	readonly code: string | null
	readonly codes: Array<string>
	/** The best verify / magic / confirm link, tracking redirects unwrapped. */
	readonly link: string | null
	readonly links: Array<{
		url: string
		text: string | null
		kind: "verify" | "unsubscribe" | "other"
	}>
	readonly auth: { spf?: string; dkim?: string; dmarc?: string }
	readonly attachments: Array<{ filename: string | null; type: string; size: number; url: string }>
	/** Size of the raw message in bytes. */
	readonly size: number
	/** The text and HTML were cut to fit; `raw()` is whole. */
	readonly truncated: boolean
	/**
	 * True when this came from a listing, which carries no `html` or `headers`:
	 * `inbox.read(mail.id)` has the rest.
	 */
	readonly partial: boolean
	readonly #inbox: Inbox

	/** @internal */
	constructor(inbox: Inbox, wire: WireSummary | WireMessage) {
		this.#inbox = inbox
		const full = "headers" in wire
		this.id = wire.id
		this.seq = wire.seq
		this.to = wire.to
		this.tag = wire.tag ?? null
		this.from = wire.from
		this.name = wire.from_name ?? null
		this.subject = wire.subject ?? null
		this.text = wire.text ?? null
		this.html = full ? (wire.html ?? null) : null
		this.headers = full ? (wire.headers ?? []) : []
		this.received = new Date(wire.received)
		this.code = wire.code ?? null
		this.codes = wire.codes ?? []
		this.link = wire.link ?? null
		this.links = wire.links ?? []
		this.auth = wire.auth ?? {}
		this.attachments = (wire.attachments ?? []).map((file) => ({
			...file,
			url: new URL(file.url, inbox.base).toString(),
		}))
		this.size = wire.size ?? 0
		this.truncated = wire.truncated ?? false
		this.partial = !full
	}

	/** The first header of that name (case-insensitive), or undefined. */
	header(name: string): string | undefined {
		const lower = name.toLowerCase()
		return this.headers.find(([key]) => key.toLowerCase() === lower)?.[1]
	}

	/** The whole message as it arrived: the bytes of the `.eml`. */
	async raw(): Promise<Uint8Array> {
		const response = await this.#inbox.request(`/messages/${encodeURIComponent(this.id)}/raw`)
		return new Uint8Array(await response.arrayBuffer())
	}

	toJSON() {
		return {
			id: this.id,
			seq: this.seq,
			to: this.to,
			tag: this.tag,
			from: this.from,
			name: this.name,
			subject: this.subject,
			received: this.received.toISOString(),
			code: this.code,
			codes: this.codes,
			link: this.link,
			links: this.links,
			text: this.text,
			html: this.html,
			headers: this.headers,
			auth: this.auth,
			attachments: this.attachments,
			size: this.size,
			truncated: this.truncated,
			partial: this.partial,
		}
	}
}

/** What to wait for, or what to watch. Every field narrows; none is required. */
export interface MailFilter {
	/** The plus-tag, exactly. */
	tag?: string
	/** Sender address or name: a case-insensitive substring, or a RegExp. */
	from?: Match
	/** Subject: a case-insensitive substring, or a RegExp. */
	subject?: Match
}

export interface WaitOptions extends MailFilter {
	/** How long before giving up with an {@link InboxTimeoutError}. Default 60 seconds. */
	timeout?: Duration
	/**
	 * Only mail with a `seq` above this counts. Default 0, so mail that already arrived
	 * counts too: the usual flow is "sign up, then wait".
	 */
	after?: number
	signal?: AbortSignal
}

export interface WatchOptions extends MailFilter {
	/** Start after this `seq`. Default: the inbox as it stands, so only new mail. */
	after?: number
	/** Yield what's already in the inbox first. Ignored when `after` is given. */
	all?: boolean
	/** Stop watching. The loop ends quietly rather than throwing. */
	signal?: AbortSignal
}

export interface TempOptions {
	/** How long the inbox lives. Default 1h; at most 24h anonymous, 7d on your own domain. */
	ttl?: Duration
	/** A readable prefix: `"signup"` gives `signup-k3f9@tempboi.email`. */
	name?: string
	/** Default `POSTBOI_INBOX_URL`, then https://tempboi.email. */
	base?: string
	/** Your own receiving domain (`reply.example.com`). Needs `key`. */
	domain?: string
	/** A Postboi API key, for an inbox on `domain`. Default `POSTBOI_TOKEN`. */
	key?: string
	/** A fetch of your own (a proxy, a test double). */
	fetch?: typeof fetch
}

export interface AttachOptions {
	/** Default `POSTBOI_INBOX`. Optional: the token alone finds its inbox. */
	address?: string
	/** Default `POSTBOI_INBOX_TOKEN`. */
	token?: string
	/** Default `POSTBOI_INBOX_URL`, then https://tempboi.email. */
	base?: string
	fetch?: typeof fetch
}

function base_url(base: string | undefined): string {
	return (base ?? read_env("POSTBOI_INBOX_URL") ?? TEMP_INBOX_URL).replace(/\/+$/, "")
}

function matches(value: string | null, match: Match | undefined): boolean {
	if (match === undefined) return true
	if (typeof match === "string") return (value ?? "").toLowerCase().includes(match.toLowerCase())
	match.lastIndex = 0
	return match.test(value ?? "")
}

/** Does a mail pass a filter? `from` is tested against the address and the name. */
export function filter_mail(
	mail: { tag: string | null; from: string; name: string | null; subject: string | null },
	filter: MailFilter
): boolean {
	if (filter.tag !== undefined && mail.tag !== filter.tag) return false
	if (filter.from !== undefined) {
		const who = mail.name ? `${mail.name} <${mail.from}>` : mail.from
		if (!matches(who, filter.from)) return false
	}
	return matches(mail.subject, filter.subject)
}

/** The filter's string parts, which the server can apply itself. */
function server_filter(filter: MailFilter): Record<string, string> {
	const out: Record<string, string> = {}
	if (filter.tag !== undefined) out.tag = filter.tag
	if (typeof filter.from === "string") out.from = filter.from
	if (typeof filter.subject === "string") out.subject = filter.subject
	return out
}

function aborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted ?? false
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms)
		signal?.addEventListener("abort", done, { once: true })
		function done() {
			clearTimeout(timer)
			signal?.removeEventListener("abort", done)
			resolve()
		}
	})
}

/**
 * A request that gave out rather than was refused: worth another go in a watch loop.
 * That includes our own ceiling (`with_deadline`) firing on a long-poll a proxy swallowed,
 * which rejects with a `TimeoutError`, not a `TypeError`.
 */
function transient(error: unknown): boolean {
	if (error instanceof InboxError) return !error.status || error.status >= 500
	if (error instanceof Error && error.name === "TimeoutError") return true
	return error instanceof TypeError
}

/** One throwaway inbox. Made by {@link temp} or `temp.attach`. */
export class Inbox {
	/** `quiet-otter-k3f9@tempboi.email` */
	readonly address: string
	/** `tb_…`: reading the inbox needs it. */
	readonly token: string
	readonly base: string
	domain: string
	created: Date
	expires: Date
	/** How many messages it held when last asked. Deleting mail makes this differ from `cursor`. */
	count: number
	/**
	 * The highest `seq` filed when last asked (`info()` refreshes it). Pass it as `after`
	 * to insist on mail that arrives from now on.
	 */
	cursor: number
	/** `web` is the inbox's page, token included after the `#`. */
	urls: { web: string; messages: string; wait: string }
	readonly #fetch: typeof fetch
	#deleted = false

	/** @internal */
	constructor(wire: WireInbox, token: string, base: string, fetcher: typeof fetch) {
		this.address = wire.address
		this.token = token
		this.base = base
		this.#fetch = fetcher
		this.domain = wire.domain
		this.created = new Date(wire.created)
		this.expires = new Date(wire.expires)
		this.count = wire.count ?? 0
		this.cursor = wire.cursor ?? 0
		this.urls = wire.urls
	}

	/** @internal Refresh from a server answer. */
	update(wire: WireInbox): void {
		this.domain = wire.domain ?? this.domain
		this.expires = new Date(wire.expires)
		this.count = wire.count ?? this.count
		this.cursor = Math.max(this.cursor, wire.cursor ?? 0)
		if (wire.urls) this.urls = wire.urls
	}

	/** The address with a plus-tag: `inbox.tag("signup")` → `quiet-otter-k3f9+signup@tempboi.email`. */
	tag(tag: string): string {
		const at = this.address.lastIndexOf("@")
		return `${this.address.slice(0, at)}+${tag}${this.address.slice(at)}`
	}

	/** @internal Every request goes through here, with the token, and fails as an InboxError. */
	async request(
		path: string,
		init: RequestInit & { query?: Record<string, string | number | undefined> } = {}
	): Promise<Response> {
		const url = new URL(`${this.base}/v1/inboxes/${encodeURIComponent(this.address)}${path}`)
		for (const [key, value] of Object.entries(init.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value))
		}
		const { query: _query, ...rest } = init
		const headers = new Headers(rest.headers)
		headers.set("authorization", `Bearer ${this.token}`)
		if (!headers.has("accept")) headers.set("accept", "application/json")
		const response = await this.#fetch(url, { ...rest, headers })
		if (!response.ok && response.status !== 408) throw await failure(response)
		return response
	}

	/**
	 * Wait for a mail and return it: the newest match with a `seq` above `after`.
	 * String filters go to the server's own `/wait`; a RegExp can't, so that path
	 * long-polls the inbox and tests each arrival here.
	 */
	async wait(options: WaitOptions = {}): Promise<Mail> {
		const deadline = Date.now() + duration_ms(options.timeout ?? 60_000)
		const regex = options.from instanceof RegExp || options.subject instanceof RegExp
		return regex ? this.#wait_polling(options, deadline) : this.#wait_server(options, deadline)
	}

	async #wait_server(options: WaitOptions, deadline: number): Promise<Mail> {
		const query = server_filter(options)
		let cursor = options.after ?? 0
		for (;;) {
			if (aborted(options.signal)) throw options.signal!.reason
			const left = deadline - Date.now()
			if (left <= 0) throw timed_out(options, cursor)
			const seconds = Math.max(1, Math.min(WAIT_SECONDS, Math.ceil(left / 1000)))
			const response = await this.request("/wait", {
				query: { ...query, after: options.after, timeout: seconds },
				signal: with_deadline(options.signal, seconds * 1000 + GRACE_MS),
			})
			const body = (await response.json()) as WireMessage | { code: string; cursor?: number }
			if (response.status === 408) {
				cursor = (body as { cursor?: number }).cursor ?? cursor
				continue
			}
			return new Mail(this, body as WireMessage)
		}
	}

	async #wait_polling(options: WaitOptions, deadline: number): Promise<Mail> {
		const query = server_filter(options)
		let cursor = options.after ?? 0
		for (;;) {
			if (aborted(options.signal)) throw options.signal!.reason
			const left = deadline - Date.now()
			if (left <= 0) throw timed_out(options, cursor)
			const seconds = Math.max(0, Math.min(POLL_SECONDS, Math.floor(left / 1000)))
			const page = await this.#page(cursor, seconds, query, options.signal)
			const hits = page.data
				.map((summary) => new Mail(this, summary))
				.filter((mail) => mail.seq > cursor && filter_mail(mail, options))
			cursor = Math.max(cursor, page.cursor)
			if (hits.length) {
				const newest = hits.reduce((a, b) => (b.seq > a.seq ? b : a))
				return this.read(newest.id)
			}
			// A zero-second poll answers at once; don't spin through the last second.
			if (seconds === 0) await sleep(Math.min(left, 250), options.signal)
		}
	}

	async #page(
		after: number,
		wait: number,
		query: Record<string, string>,
		signal: AbortSignal | undefined
	): Promise<WirePage> {
		const response = await this.request("/messages", {
			query: { ...query, after, wait },
			signal: with_deadline(signal, wait * 1000 + GRACE_MS),
		})
		const page = (await response.json()) as WirePage
		if (page.expires) this.expires = new Date(page.expires)
		this.cursor = Math.max(this.cursor, page.cursor ?? 0)
		return page
	}

	/** Every mail in the inbox, oldest first. These are partial: no `html` or `headers`. */
	async list(filter: MailFilter & { after?: number } = {}): Promise<Array<Mail>> {
		const page = await this.#page(filter.after ?? 0, 0, server_filter(filter), undefined)
		return page.data
			.map((summary) => new Mail(this, summary))
			.filter((mail) => filter_mail(mail, filter))
			.sort((a, b) => a.seq - b.seq)
	}

	/** One mail, whole. */
	async read(id: string): Promise<Mail> {
		const response = await this.request(`/messages/${encodeURIComponent(id)}`)
		return new Mail(this, (await response.json()) as WireMessage)
	}

	/**
	 * Every mail as it arrives, whole, for as long as you keep reading or until `signal`
	 * aborts. A request that drops is retried with a backoff; a refusal (the inbox
	 * expired, the token is wrong) ends the loop by throwing.
	 */
	async *watch(options: WatchOptions = {}): AsyncGenerator<Mail, void, undefined> {
		const query = server_filter(options)
		let cursor = options.after ?? 0
		let backoff = 0
		if (options.after === undefined && options.all) {
			const first = await this.#page(0, 0, query, options.signal)
			for (const summary of first.data.sort((a, b) => a.seq - b.seq)) {
				const mail = new Mail(this, summary)
				if (filter_mail(mail, options)) yield await this.read(mail.id)
			}
			cursor = first.cursor
		} else if (options.after === undefined) {
			// Where the inbox stands now: `cursor`, never `count`, which deletions shrink.
			cursor = (await this.info()).cursor
		}
		while (!aborted(options.signal)) {
			let page: WirePage
			try {
				page = await this.#page(cursor, POLL_SECONDS, query, options.signal)
				backoff = 0
			} catch (error) {
				if (aborted(options.signal)) return
				if (!transient(error) || backoff >= 6) throw error
				await sleep(Math.min(30_000, 500 * 2 ** backoff++), options.signal)
				continue
			}
			for (const summary of page.data.sort((a, b) => a.seq - b.seq)) {
				if (summary.seq <= cursor) continue
				const mail = new Mail(this, summary)
				if (filter_mail(mail, options)) yield await this.read(mail.id)
			}
			cursor = Math.max(cursor, page.cursor)
		}
	}

	/** Push the expiry out: it becomes now + `ttl`, capped at the inbox's maximum lifetime. */
	async extend(ttl: Duration): Promise<Date> {
		const response = await this.request("", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ttl: Math.round(duration_ms(ttl) / 1000) }),
		})
		this.update((await response.json()) as WireInbox)
		return this.expires
	}

	/** Refresh `expires` and `count` from the server. */
	async info(): Promise<this> {
		const response = await this.request("")
		this.update((await response.json()) as WireInbox)
		return this
	}

	/** Delete the inbox and everything in it. Deleting one that's already gone is fine. */
	async delete(): Promise<void> {
		if (this.#deleted) return
		try {
			await this.request("", { method: "DELETE" })
		} catch (error) {
			if (!(error instanceof InboxError && error.status === 404)) throw error
		}
		this.#deleted = true
	}

	/**
	 * `await using inbox = await temp()` deletes it on the way out. A failure here is
	 * swallowed: it would hide the error that ended the block, and the inbox expires anyway.
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		await this.delete().catch(() => {})
	}

	toJSON() {
		return {
			address: this.address,
			token: this.token,
			expires: this.expires.toISOString(),
			base: this.base,
			web: this.urls?.web,
		}
	}
}

function timed_out(options: WaitOptions, cursor: number): InboxTimeoutError {
	const parts = [
		options.tag !== undefined && `tag ${options.tag}`,
		options.from !== undefined && `from ${options.from}`,
		options.subject !== undefined && `subject ${options.subject}`,
	].filter(Boolean)
	const what = parts.length ? ` matching ${parts.join(", ")}` : ""
	return new InboxTimeoutError(`No mail${what} arrived in time`, cursor)
}

/** The caller's signal, plus a ceiling so a long-poll a proxy swallowed can't hang forever. */
function with_deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms)
	return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function failure(response: Response): Promise<InboxError> {
	let body: unknown
	try {
		body = await response.json()
	} catch {
		body = undefined
	}
	const { message, code } = (body ?? {}) as { message?: string; code?: string }
	return new InboxError({
		message: message ?? `tempboi answered ${response.status}`,
		status: response.status,
		code: code ?? (response.status === 404 ? "not_found" : undefined),
		raw: body,
	})
}

async function create(options: TempOptions = {}): Promise<Inbox> {
	// The environment mail() reads: process.env, Worker bindings, and .env / .dev.vars in dev,
	// so a POSTBOI_TOKEN that sends mail also makes inboxes on your own domain.
	await ensure_env_loaded()
	const base = base_url(options.base)
	const fetcher = options.fetch ?? globalThis.fetch
	const key = options.domain ? (options.key ?? read_env("POSTBOI_TOKEN")) : options.key
	const body: Record<string, unknown> = {}
	if (options.name) body.name = options.name
	if (options.ttl !== undefined) body.ttl = Math.round(duration_ms(options.ttl) / 1000)
	if (options.domain) body.domain = options.domain
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json",
	}
	if (key) headers.authorization = `Bearer ${key}`
	const response = await fetcher(`${base}/v1/inboxes`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	})
	if (!response.ok) throw await failure(response)
	const wire = (await response.json()) as WireInbox
	if (!wire.token) throw new InboxError({ message: "tempboi answered without a token", raw: wire })
	return new Inbox(wire, wire.token, base, fetcher)
}

/**
 * Reconnect to an inbox made elsewhere: another process, a CI step, `postboi inbox new --env`.
 * Checks the token by asking for the inbox, so a wrong one fails here and not later.
 */
async function attach(options: AttachOptions = {}): Promise<Inbox> {
	await ensure_env_loaded()
	// POSTBOI_INBOX is also the dev inbox's port or `off`, so it only counts as an address.
	const from_env = read_env("POSTBOI_INBOX")
	const address = options.address || (from_env?.includes("@") ? from_env : undefined)
	const token = options.token || read_env("POSTBOI_INBOX_TOKEN")
	if (!token)
		throw new InboxError({
			message: "No inbox token: pass token or set POSTBOI_INBOX_TOKEN",
			code: "missing_token",
		})
	const base = base_url(options.base)
	const fetcher = options.fetch ?? globalThis.fetch
	// The token alone names its inbox, so an address is only a check that they agree.
	if (!address) {
		const response = await fetcher(`${base}/v1/inboxes`, {
			headers: { authorization: `Bearer ${token}`, accept: "application/json" },
		})
		if (!response.ok) throw await failure(response)
		return new Inbox((await response.json()) as WireInbox, token, base, fetcher)
	}
	const placeholder: WireInbox = {
		address,
		domain: address.slice(address.lastIndexOf("@") + 1),
		created: new Date().toISOString(),
		expires: new Date().toISOString(),
		count: 0,
		cursor: 0,
		urls: { web: "", messages: "", wait: "" },
	}
	return new Inbox(placeholder, token, base, fetcher).info()
}

/**
 * A throwaway inbox at tempboi.email, no account needed.
 *
 * ```ts
 * await using inbox = await temp({ ttl: "15m" })
 * await page.fill("#email", inbox.address)
 * const mail = await inbox.wait({ subject: "Verify" })
 * mail.code // "482913"
 * ```
 */
export const temp: {
	(options?: TempOptions): Promise<Inbox>
	/** Reconnect to an existing inbox. Defaults from `POSTBOI_INBOX` / `POSTBOI_INBOX_TOKEN` / `POSTBOI_INBOX_URL`. */
	attach(options?: AttachOptions): Promise<Inbox>
} = Object.assign(create, { attach })

export default temp
