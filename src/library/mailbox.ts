import { base64_encode } from "./encoding.js"
import { ensure_env_loaded, read_env } from "./env.js"
import { drop, keep, names_address, recall } from "./mailbox_store.js"
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

/**
 * Who has to look at the mailbox's mail before it goes, set by the team:
 * - `none`: everything goes (the default)
 * - `new`: a reply to the person who wrote goes; a new conversation waits for a person
 * - `all`: everything waits
 *
 * Only a send made with the mailbox's own key waits. The team's key is the team, so its
 * sends go out.
 */
export type Review = "none" | "new" | "all"

/** Where a thread is. `sent` is one the mailbox started that nobody has answered yet. */
export type Folder = "inbox" | "archive" | "spam" | "trash" | "sent"

export type LabelColour = "grey" | "amber" | "red" | "green" | "blue"

/** A label on the mailbox's threads. Labels belong to one mailbox. */
export interface Label {
	/** `lbl_…`. Anywhere a label is asked for, its name works too. */
	id: string
	name: string
	colour: LabelColour
}

/** Failure talking to the mailbox API. `code` is the server's (`not_found`, `unclaimed`, …). */
export class MailboxError extends PostboiError {
	constructor(args: {
		message: string
		status?: number
		code?: string
		raw?: unknown
		outcome_unknown?: boolean
	}) {
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
	key_expires_at?: string | null
	enabled?: boolean
	disabled_at?: string | null
	key_active?: boolean
	claimed: boolean
	claim_url?: string
	created: string
	count: number
	cursor: number
	review?: Review
	drafts_waiting?: number
	urls: {
		messages: string
		wait: string
		threads: string
		send: string
		drafts?: string
		labels?: string
	}
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
	otp?: { code: string; origin: string; signed?: boolean } | null
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
	cc?: Array<string>
	subject: string
	text: string | null
	status: string
	sent: string
}

interface WireThread {
	thread_id: string
	subject: string
	from: string | null
	from_name: string | null
	to?: Array<string>
	messages: number
	last_at: string
	trust: Trust | null
	folder?: Folder
	unread?: boolean
	labels?: Array<Label>
}

interface WireDraft {
	id: string
	status: "draft" | "sent"
	to: Array<string>
	cc: Array<string>
	bcc: Array<string>
	subject: string
	text: string | null
	html: string | null
	in_reply_to: string | null
	thread_id: string | null
	attachments: Array<{ filename: string; type: string; size: number }>
	held: boolean
	created_by: "agent" | "team"
	created: string
	updated: string
	sent_at: string | null
	message_id: string | null
}

/** What every send answers: 201 when it went, 202 when the review policy held it. */
type WireSendResult =
	| { status?: "sent"; id: string; thread_id?: string; idempotent_replay?: boolean }
	| { status: "draft"; draft_id: string; draft: WireDraft; message?: string }

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
	/**
	 * The sender's own `OTP-Token` header, when it sent a valid one: the code, the site it
	 * says the code is for, and whether the sender's own DKIM signature covers the header.
	 * `code` is that code. Unless `signed`, the origin is only the sender's claim: a DMARC
	 * pass doesn't vouch for a header the signature left out.
	 */
	readonly otp: { code: string; origin: string; signed: boolean } | null
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
		// A server from before `signed` sends none: that is unsigned.
		this.otp = wire.otp ? { ...wire.otp, signed: wire.otp.signed === true } : null
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

