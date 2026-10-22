import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, extname, join } from "node:path"
import { spawn } from "node:child_process"
import { cwd, env as process_env, stderr, stdout } from "node:process"
import {
	mailbox as open_or_make,
	Mailbox,
	MailboxError,
	MailboxTimeoutError,
	MAILBOX_URL,
	type Draft,
	type Folder,
	type LabelColour,
	type MailboxAttachment,
	type MailboxMail,
	type MailboxThread,
	type Review,
	type SendResult,
	type Trust,
} from "../library/mailbox.js"
import {
	names_address,
	parse_saved,
	serialise_saved,
	store_path,
	with_entry,
	write_atomically,
	type SavedMailbox,
} from "../library/mailbox_store.js"
import { EXIT, parse_match } from "./inbox.js"
import { help_text } from "./help.js"
import { bold, cyan, dim, green, red, yellow } from "./prompts.js"

/**
 * `postboi mailbox`: an address your agent keeps, from the terminal. Everything goes
 * through `postboi/mailbox`, so there is one client; what this adds is memory (the
 * mailboxes this machine made, with their keys, so an address can be left off) and what a
 * shell wants: a line per mail, NDJSON, exit codes, a command per mail.
 *
 * It needs no POSTBOI_TOKEN, like `postboi inbox`: without one a new mailbox is its own,
 * and sends once a person claims it. With one, a new mailbox is the team's.
 */

export type { SavedMailbox }

type Env = Record<string, string | undefined>

const VALUE_FLAGS = new Set([
	"address",
	"name",
	"domain",
	"exec",
	"from",
	"subject",
	"tag",
	"trust",
	"timeout",
	"text",
	"html",
	"to",
	"cc",
	"bcc",
	"mailbox",
	"folder",
	"label",
	"q",
	"limit",
	"before",
	"status",
	"colour",
	"color",
	"in-reply-to",
	"attach",
])

const TRUSTS: ReadonlyArray<Trust> = ["owner", "thread", "stranger", "suspect"]
const FOLDERS: ReadonlyArray<Folder | "all"> = ["inbox", "archive", "spam", "trash", "sent", "all"]
const REVIEWS: ReadonlyArray<Review> = ["none", "new", "all"]
const COLOURS: ReadonlyArray<LabelColour> = ["grey", "amber", "red", "green", "blue"]

export interface MailboxArgs {
	sub: string | undefined
	positional: Array<string>
	flags: Record<string, string | true>
}

export function parse_mailbox_args(args: Array<string>): MailboxArgs {
	const positional: Array<string> = []
	const flags: Record<string, string | true> = {}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!arg.startsWith("--")) {
			positional.push(arg)
			continue
		}
		const eq = arg.indexOf("=")
		const name = arg.slice(2, eq === -1 ? undefined : eq)
		if (eq !== -1) flags[name] = arg.slice(eq + 1)
		else if (VALUE_FLAGS.has(name)) {
			const value = args[i + 1]
			if (value === undefined)
				throw new MailboxError({ message: `--${name} needs a value`, code: "invalid_args" })
			flags[name] = value
			i++
		} else flags[name] = true
	}
	return { sub: positional.shift(), positional, flags }
}

// ---------------------------------------------------------------------------------------
// Memory

/** `$XDG_CONFIG_HOME/postboi/mailboxes.json`, or `~/.config/postboi/mailboxes.json`. */
export function mailboxes_path(env: Env = process_env): string {
	return store_path(env, homedir(), join)
}

export function read_saved(path: string): Array<SavedMailbox> {
	try {
		return parse_saved(readFileSync(path, "utf8"))
	} catch {
		return []
	}
}

/** Keys are credentials: the file is the owner's alone. */
function write_saved(path: string, entries: Array<SavedMailbox>): void {
	write_atomically(
		{ mkdirSync, writeFileSync, chmodSync, renameSync, rmSync },
		dirname(path),
		path,
		serialise_saved(entries)
	)
}

export function remember(path: string, entry: SavedMailbox): void {
	write_saved(path, with_entry(read_saved(path), entry))
}

export function forget(path: string, address: string): void {
	write_saved(
		path,
		read_saved(path).filter((e) => e.address !== address)
	)
}

