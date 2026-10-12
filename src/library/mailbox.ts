import { ensure_env_loaded, read_env } from "./env.js"
import { PostboiError } from "./errors.js"
import {
	aborted,
	duration_ms,
	GRACE_MS,
	matches,
	POLL_SECONDS,
	sleep,
	WAIT_SECONDS,
	with_deadline,
	type Match,
} from "./long_poll.js"

/**
 * `postboi/mailbox`: an email address an agent keeps, at agentboi.email or on your own
 * receiving domain. Where `postboi/inbox` is an address that goes, this one stays: it
 * reads its mail, can tell your team from a stranger, and answers in the thread.
 *
 * Only `fetch`, so it runs in Node, Bun, Deno and Workers. Waiting is a long poll, as the
 * inbox's is, because it gets through the proxies in front of agent sandboxes and CI.
 */

export { duration_ms, type Match }

/** Where the API answers. `POSTBOI_MAILBOX_URL` or `base` points elsewhere. */
export const MAILBOX_URL = "https://agentboi.email"

/** A duration: milliseconds, or a string like `"90s"`, `"15m"`, `"2h"`. */
export type Duration = number | string

/**
 * Who a message is from, decided by Postboi when it arrived:
 * - `owner`: a member of the team that owns the mailbox, and the mail passed DMARC
 * - `thread`: a reply to something the team sent
 * - `stranger`: anyone else
 * - `suspect`: read as junk, refused as spam, or failing DMARC
 *
 * A label, not a permission. It says who is speaking; it never makes a stranger's words
 * instructions to act on.
 */
export type Trust = "owner" | "thread" | "stranger" | "suspect"

/** Failure talking to the mailbox API. `code` is the server's (`not_found`, `unclaimed`, …). */
export class MailboxError extends PostboiError {
	constructor(args: { message: string; status?: number; code?: string; raw?: unknown }) {
		super({ provider: "postboi", channel: "email", ...args })
		this.name = "MailboxError"
	}
}

/** `mailbox.wait()` ran out of time. `cursor` is where the mailbox stood, for a later `after`. */
export class MailboxTimeoutError extends MailboxError {
	readonly cursor: number
	constructor(message: string, cursor: number) {
		super({ message, code: "timeout", status: 408 })
		this.name = "MailboxTimeoutError"
		this.cursor = cursor
	}
}

// ---------------------------------------------------------------------------------------
// The wire. Internal: snake_case stays in this file.

interface WireMailbox {
	id: string
	address: string
	name: string | null
	domain: string
	key?: string
	key_prefix: string
	claimed: boolean
	claim_url?: string
	created: string
	count: number
	cursor: number
	urls: { messages: string; wait: string; threads: string; send: string }
}

interface WireMail {
	id: string
	seq: number
	thread_id: string
	to: string
	tag: string | null
	from: string
	from_name: string | null
	reply_to: string | null
	subject: string
	text: string | null
	reply_text: string | null
	trust: Trust
	received: string
	in_reply_to: string | null
	code: string | null
	codes: Array<string>
	link: string | null
	links: Array<{ url: string; text: string | null; kind: "verify" | "unsubscribe" | "other" }>
	auth: { spf?: string; dkim?: string; dmarc?: string }
	attachments: Array<{ filename: string; type: string; size: number; url: string | null }>
	size: number
	html?: string | null
	urls: { reply: string; raw?: string }
}

interface WirePage {
	data: Array<WireMail>
	cursor: number
}

interface WireSent {
	direction: "sent"
	id: string
	from: string
	to: Array<string>
	subject: string
	text: string | null
	status: string
	sent: string
}

// ---------------------------------------------------------------------------------------