	/** Send it on to somebody else, with a note above it. */
	forward(options: ForwardOptions): Promise<SendResult> {
		return this.#mailbox.forward(this, options)
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
			otp: this.otp,
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

/**
 * A file to send. `content` is the file's bytes; a string is taken as base64 already, the
 * way most mail APIs take one. At most 20 files and 10 MB in all a message.
 */
export interface MailboxAttachment {
	filename: string
	content: string | Uint8Array | ArrayBuffer | Blob
	/** Its media type, e.g. `application/pdf`. The server guesses from the name without it. */
	type?: string
}

export interface ReplyOptions {
	text?: string
	html?: string
	cc?: Recipients
	bcc?: Recipients
	/** Replaces the "Re: …" the reply would otherwise have. */
	subject?: string
	attachments?: Array<MailboxAttachment>
	/** A retried call with the same key sends once. */
	idempotency_key?: string
}

export interface SendOptions extends Omit<ReplyOptions, "subject"> {
	to: Recipients
	subject: string
	/** A received message's id: makes this a reply in its thread instead. */
	in_reply_to?: string
}

export interface ForwardOptions {
	to: Recipients
	cc?: Recipients
	bcc?: Recipients
	/** A note above the forwarded message. */
	text?: string
	html?: string
	/** Carry the original's files that were kept. Default true. */
	attachments?: boolean
	/** A retried call with the same key sends once. */
	idempotency_key?: string
}

/**
 * A message the mailbox hasn't sent: written for a person to send, or made by a send the
 * review policy held.
 */
export interface Draft {
	/** `drf_…` */
	id: string
	status: "draft" | "sent"
	to: Array<string>
	cc: Array<string>
	bcc: Array<string>
	/** May be "" while it is a draft. */
	subject: string
	text: string | null
	html: string | null
	/** The received message it answers, when it answers one. */
	in_reply_to: string | null
	thread_id: string | null
	attachments: Array<{ filename: string; type: string; size: number }>
	/** True when a send the review policy held made it, false when it was written as a draft. */
	held: boolean
	created_by: "agent" | "team"
	created: Date
	updated: Date
	sent_at: Date | null
	/** The Sent log's row (`msg_…`), once it is sent. */
	message_id: string | null
}

export interface DraftOptions {
	to?: Recipients
	cc?: Recipients
	bcc?: Recipients
	subject?: string
	text?: string
	html?: string
	/**
	 * A message this mailbox received: the draft threads like a reply, and `to` and
	 * `subject` default from it.
	 */
	in_reply_to?: MailboxMail | string
	/** On an update, this replaces the draft's files. */
	attachments?: Array<MailboxAttachment>
}

/**
 * What a send, a reply or a forward comes back as. `sent` went out; `draft` was held by
 * the mailbox's {@link Review} policy and saved as a draft, which a person on the team
 * sends. Don't send a held message again: it is already waiting.
 */
export type SendResult =
	| {
			status: "sent"
			/** `msg_…`: the Sent log's row. */
			id: string
			/** The conversation it is in. A new conversation's id is its own message id. */
			thread_id: string
			/** True when an idempotency key matched an earlier send, which this is. */
			idempotent_replay?: boolean
	  }
	| {
			status: "draft"
			draft_id: string
			draft: Draft
			/** The server's sentence about why it waits. */
			message: string
	  }

/** One of the mailbox's own sends, as a thread shows it. */
export interface SentMail extends Omit<WireSent, "sent" | "cc"> {
	cc: Array<string>
	sent: Date
}

export interface MailboxThread {
	thread_id: string
	subject: string
	/** The newest received message's sender. Null in a thread nobody has answered. */
	from: string | null
	from_name: string | null
	/** Who the mailbox wrote to in it. Empty when it never wrote. */
	to: Array<string>
	/** Received and sent together. */
	messages: number
	last_at: Date
	/** The newest received message's trust. Null when nothing was received. */
	trust: Trust | null
	folder: Folder
	/** True when mail has arrived since it was last marked read. */
	unread: boolean
	labels: Array<Label>
}

export interface ThreadsOptions {
	/** Default `inbox`. `all` is every folder. */
	folder?: Folder | "all"
	/** A label's id or name. */
	label?: string
	/** Only unread threads (true) or only read ones (false). */
	unread?: boolean
	/** Search the subject, sender, recipients and text: a case-insensitive substring. */
	q?: string
	/** 1 to 100, default 50. */
	limit?: number
	/** Page back: threads whose last activity is before this (a `last_at`). */
	before?: Date | string
}

/** A change to a thread. At least one field. Labels are named by id or by name. */
export interface ThreadUpdate {
	/** `sent` isn't settable: it is where a thread nobody answered waits. */
	folder?: Exclude<Folder, "sent">
	/** False marks it unread. */
	read?: boolean
	/** Replaces the set; [] clears. A name that isn't a label yet is made one. */
	labels?: Array<string>
	/** A name that isn't a label yet is made one. */
	add_labels?: Array<string>
	/** Names it doesn't know are ignored. */
	remove_labels?: Array<string>
}

/** A thread, or anything that names one (a mail, a thread summary). */
export type ThreadRef = string | { thread_id: string }

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
	/** Lifetime of a new mailbox key: whole seconds or a duration such as "1h" (up to 365d). */
	ttl?: number | string
	/** Default `POSTBOI_MAILBOX_URL`, then https://agentboi.email. */
	base?: string
	fetch?: typeof fetch
	/**
	 * Remember a mailbox made without the team's key on this machine (in the file the CLI
	 * keeps), so the next `mailbox()` from the same directory opens it rather than making
	 * another. Default true; it does nothing where there is no filesystem.
	 */
	remember?: boolean
}

function base_url(base: string | undefined): string {
	return (base ?? read_env("POSTBOI_MAILBOX_URL") ?? MAILBOX_URL).replace(/\/+$/, "")
}

function list_of(value: Recipients | undefined): Array<string> | undefined {
	if (value === undefined) return undefined
	return Array.isArray(value) ? value : [value]
}

function thread_id_of(thread: ThreadRef): string {
	return typeof thread === "string" ? thread : thread.thread_id
}

/** Files for the wire: bytes become base64, a string is taken as base64 already. */
async function encode_attachments(
	files: Array<MailboxAttachment> | undefined
): Promise<Array<{ filename: string; content: string; type?: string }> | undefined> {
	if (files === undefined) return undefined
	return Promise.all(
		files.map(async (file) => {
			const { filename, content } = file
			let type = file.type
			let encoded: string
			if (typeof content === "string") encoded = content
			else if (content instanceof Uint8Array) encoded = base64_encode(content)
			else if (content instanceof ArrayBuffer) encoded = base64_encode(new Uint8Array(content))
			else {
				encoded = base64_encode(new Uint8Array(await content.arrayBuffer()))
				type ??= content.type || undefined
			}
			return { filename, content: encoded, ...(type ? { type } : {}) }
		})
	)
}

function draft_of(wire: WireDraft): Draft {
	return {
		id: wire.id,
		status: wire.status,
		to: wire.to ?? [],
		cc: wire.cc ?? [],
		bcc: wire.bcc ?? [],
		subject: wire.subject ?? "",
		text: wire.text ?? null,
		html: wire.html ?? null,
		in_reply_to: wire.in_reply_to ?? null,
		thread_id: wire.thread_id ?? null,
		attachments: wire.attachments ?? [],
		held: wire.held ?? false,
		created_by: wire.created_by,
		created: new Date(wire.created),
		updated: new Date(wire.updated ?? wire.created),
		sent_at: wire.sent_at ? new Date(wire.sent_at) : null,
		message_id: wire.message_id ?? null,
	}
}

function thread_of(wire: WireThread): MailboxThread {
	return {
		thread_id: wire.thread_id,
		subject: wire.subject,
		from: wire.from ?? null,
		from_name: wire.from_name ?? null,
		to: wire.to ?? [],
		messages: wire.messages,
		last_at: new Date(wire.last_at),
		trust: wire.trust ?? null,
		folder: wire.folder ?? "inbox",
		unread: wire.unread ?? false,
		labels: wire.labels ?? [],
	}
}

/**
 * A send's answer, whichever way it went. A server from before review answers 201 with
 * only an id, which is a send that went.
 */
async function send_result(response: Response): Promise<SendResult> {
	const body = (await response.json()) as WireSendResult
	if (body.status === "draft" || response.status === 202) {
		const held = body as Extract<WireSendResult, { status: "draft" }>
		return {
			status: "draft",
			draft_id: held.draft_id,
			draft: draft_of(held.draft),
			message:
				held.message ??
				"This mailbox's sends wait for a person on the team. It is saved as a draft.",
		}
	}
	const sent = body as Exclude<WireSendResult, { status: "draft" }>
	return {
		status: "sent",
		id: sent.id,
		thread_id: sent.thread_id ?? sent.id,
		...(sent.idempotent_replay ? { idempotent_replay: true } : {}),
	}
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

/** The methods that change nothing, so a failed one can't have sent anything. */
const READS = new Set(["GET", "HEAD"])

/**
 * Make a request, with a connection that failed or timed out raised as a MailboxError: an
 * unknown outcome when the request could have changed something. A caller's own abort
 * stays an AbortError.
 */
async function reach(fetcher: typeof fetch, url: string | URL, init: RequestInit = {}) {
	try {
		return await fetcher(url, init)
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error
		throw new MailboxError({
			message: `The mailbox API didn't answer: ${error instanceof Error ? error.message : String(error)}`,
			raw: error,
			outcome_unknown: !READS.has((init.method ?? "GET").toUpperCase()),
		})
	}
}

/** The API's refusal as a MailboxError; a 5xx to a write may have landed, so it says so. */
async function failure(response: Response, method = "GET"): Promise<MailboxError> {
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
		outcome_unknown: response.status >= 500 && !READS.has(method.toUpperCase()),
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
	/** Primary mailbox key's deadline, or null for a permanent key. */
	key_expires_at: Date | null
	/** A disabled agent keeps receiving mail, while its credentials and sends are cut off. */
	enabled: boolean
	disabled_at: Date | null
	key_active: boolean
	/** False until a person claims it: it receives, and refuses to send. */
	claimed: boolean
	/** Where a person claims an unclaimed mailbox. Only on the one that was just made. */
	readonly claim_url: string | undefined
	readonly created: Date
	/** How many messages it has received, when last asked. */
	count: number
	/** The highest `seq` filed when last asked: pass it as `after` to insist on new mail. */
	cursor: number
	/** Who has to look before it sends. See {@link Review}. Changed with {@link Mailbox.set_review}. */
	review: Review
	/** Drafts waiting to be sent, when last asked. */
	drafts_waiting: number
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
		this.key_expires_at = wire.key_expires_at ? new Date(wire.key_expires_at) : null
		this.enabled = wire.enabled ?? true
		this.disabled_at = wire.disabled_at ? new Date(wire.disabled_at) : null
		this.key_active = wire.key_active ?? true
		this.claimed = wire.claimed
		this.claim_url = wire.claim_url
		this.created = new Date(wire.created)
		this.count = wire.count ?? 0
		this.cursor = wire.cursor ?? 0
		this.review = wire.review ?? "none"
		this.drafts_waiting = wire.drafts_waiting ?? 0
		this.base = base
		this.#credential = wire.key ?? credential
		this.#fetch = fetcher
	}

	#update(wire: WireMailbox): void {
		this.enabled = wire.enabled ?? true
		this.disabled_at = wire.disabled_at ? new Date(wire.disabled_at) : null
		this.key_active = wire.key_active ?? true
		this.key_expires_at = wire.key_expires_at ? new Date(wire.key_expires_at) : null
		this.name = wire.name ?? null
		this.claimed = wire.claimed
		this.count = wire.count ?? this.count
		this.cursor = Math.max(this.cursor, wire.cursor ?? 0)
		this.review = wire.review ?? this.review
		this.drafts_waiting = wire.drafts_waiting ?? this.drafts_waiting
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
		const response = await reach(this.#fetch, url, { ...rest, headers })
		if (!response.ok && response.status !== 408) throw await failure(response, rest.method)
		return response
	}

	async #post(path: string, body: unknown, method = "POST"): Promise<Response> {
		return this.request(path, {
			method,
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
		signal: AbortSignal | undefined,
		limit?: number
	): Promise<WirePage> {
		const response = await this.request("/messages", {
			query: { ...query, after, wait, limit },
			signal: with_deadline(signal, wait * 1000 + GRACE_MS),
		})
		const page = (await response.json()) as WirePage
		this.cursor = Math.max(this.cursor, page.cursor ?? 0)
		return page
	}

	/** Mail in the mailbox, oldest first, up to 100 after `after`. Partial: no `html`. */
	async list(filter: MailboxFilter & { after?: number } = {}): Promise<Array<MailboxMail>> {
		// The server's own page is 50; this promises up to 100.
		const page = await this.#page(filter.after ?? 0, 0, server_filter(filter), undefined, 100)
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
	 * code `unclaimed` while nobody has claimed the mailbox. Resolves to a `draft` when the
	 * review policy holds it (see {@link SendResult}).
	 */
	async reply(mail: MailboxMail | string, options: ReplyOptions): Promise<SendResult> {
		const id = typeof mail === "string" ? mail : mail.id
		const response = await this.#post(`/messages/${encodeURIComponent(id)}/reply`, {
			text: options.text,
			html: options.html,
			cc: list_of(options.cc),
			bcc: list_of(options.bcc),
			subject: options.subject,
			attachments: await encode_attachments(options.attachments),
			idempotency_key: options.idempotency_key,
		})
		return send_result(response)
	}

	/** A new message from the mailbox's own address. Under review it may come back a `draft`. */
	async send(options: SendOptions): Promise<SendResult> {
		const response = await this.#post("/send", {
			to: list_of(options.to),
			cc: list_of(options.cc),
			bcc: list_of(options.bcc),
			subject: options.subject,
			text: options.text,
			html: options.html,
			in_reply_to: options.in_reply_to,
			attachments: await encode_attachments(options.attachments),
			idempotency_key: options.idempotency_key,
		})
		return send_result(response)
	}

	/**
	 * Send a received mail on to somebody else as `Fwd: <subject>`, with `text` or `html` as
	 * a note above it and the original's files attached unless `attachments` is false. A
	 * forward is a new conversation, so a mailbox under `new` review holds it.
	 */
	async forward(mail: MailboxMail | string, options: ForwardOptions): Promise<SendResult> {
		const id = typeof mail === "string" ? mail : mail.id
		const response = await this.#post(`/messages/${encodeURIComponent(id)}/forward`, {
			to: list_of(options.to),
			cc: list_of(options.cc),
			bcc: list_of(options.bcc),
			text: options.text,
			html: options.html,
			attachments: options.attachments,
			idempotency_key: options.idempotency_key,
		})
		return send_result(response)
	}

	/**
	 * The conversations it is in, newest activity first: the inbox unless `folder` says
	 * otherwise. Page back with `before` set to the last one's `last_at`.
	 */
	async threads(options: ThreadsOptions = {}): Promise<Array<MailboxThread>> {
		const before = options.before instanceof Date ? options.before.toISOString() : options.before
		const response = await this.request("/threads", {
			query: {
				folder: options.folder,
				label: options.label,
				unread: options.unread === undefined ? undefined : String(options.unread),
				q: options.q,
				limit: options.limit,
				before,
			},
		})
		const body = (await response.json()) as { data: Array<WireThread> }
		return body.data.map(thread_of)
	}

	/** One conversation, oldest first: what it received and what it sent. */
	async thread(thread: ThreadRef): Promise<{
		thread_id: string
		subject: string
		folder: Folder
		unread: boolean
		labels: Array<Label>
		messages: Array<{ direction: "received"; mail: MailboxMail } | SentMail>
	}> {
		const response = await this.request(`/threads/${encodeURIComponent(thread_id_of(thread))}`)
		const body = (await response.json()) as {
			thread_id: string
			subject: string
			folder?: Folder
			unread?: boolean
			labels?: Array<Label>
			messages: Array<(WireMail & { direction: "received" }) | WireSent>
		}
		return {
			thread_id: body.thread_id,
			subject: body.subject,
			folder: body.folder ?? "inbox",
			unread: body.unread ?? false,
			labels: body.labels ?? [],
			messages: body.messages.map((entry) =>
				entry.direction === "received"
					? { direction: "received" as const, mail: new MailboxMail(this, entry) }
					: { ...entry, cc: entry.cc ?? [], sent: new Date(entry.sent) }
			),
		}
	}

	/** Move a thread, mark it read or unread, or change its labels. */
	async update_thread(thread: ThreadRef, update: ThreadUpdate): Promise<MailboxThread> {
		const response = await this.#post(
			`/threads/${encodeURIComponent(thread_id_of(thread))}`,
			update,
			"PATCH"
		)
		return thread_of((await response.json()) as WireThread)
	}

	/** Move a thread to the archive. New mail in it brings it back to the inbox. */
	archive(thread: ThreadRef): Promise<MailboxThread> {
		return this.update_thread(thread, { folder: "archive" })
	}

	/** Move a thread to the trash. New mail in it leaves it there. */
	trash(thread: ThreadRef): Promise<MailboxThread> {
		return this.update_thread(thread, { folder: "trash" })
	}

	/** Mark a thread read, or unread with `false`. */
	mark_read(thread: ThreadRef, read = true): Promise<MailboxThread> {
		return this.update_thread(thread, { read })
	}

	/** The mailbox's labels by name, each with how many threads carry it. */
	async labels(): Promise<Array<Label & { threads: number }>> {
		const response = await this.request("/labels")
		return ((await response.json()) as { data: Array<Label & { threads: number }> }).data
	}

	/** A new label: 1 to 40 characters, unique in the mailbox ignoring case, 50 at most. */
	async create_label(name: string, colour?: LabelColour): Promise<Label> {
		const response = await this.#post("/labels", { name, colour })
		return (await response.json()) as Label
	}

	/** Rename a label or change its colour. */
	async update_label(
		label: string,
		changes: { name?: string; colour?: LabelColour }
	): Promise<Label> {
		const response = await this.#post(`/labels/${encodeURIComponent(label)}`, changes, "PATCH")
		return (await response.json()) as Label
	}

	/** Delete a label. It comes off every thread. */
	async delete_label(label: string): Promise<void> {
		await this.request(`/labels/${encodeURIComponent(label)}`, { method: "DELETE" })
	}

	/** Drafts, newest first: waiting ones unless `status` says otherwise. Up to 100. */
	async drafts(options: { status?: "draft" | "sent" | "all" } = {}): Promise<Array<Draft>> {
		const response = await this.request("/drafts", { query: { status: options.status } })
		return ((await response.json()) as { data: Array<WireDraft> }).data.map(draft_of)
	}

	async draft(id: string): Promise<Draft> {
		const response = await this.request(`/drafts/${encodeURIComponent(id)}`)
		return draft_of((await response.json()) as WireDraft)
	}

	/**
	 * Write a draft for a person to send. Nothing is required; with `in_reply_to` it threads
	 * like a reply. The team hears about it (the `drafts` notification and the
	 * `mailbox.draft.created` webhook).
	 */
	async create_draft(options: DraftOptions = {}): Promise<Draft> {
		const in_reply_to =
			typeof options.in_reply_to === "object" ? options.in_reply_to.id : options.in_reply_to
		const response = await this.#post("/drafts", {
			...(await draft_body(options)),
			in_reply_to,
		})
		return draft_of((await response.json()) as WireDraft)
	}

	/** Change a draft while it is one. `attachments` replaces its files. */
	async update_draft(id: string, options: Omit<DraftOptions, "in_reply_to">): Promise<Draft> {
		const response = await this.#post(
			`/drafts/${encodeURIComponent(id)}`,
			await draft_body(options),
			"PATCH"
		)
		return draft_of((await response.json()) as WireDraft)
	}

	async delete_draft(id: string): Promise<void> {
		await this.request(`/drafts/${encodeURIComponent(id)}`, { method: "DELETE" })
	}

	/**
	 * Send a draft through every rule a send goes through. With the mailbox's own key, a
	 * draft the review policy would hold is refused with `review_required`: only the team
	 * sends it.
	 */
	async send_draft(
		id: string
	): Promise<{ status: "sent"; id: string; draft_id: string; thread_id: string }> {
		const response = await this.request(`/drafts/${encodeURIComponent(id)}/send`, {
			method: "POST",
		})
		const body = (await response.json()) as {
			id: string
			draft_id?: string
			thread_id?: string
		}
		return {
			status: "sent",
			id: body.id,
			draft_id: body.draft_id ?? id,
			thread_id: body.thread_id ?? body.id,
		}
	}

	/** Change who has to look before it sends. Needs the team's API key. */
	async set_review(review: Review): Promise<this> {
		const response = await this.#post("", { review }, "PATCH")
		this.#update((await response.json()) as WireMailbox)
		return this
	}

	/** Refresh `count`, `cursor`, `claimed`, `review` and `drafts_waiting` from the server. */
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

	/** Team key only. Disabling revokes credentials; re-enabling requires a new key. */
	async set_enabled(enabled: boolean): Promise<this> {
		const response = await this.#post("", { enabled }, "PATCH")
		this.#update((await response.json()) as WireMailbox)
		return this
	}

	/**
	 * A new key; the old one stops working at once. Omission keeps the deadline, and a
	 * mailbox key may only shorten it. The team's key can extend it or set ttl: null.
	 */
	async rotate(options: { ttl?: number | string | null } = {}): Promise<string> {
		const response = await this.#post("/key", options)
		const wire = (await response.json()) as WireMailbox
		if (!wire.key) throw new MailboxError({ message: "The API answered without a key", raw: wire })
		this.key = wire.key
		this.#update(wire)
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
			key_expires_at: this.key_expires_at,
			enabled: this.enabled,
			disabled_at: this.disabled_at,
			key_active: this.key_active,
			claimed: this.claimed,
			claim_url: this.claim_url,
			review: this.review,
			drafts_waiting: this.drafts_waiting,
			base: this.base,
		}
	}
}