/**
 * Which mailbox a command means: `POSTBOI_MAILBOX_KEY` wins (the key alone names it), then
 * a named address from memory, then the most recent one. With nothing remembered and the
 * team's `POSTBOI_TOKEN` set, the team's: the answer is then `{ token }`, and the team's
 * mailbox the address names (or its only one) is found with it.
 */
export function pick_mailbox(
	saved: Array<SavedMailbox>,
	env: Env,
	address?: string
):
	| { key: string; base: string; address?: string }
	| { token: string; base: string; address?: string }
	| { error: string; code: string } {
	const base = (env.POSTBOI_MAILBOX_URL || MAILBOX_URL).replace(/\/+$/, "")
	if (address) {
		const found = saved.find((e) => names_address(e.address, address))
		if (found) return found
		if (env.POSTBOI_MAILBOX_KEY) return { key: env.POSTBOI_MAILBOX_KEY, base, address }
		if (env.POSTBOI_TOKEN) return { token: env.POSTBOI_TOKEN, base, address }
		return {
			error: `No key for ${address} on this machine. Set POSTBOI_TOKEN to your team's API key (postboi init writes it) to reach the team's mailboxes.`,
			code: "unknown_mailbox",
		}
	}
	if (env.POSTBOI_MAILBOX_KEY) return { key: env.POSTBOI_MAILBOX_KEY, base }
	if (saved[0]) return saved[0]
	if (env.POSTBOI_TOKEN) return { token: env.POSTBOI_TOKEN, base }
	return { error: "No mailbox yet. Make one with `postboi mailbox new`.", code: "no_mailbox" }
}

// ---------------------------------------------------------------------------------------
// Formatting

function clock(date: Date): string {
	return [date.getHours(), date.getMinutes(), date.getSeconds()]
		.map((n) => String(n).padStart(2, "0"))
		.join(":")
}

const TRUST_COLOUR: Record<Trust, (text: string) => string> = {
	owner: green,
	thread: cyan,
	stranger: dim,
	suspect: red,
}

/** One mail on one line: `12:04:31 · owner · Ann <ann@acme.com> · Book Thursday · 482913` */
export function format_line(mail: MailboxMail): string {
	const from = mail.name ? `${mail.name} <${mail.from}>` : mail.from
	const parts = [
		dim(clock(mail.received)),
		TRUST_COLOUR[mail.trust](mail.trust),
		from,
		bold(mail.subject),
	]
	if (mail.tag) parts.splice(3, 0, dim(`+${mail.tag}`))
	if (mail.code) parts.push(green(mail.code))
	if (mail.link) parts.push(cyan(mail.link))
	return parts.join(dim(" · "))
}

/** What `--exec` hands its command, beside the mail's JSON on stdin. */
export function exec_env(mail: MailboxMail): Record<string, string> {
	return {
		ID: mail.id,
		THREAD: mail.thread_id,
		TRUST: mail.trust,
		FROM: mail.from,
		TO: mail.to,
		SUBJECT: mail.subject,
		REPLY_TEXT: mail.reply_text ?? "",
		CODE: mail.code ?? "",
		LINK: mail.link ?? "",
		TAG: mail.tag ?? "",
	}
}

// ---------------------------------------------------------------------------------------
// Commands

interface Context {
	args: MailboxArgs
	env: Env
	path: string
	json: boolean
	out: (line: string) => void
	err: (line: string) => void
	fetch?: typeof fetch
	signal?: AbortSignal
}

class MailboxCommandError extends Error {
	constructor(
		message: string,
		readonly code: string
	) {
		super(message)
	}
}

function flag(ctx: Context, name: string): string | undefined {
	const value = ctx.args.flags[name]
	return typeof value === "string" ? value : undefined
}

function trust_flag(ctx: Context): Trust | undefined {
	const value = flag(ctx, "trust")
	if (value === undefined) return undefined
	if (!TRUSTS.includes(value as Trust))
		throw new MailboxCommandError(`--trust is one of ${TRUSTS.join(", ")}`, "invalid_args")
	return value as Trust
}

