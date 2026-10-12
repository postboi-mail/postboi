import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { env as process_env, stderr, stdout } from "node:process"
import {
	mailbox as open_or_make,
	Mailbox,
	MailboxError,
	MailboxTimeoutError,
	MAILBOX_URL,
	type MailboxMail,
	type Trust,
} from "../library/mailbox.js"
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

/** One mailbox this machine made or opened, as `mailboxes.json` keeps it. Most recent first. */
export interface SavedMailbox {
	address: string
	key: string
	base: string
	claim_url?: string
}

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
])

const TRUSTS: ReadonlyArray<Trust> = ["owner", "thread", "stranger", "suspect"]

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
	const root = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config")
	return join(root, "postboi", "mailboxes.json")
}

export function read_saved(path: string): Array<SavedMailbox> {
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"))
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	return parsed.filter(
		(entry): entry is SavedMailbox =>
			!!entry &&
			typeof entry.address === "string" &&
			typeof entry.key === "string" &&
			typeof entry.base === "string"
	)
}

/** Keys are credentials: the file is the owner's alone. */
function write_saved(path: string, entries: Array<SavedMailbox>): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	writeFileSync(path, `${JSON.stringify(entries, null, "\t")}\n`, { mode: 0o600 })
	try {
		chmodSync(path, 0o600)
	} catch {
		// Windows, or a filesystem without modes.
	}
}

export function remember(path: string, entry: SavedMailbox): void {
	write_saved(path, [entry, ...read_saved(path).filter((e) => e.address !== entry.address)])
}

export function forget(path: string, address: string): void {
	write_saved(
		path,
		read_saved(path).filter((e) => e.address !== address)
	)
}

/**
 * Which mailbox a command means: `POSTBOI_MAILBOX_KEY` wins (the key alone names it), then
 * a named address from memory, then the most recent one.
 */
export function pick_mailbox(
	saved: Array<SavedMailbox>,
	env: Env,
	address?: string
): { key: string; base: string; address?: string } | { error: string; code: string } {
	const base = (env.POSTBOI_MAILBOX_URL || MAILBOX_URL).replace(/\/+$/, "")
	if (address) {
		const wanted = address.replace(/\+[^@]*@/, "@").toLowerCase()
		const found = saved.find((e) => e.address.toLowerCase() === wanted)
		if (found) return found
		if (env.POSTBOI_MAILBOX_KEY) return { key: env.POSTBOI_MAILBOX_KEY, base, address }
		return {
			error: `No key for ${address} on this machine. Set POSTBOI_MAILBOX_KEY to use one made elsewhere.`,
			code: "unknown_mailbox",
		}
	}
	if (env.POSTBOI_MAILBOX_KEY) return { key: env.POSTBOI_MAILBOX_KEY, base }
	if (saved[0]) return saved[0]
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
	const picked = pick_mailbox(read_saved(ctx.path), ctx.env, address)
	if ("error" in picked) throw new MailboxCommandError(picked.error, picked.code)
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
	})
	ctx.out(ctx.json ? JSON.stringify(sent) : sent.id)
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
	})
	ctx.out(ctx.json ? JSON.stringify(sent) : sent.id)
	return EXIT.ok
}

async function threads(ctx: Context): Promise<number> {
	const box = await open(ctx, ctx.args.positional[0])
	const rows = await box.threads()
	if (ctx.json) ctx.out(JSON.stringify(rows))
	else if (!rows.length) ctx.err(dim(`No conversations in ${box.address} yet.`))
	else
		for (const thread of rows)
			ctx.out(
				[
					dim(thread.thread_id),
					TRUST_COLOUR[thread.trust](thread.trust),
					thread.from_name || thread.from,
					bold(thread.subject),
					dim(`${thread.messages} ${thread.messages === 1 ? "message" : "messages"}`),
				].join(dim(" · "))
			)
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
				`Unknown mailbox command: ${parsed.sub}. Try new, watch, wait, read, reply, send, threads, key, ls or rm.`,
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