async function draft_body(options: Omit<DraftOptions, "in_reply_to">) {
	return {
		to: list_of(options.to),
		cc: list_of(options.cc),
		bcc: list_of(options.bcc),
		subject: options.subject,
		text: options.text,
		html: options.html,
		attachments: await encode_attachments(options.attachments),
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
	if (options.ttl !== undefined) body.ttl = options.ttl
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json",
	}
	if (token) headers.authorization = `Bearer ${token}`
	const response = await reach(fetcher, `${base}/v1/mailboxes`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	})
	if (!response.ok) throw await failure(response, "POST")
	const wire = (await response.json()) as WireMailbox
	if (!wire.key) throw new MailboxError({ message: "The API answered without a key", raw: wire })
	return new Mailbox(wire, wire.key, base, fetcher)
}

async function open(options: MailboxOptions): Promise<Mailbox> {
	await ensure_env_loaded()
	const base = base_url(options.base)
	const fetcher = options.fetch ?? globalThis.fetch
	// A token passed with an address is a request to open it as the team, which a mailbox
	// key in the environment mustn't quietly overrule (changing `review` needs the team).
	const key =
		options.key ?? (options.token && options.address ? undefined : read_env("POSTBOI_MAILBOX_KEY"))
	if (key) {
		// The key alone names its mailbox.
		const response = await reach(fetcher, `${base}/v1/mailboxes`, {
			headers: { authorization: `Bearer ${key}`, accept: "application/json" },
		})
		if (!response.ok) throw await failure(response)
		return new Mailbox((await response.json()) as WireMailbox, key, base, fetcher)
	}
	const token = options.token ?? read_env("POSTBOI_TOKEN")
	if (token && options.address) {
		const response = await reach(
			fetcher,
			`${base}/v1/mailboxes/${encodeURIComponent(options.address)}`,
			{
				headers: { authorization: `Bearer ${token}`, accept: "application/json" },
			}
		)
		if (!response.ok) throw await failure(response)
		return new Mailbox((await response.json()) as WireMailbox, token, base, fetcher)
	}
	throw new MailboxError({
		message: "No mailbox key: pass key, set POSTBOI_MAILBOX_KEY, or make one with mailbox.create()",
		code: "missing_key",
	})
}