async function open(ctx: Context, address?: string): Promise<Mailbox> {
	const picked = pick_mailbox(read_saved(ctx.path), ctx.env, flag(ctx, "mailbox") ?? address)
	if ("error" in picked) throw new MailboxCommandError(picked.error, picked.code)
	if ("token" in picked) {
		const found = await open_or_make.find({
			token: picked.token,
			address: picked.address,
			base: picked.base,
			fetch: ctx.fetch,
		})
		if (found) return found
		throw new MailboxCommandError(
			picked.address
				? `Your team has no mailbox ${picked.address}. Make it with \`postboi mailbox new ${picked.address}\`.`
				: "Your team has no mailboxes yet. Make one with `postboi mailbox new`.",
			picked.address ? "unknown_mailbox" : "no_mailbox"
		)
	}
	const box = await open_or_make
		.open({ key: picked.key, base: picked.base, fetch: ctx.fetch })
		.catch((error: unknown) => {
			if (error instanceof MailboxError && error.status === 401 && picked.address)
				forget(ctx.path, picked.address)
			throw error
		})
	save(ctx, box)
	return box
}

function save(ctx: Context, box: Mailbox): void {
	if (!box.key) return
	const known = read_saved(ctx.path).find((e) => e.address === box.address)
	remember(ctx.path, {
		address: box.address,
		key: box.key,
		base: box.base,
		project: known?.project ?? cwd(),
		...((box.claim_url ?? known?.claim_url)
			? { claim_url: box.claim_url ?? known?.claim_url }
			: {}),
	})
}

async function create(ctx: Context): Promise<number> {
	const box = await open_or_make.create({
		address: flag(ctx, "address") ?? ctx.args.positional[0],
		name: flag(ctx, "name"),
		domain: flag(ctx, "domain"),
		token: ctx.env.POSTBOI_TOKEN || undefined,
		base: ctx.env.POSTBOI_MAILBOX_URL || undefined,
		fetch: ctx.fetch,
	})
	save(ctx, box)
	if (ctx.args.flags.env) {
		const url = box.base === MAILBOX_URL ? "" : ` POSTBOI_MAILBOX_URL=${box.base}`
		ctx.out(`export POSTBOI_MAILBOX_KEY=${box.key}${url}`)
	} else if (ctx.json) {
		ctx.out(JSON.stringify(box))
	} else {
		ctx.out(box.address)
		ctx.err(dim(`Key: ${box.key} (saved on this machine; it isn't shown again by the server)`))
		if (box.claim_url)
			ctx.err(`${yellow("It receives now, and sends once you claim it:")} ${cyan(box.claim_url)}`)
		ctx.err(dim("Watch it with `postboi mailbox watch`."))
	}
	return EXIT.ok
}

function run_exec(command: string, mail: MailboxMail, env: Env): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn(command, {
			shell: true,
			env: { ...env, ...exec_env(mail) },
			stdio: ["pipe", "inherit", "inherit"],
		})
		child.on("error", (error) => {
			stderr.write(`${yellow(`--exec failed: ${error.message}`)}\n`)
			resolve()
		})
		child.on("close", () => resolve())
		child.stdin.on("error", () => {})
		child.stdin.end(JSON.stringify(mail))
	})
}

async function watch(ctx: Context): Promise<number> {
	const box = await open(ctx, ctx.args.positional[0])
	ctx.err(`${dim("Watching")} ${bold(box.address)} ${dim("(Ctrl+C to stop)")}`)
	const controller = new AbortController()
	const stop = () => controller.abort()
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal
	process.once("SIGINT", stop)
	try {
		for await (const mail of box.watch({
			all: !!ctx.args.flags.all,
			tag: flag(ctx, "tag"),
			trust: trust_flag(ctx),
			from: parse_match(ctx.args.flags.from),
			subject: parse_match(ctx.args.flags.subject),
			signal,
		})) {
			ctx.out(ctx.json ? JSON.stringify(mail) : format_line(mail))
			const exec = flag(ctx, "exec")
			if (exec) await run_exec(exec, mail, ctx.env)
		}
	} finally {
		process.off("SIGINT", stop)
	}
	return EXIT.ok
}