/** A message a mailbox received, as the caller sees it. */
export class MailboxMail {
	/** `in_…`: the same id the Received log and `email.received` use. */
	readonly id: string
	/** Its place in the mailbox: starts at 1 and only goes up. */
	readonly seq: number
	/** The conversation it belongs to. */
	readonly thread_id: string
	/** The exact address it was sent to, plus-tag included. */
	readonly to: string
	/** The plus-tag it arrived under, or null. */
	readonly tag: string | null
	readonly from: string
	/** The sender's display name, when there was one. */
	readonly name: string | null
	/** Where the sender asked for answers to go, when not their From. */
	readonly reply_to: string | null
	readonly subject: string
	readonly text: string | null
	/** What the sender wrote, with the quoted conversation and their signature taken off. */
	readonly reply_text: string | null
	/** Who is talking. See {@link Trust}. */
	readonly trust: Trust
	readonly received: Date
	/** The send of yours (`msg_…`) it answers, when it answers one. */
	readonly in_reply_to: string | null
	/** The best one-time code in it, e.g. "482913". */
	readonly code: string | null
	readonly codes: Array<string>
	/** The best verify or magic link, tracking redirects unwrapped. */
	readonly link: string | null
	readonly links: Array<{
		url: string
		text: string | null
		kind: "verify" | "unsubscribe" | "other"
	}>
	readonly auth: { spf?: string; dkim?: string; dmarc?: string }
	/** `url` is null when the file wasn't kept. */
	readonly attachments: Array<{ filename: string; type: string; size: number; url: string | null }>
	readonly size: number
	/** Sanitised when it arrived. Null on a partial mail from a listing: `read(id)` has it. */
	readonly html: string | null
	/** True when this came from a listing, which carries no `html`. */
	readonly partial: boolean
	readonly #mailbox: Mailbox

	/** @internal */
	constructor(mailbox: Mailbox, wire: WireMail) {
		this.#mailbox = mailbox
		this.id = wire.id
		this.seq = wire.seq
		this.thread_id = wire.thread_id
		this.to = wire.to
		this.tag = wire.tag ?? null
		this.from = wire.from
		this.name = wire.from_name ?? null
		this.reply_to = wire.reply_to ?? null
		this.subject = wire.subject
		this.text = wire.text ?? null
		this.reply_text = wire.reply_text ?? null
		this.trust = wire.trust
		this.received = new Date(wire.received)
		this.in_reply_to = wire.in_reply_to ?? null
		this.code = wire.code ?? null
		this.codes = wire.codes ?? []
		this.link = wire.link ?? null
		this.links = wire.links ?? []
		this.auth = wire.auth ?? {}
		this.attachments = (wire.attachments ?? []).map((file) => ({
			...file,
			url: file.url ? new URL(file.url, mailbox.base).toString() : null,
		}))
		this.size = wire.size ?? 0
		this.html = wire.html ?? null
		this.partial = !("html" in wire)
	}

	/** Answer it in its thread. */
	reply(options: ReplyOptions): Promise<SendResult> {
		return this.#mailbox.reply(this, options)
	}

	/** The whole message as it arrived: the bytes of the `.eml`. */
	async raw(): Promise<Uint8Array> {
		const response = await this.#mailbox.request(`/messages/${encodeURIComponent(this.id)}/raw`)
		return new Uint8Array(await response.arrayBuffer())
	}

	toJSON() {
		return {
			id: this.id,
			seq: this.seq,
			thread_id: this.thread_id,
			to: this.to,
			tag: this.tag,
			from: this.from,
			name: this.name,
			reply_to: this.reply_to,
			subject: this.subject,
			trust: this.trust,
			received: this.received.toISOString(),
			in_reply_to: this.in_reply_to,
			code: this.code,
			codes: this.codes,
			link: this.link,
			links: this.links,
			text: this.text,
			reply_text: this.reply_text,
			html: this.html,
			auth: this.auth,
			attachments: this.attachments,
			size: this.size,
			partial: this.partial,
		}
	}
}

/** What to wait for, or what to watch. Every field narrows; none is required. */
export interface MailboxFilter {
	/** The plus-tag, exactly. */
	tag?: string
	/** Sender address or name: a case-insensitive substring, or a RegExp. */
	from?: Match
	/** Subject: a case-insensitive substring, or a RegExp. */
	subject?: Match
	/** Only mail from this kind of sender. */
	trust?: Trust
	/** One conversation. */
	thread?: string
}