/** A string is the address, or the name to ask for: `mailbox("support")`. */
type MailboxCall = MailboxOptions | string

function options_of(call: MailboxCall | undefined): MailboxOptions {
	return typeof call === "string" ? { address: call } : (call ?? {})
}

/**
 * The team's mailbox a call means, with the team's key: the one `address` names (the
 * whole address, its id, or the name it was made with), or the team's only one. Undefined
 * when there is none, so the caller can make it; a refusal when the team has several and
 * nothing says which.
 */
async function find(call: MailboxCall = {}): Promise<Mailbox | undefined> {
	const options = options_of(call)
	await ensure_env_loaded()
	const all = (await list(options)).filter(
		(box) => !options.domain || box.domain === options.domain
	)
	const ref = options.address
	if (ref) {
		const hits = all.filter((box) => box.id === ref || names_address(box.address, ref))
		// `support` on a team's own domain is `support@` exactly, and a `support-desk@` beside
		// it only looks like agentboi's `support-k3f9`: the exact name wins.
		const local = ref.trim().toLowerCase()
		const exact = hits.filter((box) => box.address.toLowerCase().split("@")[0] === local)
		const meant = exact.length ? exact : hits
		if (meant.length <= 1) return meant[0]
		throw ambiguous(meant)
	}
	// A domain or a name says which mailbox is wanted, so the team's only one on another
	// domain, or under another name, isn't it.
	const named = options.name
		? all.filter((box) => box.name?.toLowerCase() === options.name!.trim().toLowerCase())
		: all
	if (named.length <= 1) return named[0]
	throw ambiguous(named)
}