async function wait(ctx: Context): Promise<number> {
	const { flags } = ctx.args
	const box = await open(ctx, ctx.args.positional[0])
	let mail: MailboxMail
	try {
		mail = await box.wait({
			tag: flag(ctx, "tag"),
			trust: trust_flag(ctx),
			from: parse_match(flags.from),
			subject: parse_match(flags.subject),
			timeout: flag(ctx, "timeout") ?? "60",
			after: flags.new ? box.cursor : undefined,
			signal: ctx.signal,
		})
	} catch (error) {
		if (!(error instanceof MailboxTimeoutError)) throw error
		report(ctx, error.message, "timeout")
		return EXIT.timeout
	}
	if (flags.code || flags.link) {
		const value = flags.code ? mail.code : mail.link
		if (!value) {
			report(ctx, `"${mail.subject}" has no ${flags.code ? "code" : "link"} in it`, "missing")
			return EXIT.missing
		}
		ctx.out(value)
		return EXIT.ok
	}
	ctx.out(ctx.json ? JSON.stringify(mail) : format_line(mail))
	return EXIT.ok
}

async function read(ctx: Context): Promise<number> {
	const { flags, positional } = ctx.args
	const which = positional[0] ?? "latest"
	const box = await open(ctx, positional[1])
	let id = which
	if (which === "latest") {
		const newest = (await box.list({ after: Math.max(0, box.cursor - 100) })).at(-1)
		if (!newest) throw new MailboxCommandError(`Nothing in ${box.address} yet`, "empty")
		id = newest.id
	}
	const mail = await box.read(id)
	if (flags.raw) {
		stdout.write(await mail.raw())
	} else if (flags.html) {
		ctx.out(mail.html ?? "")
	} else if (ctx.json) {
		ctx.out(JSON.stringify(mail))
	} else {
		ctx.out(`${dim("From:")}    ${mail.name ? `${mail.name} <${mail.from}>` : mail.from}`)
		ctx.out(`${dim("Trust:")}   ${TRUST_COLOUR[mail.trust](mail.trust)}`)
		ctx.out(`${dim("To:")}      ${mail.to}`)
		ctx.out(`${dim("Subject:")} ${bold(mail.subject)}`)
		ctx.out(`${dim("Date:")}    ${mail.received.toISOString()}`)
		ctx.out(`${dim("Thread:")}  ${mail.thread_id}`)
		if (mail.code) ctx.out(`${dim("Code:")}    ${green(mail.code)}`)
		if (mail.link) ctx.out(`${dim("Link:")}    ${cyan(mail.link)}`)
		ctx.out("")
		ctx.out(mail.reply_text ?? mail.text ?? dim("(no text part: try --html)"))
	}
	return EXIT.ok
}

function body_of(ctx: Context): { text?: string; html?: string } {
	const text = flag(ctx, "text")
	const html = flag(ctx, "html")
	if (!text && !html)
		throw new MailboxCommandError('Say something: --text "…" or --html "…"', "invalid_args")
	return { text, html }
}

function list_flag(ctx: Context, name: string): Array<string> | undefined {
	const value = flag(ctx, name)
	return value
		? value
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean)
		: undefined
}

async function reply(ctx: Context): Promise<number> {
	const [id, address] = ctx.args.positional
	if (!id)
		throw new MailboxCommandError(
			"Say which mail: `postboi mailbox reply <id> --text …`",
			"invalid_args"
		)
	const box = await open(ctx, address)
	const sent = await box.reply(id, {
		...body_of(ctx),
		cc: list_flag(ctx, "cc"),
		bcc: list_flag(ctx, "bcc"),
		subject: flag(ctx, "subject"),
		attachments: attachments_flag(ctx),
	})
	say_sent(ctx, sent)
	return EXIT.ok
}

async function send(ctx: Context): Promise<number> {
	const to = list_flag(ctx, "to")
	const subject = flag(ctx, "subject")
	if (!to?.length || !subject)
		throw new MailboxCommandError(
			'Say who and what: --to a@b.com --subject "…" --text "…"',
			"invalid_args"
		)
	const box = await open(ctx, ctx.args.positional[0])
	const sent = await box.send({
		to,
		subject,
		...body_of(ctx),
		cc: list_flag(ctx, "cc"),
		bcc: list_flag(ctx, "bcc"),
		in_reply_to: flag(ctx, "in-reply-to"),
		attachments: attachments_flag(ctx),
	})
	say_sent(ctx, sent)
	return EXIT.ok
}