export interface WaitOptions extends MailboxFilter {
	/** How long before giving up with a {@link MailboxTimeoutError}. Default 60 seconds. */
	timeout?: Duration
	/** Only mail with a `seq` above this counts. Default 0, so mail already there counts. */
	after?: number
	signal?: AbortSignal
}

export interface WatchOptions extends MailboxFilter {
	/** Start after this `seq`. Default: the mailbox as it stands, so only new mail. */
	after?: number
	/** Yield what's already there first. Ignored when `after` is given. */
	all?: boolean
	/** Stop watching. The loop ends quietly rather than throwing. */
	signal?: AbortSignal
}

/** An address, or a list of them. */
export type Recipients = string | Array<string>

export interface ReplyOptions {
	text?: string
	html?: string
	cc?: Recipients
	bcc?: Recipients
	/** Replaces the "Re: …" the reply would otherwise have. */
	subject?: string
	/** A retried call with the same key sends once. */
	idempotency_key?: string
}

export interface SendOptions extends Omit<ReplyOptions, "subject"> {
	to: Recipients
	subject: string
	/** A received message's id: makes this a reply in its thread instead. */
	in_reply_to?: string
}

export interface SendResult {
	/** `msg_…`: the Sent log's row. */
	id: string
	thread_id?: string
	/** True when an idempotency key matched an earlier send, which this is. */
	idempotent_replay?: boolean
}

/** One of the mailbox's own sends, as a thread shows it. */
export interface SentMail extends Omit<WireSent, "sent"> {
	sent: Date
}

export interface MailboxThread {
	thread_id: string
	subject: string
	from: string
	from_name: string | null
	/** Received and sent together. */
	messages: number
	last_at: Date
	/** The newest received message's trust. */
	trust: Trust
}

export interface MailboxOptions {
	/** The mailbox's own key (`mb_…`). Default `POSTBOI_MAILBOX_KEY`. */
	key?: string
	/**
	 * Your team's API key, to make a mailbox that is your team's straight away, or to open
	 * one of the team's by `address`. Default `POSTBOI_TOKEN`.
	 */
	token?: string
	/** Open this mailbox of the team's (with `token`), or ask for this name when making one. */
	address?: string
	/** One of your team's receiving domains, for a new mailbox on it. */
	domain?: string
	/** What your team calls a new mailbox. */
	name?: string
	/** Default `POSTBOI_MAILBOX_URL`, then https://agentboi.email. */
	base?: string
	fetch?: typeof fetch
}

function base_url(base: string | undefined): string {
	return (base ?? read_env("POSTBOI_MAILBOX_URL") ?? MAILBOX_URL).replace(/\/+$/, "")
}

function list_of(value: Recipients | undefined): Array<string> | undefined {
	if (value === undefined) return undefined
	return Array.isArray(value) ? value : [value]
}

/** Does a mail pass the parts of a filter the server can't apply (RegExps)? */
function passes(mail: MailboxMail, filter: MailboxFilter): boolean {
	if (filter.tag !== undefined && mail.tag !== filter.tag) return false
	if (filter.trust !== undefined && mail.trust !== filter.trust) return false
	if (filter.thread !== undefined && mail.thread_id !== filter.thread) return false
	if (filter.from !== undefined) {
		const who = mail.name ? `${mail.name} <${mail.from}>` : mail.from
		if (!matches(who, filter.from)) return false
	}
	return matches(mail.subject, filter.subject)
}

/** The filter's parts the server can apply itself. */
function server_filter(filter: MailboxFilter): Record<string, string> {
	const out: Record<string, string> = {}
	if (filter.tag !== undefined) out.tag = filter.tag
	if (filter.trust !== undefined) out.trust = filter.trust
	if (filter.thread !== undefined) out.thread = filter.thread
	if (typeof filter.from === "string") out.from = filter.from
	if (typeof filter.subject === "string") out.subject = filter.subject
	return out
}