function ambiguous(boxes: Array<Mailbox>): MailboxError {
	return new MailboxError({
		message: `Your team has ${boxes.length} mailboxes that could be meant, so say which: ${boxes
			.map((box) => `mailbox("${box.address}")`)
			.join(", ")}`,
		code: "ambiguous_mailbox",
		raw: { mailboxes: boxes.map((box) => box.address) },
	})
}

/**
 * The one door `mailbox()` goes through. A mailbox key opens its own. The team's key
 * (`POSTBOI_TOKEN`, which `postboi init` already wrote) opens the team's mailbox, making
 * it the first time. With neither, the mailbox this directory made last time, or a new
 * one that is then remembered. So nothing has to be copied into an env file for the same
 * address to come back on the next run.
 */
async function resolve(call: MailboxCall = {}): Promise<Mailbox> {
	const options = options_of(call)
	await ensure_env_loaded()
	if (options.key || read_env("POSTBOI_MAILBOX_KEY")) return open(options)
	const token = options.token ?? read_env("POSTBOI_TOKEN")
	if (token) {
		const found = await find({ ...options, token })
		if (found) return found
		// A whole address is one that exists or doesn't: the server says which, rather than
		// a new mailbox at some other address quietly standing in for it.
		if (options.address?.includes("@")) return open({ ...options, token })
		return make({ ...options, token })
	}
	const base = base_url(options.base)
	const remembering = options.remember !== false
	if (remembering) {
		const saved = await recall(base, options.address)
		if (saved) {
			try {
				return await open({ key: saved.key, base, fetch: options.fetch })
			} catch (error) {
				// Rotated or deleted somewhere else: forget it and make another.
				if (
					!(error instanceof MailboxError && error.status === 401) ||
					error.code === "key_expired"
				)
					throw error
				await drop(saved.address)
			}
		}
	}
	const box = await make(options)
	if (remembering && box.key)
		await keep({
			address: box.address,
			key: box.key,
			base: box.base,
			...(box.claim_url ? { claim_url: box.claim_url } : {}),
		})
	return box
}