/**
 * What a send came to. A held one prints its draft's id on stdout, so a script that keeps
 * the id still has the right one, and says on stderr that it waits for a person.
 */
function say_sent(ctx: Context, sent: SendResult): void {
	if (ctx.json) return ctx.out(JSON.stringify(sent))
	if (sent.status === "sent") return ctx.out(sent.id)
	ctx.out(sent.draft_id)
	ctx.err(
		`${yellow("Held for review, not sent.")} ${sent.message} ${dim("A person on the team sends it from the dashboard; don't send it again.")}`
	)
}

const TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".html": "text/html",
	".json": "application/json",
	".ics": "text/calendar",
	".zip": "application/zip",
}

/** `--attach a.pdf,b.png`: the files' bytes, named as they are on disk. */
function attachments_flag(ctx: Context): Array<MailboxAttachment> | undefined {
	const paths = list_flag(ctx, "attach")
	if (!paths) return undefined
	return paths.map((path) => {
		let content: Uint8Array
		try {
			content = readFileSync(path)
		} catch (error) {
			throw new MailboxCommandError(
				`Can't read ${path}: ${error instanceof Error ? error.message : String(error)}`,
				"invalid_args"
			)
		}
		const type = TYPES[extname(path).toLowerCase()]
		return { filename: basename(path), content, ...(type ? { type } : {}) }
	})
}

function thread_line(thread: MailboxThread): string {
	const who =
		thread.from_name || thread.from || (thread.to.length ? `to ${thread.to.join(", ")}` : "")
	const parts = [
		thread.unread ? cyan("●") : " ",
		dim(thread.thread_id),
		thread.trust ? TRUST_COLOUR[thread.trust](thread.trust) : dim("sent"),
		who,
		bold(thread.subject || "(no subject)"),
		dim(`${thread.messages} ${thread.messages === 1 ? "message" : "messages"}`),
	]
	if (thread.folder !== "inbox") parts.splice(2, 0, yellow(thread.folder))
	if (thread.labels.length) parts.push(thread.labels.map((label) => `#${label.name}`).join(" "))
	return parts.join(dim(" · "))
}

function choice<T extends string>(
	ctx: Context,
	name: string,
	options: ReadonlyArray<T>
): T | undefined {
	const value = flag(ctx, name)
	if (value === undefined) return undefined
	if (!options.includes(value as T))
		throw new MailboxCommandError(`--${name} is one of ${options.join(", ")}`, "invalid_args")
	return value as T
}

async function threads(ctx: Context): Promise<number> {
	const { flags } = ctx.args
	const box = await open(ctx, ctx.args.positional[0])
	const limit = flag(ctx, "limit")
	const folder = choice(ctx, "folder", FOLDERS)
	const rows = await box.threads({
		folder,
		label: flag(ctx, "label"),
		unread: flags.unread ? true : flags.read ? false : undefined,
		q: flag(ctx, "q"),
		limit: limit === undefined ? undefined : Number(limit),
		before: flag(ctx, "before"),
	})
	if (ctx.json) ctx.out(JSON.stringify(rows))
	else if (!rows.length)
		ctx.err(dim(`Nothing in ${box.address}'s ${folder ?? "inbox"} that matches.`))
	else for (const thread of rows) ctx.out(thread_line(thread))
	return EXIT.ok
}

function thread_arg(ctx: Context, usage: string): string {
	const id = ctx.args.positional[0]
	if (!id)
		throw new MailboxCommandError(`Say which thread: \`postboi mailbox ${usage}\``, "invalid_args")
	return id
}

function moved(ctx: Context, thread: MailboxThread): number {
	ctx.out(ctx.json ? JSON.stringify(thread) : thread_line(thread))
	return EXIT.ok
}

async function archive(ctx: Context): Promise<number> {
	const id = thread_arg(ctx, "archive <thread>")
	const box = await open(ctx, ctx.args.positional[1])
	return moved(ctx, await box.archive(id))
}

async function trash(ctx: Context): Promise<number> {
	const id = thread_arg(ctx, "trash <thread>")
	const box = await open(ctx, ctx.args.positional[1])
	return moved(ctx, await box.trash(id))
}