function transient(error: unknown): boolean {
	if (error instanceof MailboxError) return !error.status || error.status >= 500
	if (error instanceof Error && error.name === "TimeoutError") return true
	return error instanceof TypeError
}

async function failure(response: Response): Promise<MailboxError> {
	let body: unknown
	try {
		body = await response.json()
	} catch {
		body = undefined
	}
	const { message, code } = (body ?? {}) as { message?: string; code?: string }
	return new MailboxError({
		message: message ?? `The mailbox API answered ${response.status}`,
		status: response.status,
		code: code ?? (response.status === 404 ? "not_found" : undefined),
		raw: body,
	})
}

/** One agent mailbox. Made or opened by {@link mailbox}. */
export class Mailbox {
	readonly id: string
	/** `orders-k3f9@agentboi.email` */
	readonly address: string
	name: string | null
	readonly domain: string
	/**
	 * The mailbox's own key (`mb_…`), when this was opened or made with it. Undefined when
	 * it was opened with the team's API key. Rotated by {@link Mailbox.rotate}.
	 */
	key: string | undefined
	/** False until a person claims it: it receives, and refuses to send. */
	claimed: boolean
	/** Where a person claims an unclaimed mailbox. Only on the one that was just made. */
	readonly claim_url: string | undefined
	readonly created: Date
	/** How many messages it has received, when last asked. */
	count: number
	/** The highest `seq` filed when last asked: pass it as `after` to insist on new mail. */
	cursor: number
	readonly base: string
	#credential: string
	readonly #fetch: typeof fetch

	/** @internal */
	constructor(wire: WireMailbox, credential: string, base: string, fetcher: typeof fetch) {
		this.id = wire.id
		this.address = wire.address
		this.name = wire.name ?? null
		this.domain = wire.domain
		this.key = wire.key ?? (credential.startsWith("mb_") ? credential : undefined)
		this.claimed = wire.claimed
		this.claim_url = wire.claim_url
		this.created = new Date(wire.created)
		this.count = wire.count ?? 0
		this.cursor = wire.cursor ?? 0
		this.base = base
		this.#credential = wire.key ?? credential
		this.#fetch = fetcher
	}