/**
 * An email address your agent keeps.
 *
 * Nothing to set up. With the team's `POSTBOI_TOKEN` (which `postboi init` writes) it opens
 * the team's mailbox, or the one `address` names (`mailbox("support")`), and makes it the
 * first time. Without one it makes a mailbox of its own that receives straight away and
 * sends once a person opens `claim_url`, and remembers it on this machine so the next run
 * opens the same address. `POSTBOI_MAILBOX_KEY` (or `key`) is for an agent that should
 * reach one mailbox and nothing else of the team's: it opens that mailbox alone.
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
	(options?: MailboxOptions | string): Promise<Mailbox>
	/** Always make a new mailbox. */
	create(options?: MailboxOptions | string): Promise<Mailbox>
	/** Open an existing one: by its key, or by its address with the team's API key. */
	open(options?: MailboxOptions): Promise<Mailbox>
	/**
	 * The team's mailbox `address` names, or the team's only one, with the team's API key.
	 * Undefined when there isn't one; never makes one.
	 */
	find(options?: MailboxOptions | string): Promise<Mailbox | undefined>
	/** Every mailbox the team has, with the team's API key. */
	list(options?: Pick<MailboxOptions, "token" | "base" | "fetch">): Promise<Array<Mailbox>>
} = Object.assign(resolve, {
	create: (call?: MailboxCall) => make(options_of(call)),
	open,
	find,
	list,
})

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
	const response = await reach(fetcher, `${base}/v1/mailboxes`, {
		headers: { authorization: `Bearer ${token}`, accept: "application/json" },
	})
	if (!response.ok) throw await failure(response)
	const body = (await response.json()) as { data: Array<WireMailbox> }
	return body.data.map((wire) => new Mailbox(wire, token, base, fetcher))
}

export default mailbox