async function move(ctx: Context): Promise<number> {
	const [id, folder, address] = ctx.args.positional
	const settable = ["inbox", "archive", "spam", "trash"] as const
	if (!id || !settable.includes(folder as (typeof settable)[number]))
		throw new MailboxCommandError(
			"Say which thread and where: `postboi mailbox move <thread> <inbox, archive, spam or trash>`",
			"invalid_args"
		)
	const box = await open(ctx, address)
	return moved(ctx, await box.update_thread(id, { folder: folder as (typeof settable)[number] }))
}

async function mark(ctx: Context): Promise<number> {
	const id = thread_arg(ctx, "mark <thread> [--unread]")
	const box = await open(ctx, ctx.args.positional[1])
	return moved(ctx, await box.mark_read(id, !ctx.args.flags.unread))
}

async function label(ctx: Context): Promise<number> {
	const [id, ...names] = ctx.args.positional
	if (!id || !names.length)
		throw new MailboxCommandError(
			"Say which thread and which labels: `postboi mailbox label <thread> <name…> [--remove]`",
			"invalid_args"
		)
	const box = await open(ctx)
	const thread = await box.update_thread(
		id,
		ctx.args.flags.remove ? { remove_labels: names } : { add_labels: names }
	)
	return moved(ctx, thread)
}

async function labels(ctx: Context): Promise<number> {
	const [action, name, address] = ctx.args.positional
	if (action === "add" || action === "rm" || action === "delete") {
		if (!name)
			throw new MailboxCommandError(
				`Say which label: \`postboi mailbox labels ${action} <name>\``,
				"invalid_args"
			)
		const box = await open(ctx, address)
		if (action === "add") {
			const made = await box.create_label(
				name,
				choice(ctx, "colour", COLOURS) ?? choice(ctx, "color", COLOURS)
			)
			ctx.out(ctx.json ? JSON.stringify(made) : made.id)
		} else {
			await box.delete_label(name)
			if (ctx.json) ctx.out(JSON.stringify({ deleted: name }))
			else ctx.err(dim(`Deleted the label ${name}; it came off every thread.`))
		}
		return EXIT.ok
	}
	const box = await open(ctx, action)
	const rows = await box.labels()
	if (ctx.json) ctx.out(JSON.stringify(rows))
	else if (!rows.length)
		ctx.err(dim("No labels yet. `postboi mailbox label <thread> <name>` makes one as it labels."))
	else
		for (const row of rows)
			ctx.out(
				[
					bold(row.name),
					dim(row.colour),
					dim(`${row.threads} ${row.threads === 1 ? "thread" : "threads"}`),
					dim(row.id),
				].join(dim(" · "))
			)
	return EXIT.ok
}

function draft_line(draft: Draft): string {
	return [
		dim(draft.id),
		draft.status === "sent" ? green("sent") : draft.held ? yellow("held") : cyan("draft"),
		draft.to.join(", ") || dim("(nobody yet)"),
		bold(draft.subject || "(no subject)"),
		dim(`by ${draft.created_by}`),
	].join(dim(" · "))
}

async function drafts(ctx: Context): Promise<number> {
	const box = await open(ctx, ctx.args.positional[0])
	const rows = await box.drafts({ status: choice(ctx, "status", ["draft", "sent", "all"]) })
	if (ctx.json) ctx.out(JSON.stringify(rows))
	else if (!rows.length) ctx.err(dim(`No drafts waiting in ${box.address}.`))
	else for (const draft of rows) ctx.out(draft_line(draft))
	return EXIT.ok
}

function draft_fields(ctx: Context) {
	return {
		to: list_flag(ctx, "to"),
		cc: list_flag(ctx, "cc"),
		bcc: list_flag(ctx, "bcc"),
		subject: flag(ctx, "subject"),
		text: flag(ctx, "text"),
		html: flag(ctx, "html"),
		attachments: attachments_flag(ctx),
	}
}