	#update(wire: WireMailbox): void {
		this.name = wire.name ?? null
		this.claimed = wire.claimed
		this.count = wire.count ?? this.count
		this.cursor = Math.max(this.cursor, wire.cursor ?? 0)
	}

	/** The address with a plus-tag: `tag("order-1041")` → `orders-k3f9+order-1041@agentboi.email`. */
	tag(tag: string): string {
		const at = this.address.lastIndexOf("@")
		return `${this.address.slice(0, at)}+${tag}${this.address.slice(at)}`
	}

	/** @internal Every request goes through here, with the key, and fails as a MailboxError. */
	async request(
		path: string,
		init: RequestInit & { query?: Record<string, string | number | undefined>; key?: string } = {}
	): Promise<Response> {
		const url = new URL(`${this.base}/v1/mailboxes/${encodeURIComponent(this.address)}${path}`)
		for (const [name, value] of Object.entries(init.query ?? {})) {
			if (value !== undefined) url.searchParams.set(name, String(value))
		}
		const { query: _query, key, ...rest } = init
		const headers = new Headers(rest.headers)
		headers.set("authorization", `Bearer ${key ?? this.#credential}`)
		if (!headers.has("accept")) headers.set("accept", "application/json")
		const response = await this.#fetch(url, { ...rest, headers })
		if (!response.ok && response.status !== 408) throw await failure(response)
		return response
	}

	async #post(path: string, body: unknown): Promise<Response> {
		return this.request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})
	}

	/**
	 * Wait for a mail and return it whole: the newest match with a `seq` above `after`.
	 * String filters go to the server's own `/wait`; a RegExp is tested here instead.
	 */
	async wait(options: WaitOptions = {}): Promise<MailboxMail> {
		const deadline = Date.now() + duration_ms(options.timeout ?? 60_000)
		const regex = options.from instanceof RegExp || options.subject instanceof RegExp
		return regex ? this.#wait_polling(options, deadline) : this.#wait_server(options, deadline)
	}

	async #wait_server(options: WaitOptions, deadline: number): Promise<MailboxMail> {
		const query = server_filter(options)
		let cursor = options.after ?? 0
		for (;;) {
			if (aborted(options.signal)) throw options.signal!.reason
			const left = deadline - Date.now()
			if (left <= 0) throw timed_out(cursor)
			const seconds = Math.max(1, Math.min(WAIT_SECONDS, Math.ceil(left / 1000)))
			const response = await this.request("/wait", {
				query: { ...query, after: options.after, timeout: seconds },
				signal: with_deadline(options.signal, seconds * 1000 + GRACE_MS),
			})
			const body = (await response.json()) as WireMail | { cursor?: number }
			if (response.status === 408) {
				cursor = (body as { cursor?: number }).cursor ?? cursor
				continue
			}
			return new MailboxMail(this, body as WireMail)
		}
	}

	async #wait_polling(options: WaitOptions, deadline: number): Promise<MailboxMail> {
		const query = server_filter(options)
		let cursor = options.after ?? 0
		for (;;) {
			if (aborted(options.signal)) throw options.signal!.reason
			const left = deadline - Date.now()
			if (left <= 0) throw timed_out(cursor)
			const seconds = Math.max(0, Math.min(POLL_SECONDS, Math.floor(left / 1000)))
			const page = await this.#page(cursor, seconds, query, options.signal)
			const hits = page.data
				.map((wire) => new MailboxMail(this, wire))
				.filter((mail) => mail.seq > cursor && passes(mail, options))
			cursor = Math.max(cursor, page.cursor)
			if (hits.length) return this.read(hits.reduce((a, b) => (b.seq > a.seq ? b : a)).id)
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
		this.cursor = Math.max(this.cursor, page.cursor ?? 0)
		return page
	}

	/** Mail in the mailbox, oldest first, up to 100 after `after`. Partial: no `html`. */
	async list(filter: MailboxFilter & { after?: number } = {}): Promise<Array<MailboxMail>> {
		const page = await this.#page(filter.after ?? 0, 0, server_filter(filter), undefined)
		return page.data
			.map((wire) => new MailboxMail(this, wire))
			.filter((mail) => passes(mail, filter))
			.sort((a, b) => a.seq - b.seq)
	}

	/** One mail, whole. */
	async read(id: string): Promise<MailboxMail> {
		const response = await this.request(`/messages/${encodeURIComponent(id)}`)
		return new MailboxMail(this, (await response.json()) as WireMail)
	}

	/**
	 * Every mail as it arrives, whole, until you stop reading or `signal` aborts. A request
	 * that drops is retried with a backoff; a refusal (a rotated key, a deleted mailbox)
	 * ends the loop by throwing.
	 */
	async *watch(options: WatchOptions = {}): AsyncGenerator<MailboxMail, void, undefined> {
		const query = server_filter(options)
		let cursor = options.after ?? 0
		let backoff = 0
		if (options.after === undefined && options.all) {
			const first = await this.#page(0, 0, query, options.signal)
			for (const wire of first.data.sort((a, b) => a.seq - b.seq)) {
				const mail = new MailboxMail(this, wire)
				if (passes(mail, options)) yield await this.read(mail.id)
			}
			cursor = first.cursor
		} else if (options.after === undefined) {
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
			for (const wire of page.data.sort((a, b) => a.seq - b.seq)) {
				if (wire.seq <= cursor) continue
				const mail = new MailboxMail(this, wire)
				if (passes(mail, options)) yield await this.read(mail.id)
			}
			cursor = Math.max(cursor, page.cursor)
		}
	}

	/**
	 * Answer a mail in its thread. Who it goes to, its subject and the headers that keep it
	 * in the conversation come from the mail being answered. Throws a MailboxError with
	 * code `unclaimed` while nobody has claimed the mailbox.
	 */
	async reply(mail: MailboxMail | string, options: ReplyOptions): Promise<SendResult> {
		const id = typeof mail === "string" ? mail : mail.id
		const response = await this.#post(`/messages/${encodeURIComponent(id)}/reply`, {
			text: options.text,
			html: options.html,
			cc: list_of(options.cc),
			bcc: list_of(options.bcc),
			subject: options.subject,
			idempotency_key: options.idempotency_key,
		})
		return (await response.json()) as SendResult
	}

	/** A new message from the mailbox's own address. */
	async send(options: SendOptions): Promise<SendResult> {
		const response = await this.#post("/send", {
			to: list_of(options.to),
			cc: list_of(options.cc),
			bcc: list_of(options.bcc),
			subject: options.subject,
			text: options.text,
			html: options.html,
			in_reply_to: options.in_reply_to,
			idempotency_key: options.idempotency_key,
		})
		return (await response.json()) as SendResult
	}

	/** The conversations it is in, newest activity first. Page back with `before`. */
	async threads(
		options: { limit?: number; before?: Date | string } = {}
	): Promise<Array<MailboxThread>> {
		const before = options.before instanceof Date ? options.before.toISOString() : options.before
		const response = await this.request("/threads", { query: { limit: options.limit, before } })
		const body = (await response.json()) as {
			data: Array<Omit<MailboxThread, "last_at"> & { last_at: string }>
		}
		return body.data.map((thread) => ({ ...thread, last_at: new Date(thread.last_at) }))
	}

	/** One conversation, oldest first: what it received and what it sent. */
	async thread(thread_id: string): Promise<{
		thread_id: string
		subject: string
		messages: Array<{ direction: "received"; mail: MailboxMail } | SentMail>
	}> {
		const response = await this.request(`/threads/${encodeURIComponent(thread_id)}`)
		const body = (await response.json()) as {
			thread_id: string
			subject: string
			messages: Array<(WireMail & { direction: "received" }) | WireSent>
		}
		return {
			thread_id: body.thread_id,
			subject: body.subject,
			messages: body.messages.map((entry) =>
				entry.direction === "received"
					? { direction: "received" as const, mail: new MailboxMail(this, entry) }
					: { ...entry, sent: new Date(entry.sent) }
			),
		}
	}

	/** Refresh `count`, `cursor` and `claimed` from the server. */
	async info(): Promise<this> {
		const response = await this.request("")
		this.#update((await response.json()) as WireMailbox)
		return this
	}

	/** Rename it. The name is what your team calls it, never part of its address. */
	async rename(name: string | null): Promise<this> {
		const response = await this.request("", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name }),
		})
		this.#update((await response.json()) as WireMailbox)
		return this
	}

	/** A new key. The old one stops working at once; the new one is on `key` and returned. */
	async rotate(): Promise<string> {
		const response = await this.request("/key", { method: "POST" })
		const wire = (await response.json()) as WireMailbox
		if (!wire.key) throw new MailboxError({ message: "The API answered without a key", raw: wire })
		this.key = wire.key
		this.#credential = wire.key
		return wire.key
	}

	/**
	 * Delete it: its key stops working and mail to it is refused. A claimed mailbox needs
	 * the team's API key for this; an unclaimed one may delete itself.
	 */
	async delete(): Promise<void> {
		await this.request("", { method: "DELETE" })
	}

	toJSON() {
		return {
			id: this.id,
			address: this.address,
			name: this.name,
			key: this.key,
			claimed: this.claimed,
			claim_url: this.claim_url,
			base: this.base,
		}
	}
}