/** `draft new|edit|send|rm`, and `draft <id>` to show one. */
async function draft(ctx: Context): Promise<number> {
	const [action, ...rest] = ctx.args.positional
	if (action === "new") {
		const box = await open(ctx, rest[0])
		const made = await box.create_draft({
			...draft_fields(ctx),
			in_reply_to: flag(ctx, "in-reply-to"),
		})
		ctx.out(ctx.json ? JSON.stringify(made) : made.id)
		if (!ctx.json) ctx.err(dim("Saved as a draft. Nothing was sent; the team has been told."))
		return EXIT.ok
	}
	const [id, address] = rest
	if (action === "edit" || action === "send" || action === "rm" || action === "delete") {
		if (!id)
			throw new MailboxCommandError(
				`Say which draft: \`postboi mailbox draft ${action} <id>\``,
				"invalid_args"
			)
		const box = await open(ctx, address)
		if (action === "edit") {
			const changed = await box.update_draft(id, draft_fields(ctx))
			ctx.out(ctx.json ? JSON.stringify(changed) : draft_line(changed))
		} else if (action === "send") {
			const sent = await box.send_draft(id)
			ctx.out(ctx.json ? JSON.stringify(sent) : sent.id)
		} else {
			await box.delete_draft(id)
			if (ctx.json) ctx.out(JSON.stringify({ deleted: id }))
			else ctx.err(dim(`Deleted ${id}`))
		}
		return EXIT.ok
	}
	if (!action)
		throw new MailboxCommandError(
			"Say what to do: `postboi mailbox draft new|edit|send|rm` or `draft <id>`",
			"invalid_args"
		)
	const box = await open(ctx, rest[0])
	const shown = await box.draft(action)
	if (ctx.json) ctx.out(JSON.stringify(shown))
	else {
		ctx.out(draft_line(shown))
		if (shown.cc.length) ctx.out(`${dim("Cc:")} ${shown.cc.join(", ")}`)
		ctx.out("")
		ctx.out(shown.text ?? shown.html ?? dim("(empty)"))
	}
	return EXIT.ok
}

async function forward(ctx: Context): Promise<number> {
	const [id, address] = ctx.args.positional
	const to = list_flag(ctx, "to")
	if (!id || !to?.length)
		throw new MailboxCommandError(
			'Say which mail and who to: `postboi mailbox forward <id> --to a@b.com [--text "…"]`',
			"invalid_args"
		)
	const box = await open(ctx, address)
	const sent = await box.forward(id, {
		to,
		cc: list_flag(ctx, "cc"),
		bcc: list_flag(ctx, "bcc"),
		text: flag(ctx, "text"),
		html: flag(ctx, "html"),
		attachments: ctx.args.flags["no-attachments"] ? false : undefined,
	})
	say_sent(ctx, sent)
	return EXIT.ok
}

/**
 * `review [none|new|all]`. Reading it needs any key; changing it needs the team's, since an
 * agent can't loosen its own leash. With POSTBOI_TOKEN the mailbox is opened as the team.
 */
async function review(ctx: Context): Promise<number> {
	let [wanted, address]: Array<string | undefined> = ctx.args.positional
	// `review orders-k3f9@agentboi.email` asks what it is, rather than setting it to an address.
	if (address === undefined && wanted?.includes("@")) [wanted, address] = [undefined, wanted]
	if (wanted !== undefined && !REVIEWS.includes(wanted as Review))
		throw new MailboxCommandError(`Review is one of ${REVIEWS.join(", ")}`, "invalid_args")
	const token = ctx.env.POSTBOI_TOKEN
	let box: Mailbox
	if (wanted && token) {
		// The team's key opens a mailbox by its address, so learn that first when none was named.
		const target = flag(ctx, "mailbox") ?? address ?? (await open(ctx)).address
		// Found as every other command finds it, so a name (`support`) works here too.
		const found = await open_or_make.find({
			token,
			address: target,
			base: ctx.env.POSTBOI_MAILBOX_URL || undefined,
			fetch: ctx.fetch,
		})
		if (!found)
			throw new MailboxCommandError(`Your team has no mailbox ${target}.`, "unknown_mailbox")
		box = found
	} else box = await open(ctx, address)
	if (wanted) {
		try {
			await box.set_review(wanted as Review)
		} catch (error) {
			if (error instanceof MailboxError && error.code === "team_key_required")
				throw new MailboxError({
					message: `Only the team changes who reviews ${box.address}: set POSTBOI_TOKEN to your team's API key, or change it on the dashboard's Mailboxes page.`,
					code: error.code,
					status: error.status,
				})
			throw error
		}
	} else await box.info()
	if (ctx.json) ctx.out(JSON.stringify({ address: box.address, review: box.review }))
	else {
		ctx.out(box.review)
		const says: Record<Review, string> = {
			none: "Everything it sends goes out.",
			new: "Replies go out; a new conversation waits for a person as a draft.",
			all: "Everything it sends waits for a person as a draft.",
		}
		ctx.err(dim(says[box.review]))
	}
	return EXIT.ok
}

async function rotate(ctx: Context): Promise<number> {
	const box = await open(ctx, ctx.args.positional[0])
	const key = await box.rotate()
	save(ctx, box)
	if (ctx.json) ctx.out(JSON.stringify({ address: box.address, key }))
	else {
		ctx.out(key)
		ctx.err(dim("The old key stopped working just now. This one is saved on this machine."))
	}
	return EXIT.ok
}

async function list(ctx: Context): Promise<number> {
	const saved = read_saved(ctx.path)
	if (ctx.json) {
		ctx.out(JSON.stringify(saved.map(({ key: _key, ...rest }) => rest)))
		return EXIT.ok
	}
	if (!saved.length) {
		ctx.err(dim("No mailboxes on this machine. Make one with `postboi mailbox new`."))
		return EXIT.ok
	}
	saved.forEach((entry, i) => {
		const mark = i === 0 ? cyan(" (default)") : ""
		const claim = entry.claim_url ? dim(` claim at ${entry.claim_url}`) : ""
		ctx.out(`${entry.address}${mark}${claim}`)
	})
	return EXIT.ok
}

async function remove(ctx: Context): Promise<number> {
	const box = await open(ctx, ctx.args.positional[0])
	await box.delete()
	forget(ctx.path, box.address)
	if (ctx.json) ctx.out(JSON.stringify({ deleted: box.address }))
	else ctx.err(dim(`Deleted ${box.address}`))
	return EXIT.ok
}

function report(ctx: Context, message: string, code?: string): void {
	ctx.err(
		ctx.json
			? JSON.stringify({ error: { message, code } })
			: red(message) + (code ? dim(` (${code})`) : "")
	)
}

const COMMANDS: Record<string, (ctx: Context) => Promise<number>> = {
	new: create,
	watch,
	wait,
	read,
	reply,
	send,
	threads,
	archive,
	trash,
	move,
	mark,
	label,
	labels,
	drafts,
	draft,
	forward,
	review,
	key: rotate,
	ls: list,
	list,
	rm: remove,
	delete: remove,
}

/** `postboi mailbox …`. Resolves to the exit code rather than exiting, so tests can run it. */
export async function mailbox_command(
	args: Array<string>,
	options: {
		env?: Env
		fetch?: typeof fetch
		out?: (line: string) => void
		err?: (line: string) => void
		signal?: AbortSignal
	} = {}
): Promise<number> {
	const env = options.env ?? process_env
	const json = args.includes("--json")
	const out = options.out ?? ((line: string) => void stdout.write(`${line}\n`))
	const err = options.err ?? ((line: string) => void stderr.write(`${line}\n`))
	let ctx: Context | undefined
	try {
		const parsed = parse_mailbox_args(args)
		ctx = {
			args: parsed,
			env,
			path: mailboxes_path(env),
			json,
			out,
			err,
			fetch: options.fetch,
			signal: options.signal,
		}
		if (
			parsed.flags.help ||
			parsed.sub === "help" ||
			args.includes("-h") ||
			parsed.sub === undefined
		) {
			out(help_text(["Agent mailboxes"]))
			return EXIT.ok
		}
		const run = COMMANDS[parsed.sub]
		if (!run) {
			report(
				ctx,
				`Unknown mailbox command: ${parsed.sub}. Try new, watch, wait, read, reply, send, forward, threads, archive, label, labels, drafts, draft, review, key, ls or rm.`,
				"invalid_args"
			)
			return EXIT.error
		}
		return await run(ctx)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		const code =
			error instanceof MailboxError || error instanceof MailboxCommandError
				? (error.code as string | undefined)
				: undefined
		const fallback: Context = {
			args: { sub: undefined, positional: [], flags: {} },
			env,
			path: "",
			json,
			out,
			err,
		}
		report(ctx ?? fallback, message, code)
		return EXIT.error
	}
}