function timed_out(cursor: number): MailboxTimeoutError {
	return new MailboxTimeoutError("No mail arrived in time", cursor)
}

async function make(options: MailboxOptions): Promise<Mailbox> {
	await ensure_env_loaded()
	const base = base_url(options.base)
	const fetcher = options.fetch ?? globalThis.fetch
	const token = options.token ?? read_env("POSTBOI_TOKEN")
	const body: Record<string, unknown> = {}
	if (options.address) body.address = options.address
	if (options.domain) body.domain = options.domain
	if (options.name) body.name = options.name
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json",
	}
	if (token) headers.authorization = `Bearer ${token}`
	const response = await fetcher(`${base}/v1/mailboxes`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	})
	if (!response.ok) throw await failure(response)
	const wire = (await response.json()) as WireMailbox
	if (!wire.key) throw new MailboxError({ message: "The API answered without a key", raw: wire })
	return new Mailbox(wire, wire.key, base, fetcher)
}

async function open(options: MailboxOptions): Promise<Mailbox> {
	await ensure_env_loaded()
	const base = base_url(options.base)
	const fetcher = options.fetch ?? globalThis.fetch
	const key = options.key ?? read_env("POSTBOI_MAILBOX_KEY")
	if (key) {
		// The key alone names its mailbox.
		const response = await fetcher(`${base}/v1/mailboxes`, {
			headers: { authorization: `Bearer ${key}`, accept: "application/json" },
		})
		if (!response.ok) throw await failure(response)
		return new Mailbox((await response.json()) as WireMailbox, key, base, fetcher)
	}
	const token = options.token ?? read_env("POSTBOI_TOKEN")
	if (token && options.address) {
		const response = await fetcher(`${base}/v1/mailboxes/${encodeURIComponent(options.address)}`, {
			headers: { authorization: `Bearer ${token}`, accept: "application/json" },
		})
		if (!response.ok) throw await failure(response)
		return new Mailbox((await response.json()) as WireMailbox, token, base, fetcher)
	}
	throw new MailboxError({
		message: "No mailbox key: pass key, set POSTBOI_MAILBOX_KEY, or make one with mailbox.create()",
		code: "missing_key",
	})
}

async function resolve(options: MailboxOptions = {}): Promise<Mailbox> {
	await ensure_env_loaded()
	if (options.key || read_env("POSTBOI_MAILBOX_KEY")) return open(options)
	if (
		options.address &&
		(options.token || read_env("POSTBOI_TOKEN")) &&
		options.address.includes("@")
	)
		return open(options)
	return make(options)
}

/**
 * An email address your agent keeps.
 *
 * With `POSTBOI_MAILBOX_KEY` (or `key`) it opens that mailbox. Without one it makes a new
 * one: your team's, if `POSTBOI_TOKEN` is set, or else one of its own that receives
 * straight away and sends once a person opens `claim_url`. A new mailbox's `key` is said
 * once; keep it.
 *
 * ```ts
 * const box = await mailbox()
 * for await (const mail of box.watch()) {
 *   if (mail.trust === "suspect") continue
 *   await box.reply(mail, { text: "On it." })
 * }
 * ```
 */
export const mailbox: {
	(options?: MailboxOptions): Promise<Mailbox>
	/** Always make a new mailbox. */
	create(options?: MailboxOptions): Promise<Mailbox>
	/** Open an existing one: by its key, or by its address with the team's API key. */
	open(options?: MailboxOptions): Promise<Mailbox>
	/** Every mailbox the team has, with the team's API key. */
	list(options?: Pick<MailboxOptions, "token" | "base" | "fetch">): Promise<Array<Mailbox>>
} = Object.assign(resolve, { create: make, open, list })

async function list(
	options: Pick<MailboxOptions, "token" | "base" | "fetch"> = {}
): Promise<Array<Mailbox>> {
	await ensure_env_loaded()
	const base = base_url(options.base)
	const fetcher = options.fetch ?? globalThis.fetch
	const token = options.token ?? read_env("POSTBOI_TOKEN")
	if (!token)
		throw new MailboxError({
			message: "Listing mailboxes needs your team's POSTBOI_TOKEN",
			code: "missing_token",
		})
	const response = await fetcher(`${base}/v1/mailboxes`, {
		headers: { authorization: `Bearer ${token}`, accept: "application/json" },
	})
	if (!response.ok) throw await failure(response)
	const body = (await response.json()) as { data: Array<WireMailbox> }
	return body.data.map((wire) => new Mailbox(wire, token, base, fetcher))
}

export default mailbox
