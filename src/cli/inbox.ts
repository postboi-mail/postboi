import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { env as process_env, stdout, stderr } from "node:process"
import {
	temp,
	Inbox,
	InboxError,
	InboxTimeoutError,
	TEMP_INBOX_URL,
	type Mail,
	type Match,
} from "../library/temp_inbox.js"
import { hmac_sha256, base64_decode, base64_encode } from "../library/webhooks/crypto.js"
import { open_browser } from "./postboi.js"
import { help_text } from "./help.js"
import { bold, cyan, dim, green, yellow, red } from "./prompts.js"

/**
 * `postboi inbox`: throwaway inboxes at tempboi.email from the terminal. No POSTBOI_TOKEN
 * needed, so it deliberately stays out of `api_command`, which refuses without one.
 *
 * Everything goes through the `postboi/inbox` helper, so there is one client. What this
 * file adds is memory (the inboxes this machine made, with their tokens, so an address
 * can be left off) and the shapes a shell wants: one line per mail, NDJSON, exit codes.
 */

/** One inbox this machine made, as `inboxes.json` keeps it. Most recent first. */
export interface SavedInbox {
	address: string
	token: string
	expires: string
	base: string
}

type Env = Record<string, string | undefined>

// ---------------------------------------------------------------------------------------
// Arguments

const VALUE_FLAGS = new Set([
	"name",
	"ttl",
	"forward",
	"exec",
	"from",
	"subject",
	"tag",
	"timeout",
	"secret",
])

export interface InboxArgs {
	sub: string | undefined
	positional: Array<string>
	flags: Record<string, string | true>
}

/** `["wait", "--code", "--timeout", "30"]` → `{ sub: "wait", flags: { code: true, timeout: "30" } }`. */
export function parse_inbox_args(args: Array<string>): InboxArgs {
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
				throw new InboxError({ message: `--${name} needs a value`, code: "invalid_args" })
			flags[name] = value
			i++
		} else flags[name] = true
	}
	return { sub: positional.shift(), positional, flags }
}

/** A filter as typed: `/^Your code/i` is a RegExp, anything else a substring. */
export function parse_match(value: string | true | undefined): Match | undefined {
	if (typeof value !== "string") return undefined
	const regex = /^\/(.+)\/([a-z]*)$/.exec(value)
	if (regex) {
		try {
			return new RegExp(regex[1], regex[2])
		} catch {
			return value
		}
	}
	return value
}

// ---------------------------------------------------------------------------------------
// Memory

/** `$XDG_CONFIG_HOME/postboi/inboxes.json`, or `~/.config/postboi/inboxes.json`. */
export function inboxes_path(env: Env = process_env): string {
	const root = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config")
	return join(root, "postboi", "inboxes.json")
}

/** The saved inboxes that haven't expired, most recent first. A missing or broken file is none. */
export function read_saved(path: string, now = Date.now()): Array<SavedInbox> {
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"))
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	return parsed.filter(
		(entry): entry is SavedInbox =>
			!!entry &&
			typeof entry.address === "string" &&
			typeof entry.token === "string" &&
			typeof entry.base === "string" &&
			typeof entry.expires === "string" &&
			new Date(entry.expires).getTime() > now
	)
}

/** Tokens are credentials: the file is the owner's alone. */
export function write_saved(path: string, entries: Array<SavedInbox>): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	writeFileSync(path, `${JSON.stringify(entries, null, "\t")}\n`, { mode: 0o600 })
	try {
		chmodSync(path, 0o600)
	} catch {
		// Windows, or a filesystem without modes.
	}
}

/** Put an inbox at the front, where an omitted address finds it. Expired ones drop out. */
export function remember(path: string, entry: SavedInbox, now = Date.now()): Array<SavedInbox> {
	const entries = [entry, ...read_saved(path, now).filter((e) => e.address !== entry.address)]
	write_saved(path, entries)
	return entries
}

export function forget(path: string, address: string, now = Date.now()): void {
	write_saved(
		path,
		read_saved(path, now).filter((e) => e.address !== address)
	)
}

/** `quiet-otter-k3f9+run-42@tempboi.email` → `quiet-otter-k3f9@tempboi.email`. */
export function untagged(address: string): string {
	return address.replace(/\+[^@]*@/, "@")
}

/**
 * Which inbox a command means: the env pair wins, then a named address from memory, then
 * the most recent one. Undefined `token` means we know the address and not how to read it.
 */
export function pick_inbox(
	saved: Array<SavedInbox>,
	env: Env,
	address?: string
): SavedInbox | { error: string; code: string } {
	const base = (env.POSTBOI_INBOX_URL || TEMP_INBOX_URL).replace(/\/+$/, "")
	// The token alone names its inbox; `attach` looks the address up when it isn't given.
	// POSTBOI_INBOX is also the dev inbox's port or `off`, so it only counts as an address.
	const env_address = env.POSTBOI_INBOX?.includes("@") ? env.POSTBOI_INBOX : ""
	const from_env = env.POSTBOI_INBOX_TOKEN
		? { address: env_address, token: env.POSTBOI_INBOX_TOKEN, base, expires: "" }
		: undefined
	if (address) {
		const wanted = untagged(address).toLowerCase()
		if (from_env?.address && untagged(from_env.address).toLowerCase() === wanted) return from_env
		const found = saved.find((e) => e.address.toLowerCase() === wanted)
		if (found) return found
		return {
			error: `No token for ${address} on this machine. Set POSTBOI_INBOX_TOKEN to read one made elsewhere.`,
			code: "unknown_inbox",
		}
	}
	if (from_env) return from_env
	if (saved[0]) return saved[0]
	return { error: "No inbox yet. Make one with `postboi inbox`.", code: "no_inbox" }
}

// ---------------------------------------------------------------------------------------
// Formatting

function clock(date: Date): string {
	return [date.getHours(), date.getMinutes(), date.getSeconds()]
		.map((n) => String(n).padStart(2, "0"))
		.join(":")
}

/** One mail on one line: `12:04:31 · Acme <no-reply@acme.com> · Verify your email · 482913 · https://…` */
export function format_line(mail: Mail): string {
	const from = mail.name ? `${mail.name} <${mail.from}>` : mail.from
	const parts = [dim(clock(mail.received)), from, bold(mail.subject ?? "(no subject)")]
	if (mail.tag) parts.splice(2, 0, dim(`+${mail.tag}`))
	if (mail.code) parts.push(green(mail.code))
	if (mail.link) parts.push(cyan(mail.link))
	return parts.join(dim(" · "))
}

/** "in 42m", "in 3h 5m". */
export function expires_in(expires: Date | string, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((new Date(expires).getTime() - now) / 60_000))
	if (minutes < 60) return `in ${minutes}m`
	const hours = Math.floor(minutes / 60)
	return minutes % 60 ? `in ${hours}h ${minutes % 60}m` : `in ${hours}h`
}

/**
 * A mail as Postboi's own `email.received` webhook would have delivered it, so a handler
 * written for receiving can be pointed at `--forward` and tested with no tunnel.
 */
export function forward_payload(mail: Mail, now = new Date()) {
	return {
		type: "email.received",
		created_at: now.toISOString(),
		data: {
			message_id: mail.id,
			from: mail.from,
			to: mail.to,
			subject: mail.subject ?? undefined,
			html: mail.html ?? undefined,
			text: mail.text ?? undefined,
			timestamp: mail.received.toISOString(),
			tags: mail.tag ? [mail.tag] : undefined,
		},
	}
}

/** Standard-webhooks headers for a body, the way Postboi signs one. */
export async function sign_forward(body: string, secret: string, id: string, now = Date.now()) {
	const timestamp = String(Math.floor(now / 1000))
	const key = base64_decode(secret.replace(/^whsec_/, ""))
	const signature = base64_encode(await hmac_sha256(key, `${id}.${timestamp}.${body}`))
	return {
		"webhook-id": id,
		"webhook-timestamp": timestamp,
		"webhook-signature": `v1,${signature}`,
	}
}

/** What `--exec` hands its command, beside the mail's JSON on stdin. */
export function exec_env(mail: Mail): Record<string, string> {
	return {
		SUBJECT: mail.subject ?? "",
		FROM: mail.from,
		TO: mail.to,
		CODE: mail.code ?? "",
		LINK: mail.link ?? "",
		ID: mail.id,
		TAG: mail.tag ?? "",
	}
}

// ---------------------------------------------------------------------------------------
// Commands

/** Exit codes `wait` promises a script. */
export const EXIT = { ok: 0, error: 1, timeout: 2, missing: 3 } as const

interface Context {
	args: InboxArgs
	env: Env
	path: string
	json: boolean
	out: (line: string) => void
	err: (line: string) => void
	fetch?: typeof fetch
	signal?: AbortSignal
}

class InboxCommandError extends Error {
	constructor(
		message: string,
		readonly code: string
	) {
		super(message)
	}
}

async function open_inbox(ctx: Context, address?: string): Promise<Inbox> {
	const picked = pick_inbox(read_saved(ctx.path), ctx.env, address)
	if ("error" in picked) throw new InboxCommandError(picked.error, picked.code)
	const inbox = await temp.attach({ ...picked, fetch: ctx.fetch }).catch((error: unknown) => {
		// Gone on the server: stop offering it as the default.
		if (error instanceof InboxError && error.status === 404) forget(ctx.path, picked.address)
		throw error
	})
	// Remembered either way, so an inbox claimed with its token is the default afterwards.
	save(ctx, inbox)
	return inbox
}

function save(ctx: Context, inbox: Inbox): void {
	remember(ctx.path, {
		address: inbox.address,
		token: inbox.token,
		expires: inbox.expires.toISOString(),
		base: inbox.base,
	})
}

async function create(ctx: Context): Promise<number> {
	const { flags } = ctx.args
	const inbox = await temp({
		name: typeof flags.name === "string" ? flags.name : undefined,
		ttl: typeof flags.ttl === "string" ? flags.ttl : undefined,
		base: ctx.env.POSTBOI_INBOX_URL || undefined,
		fetch: ctx.fetch,
	})
	save(ctx, inbox)
	if (flags.env) {
		const url = inbox.base === TEMP_INBOX_URL ? "" : ` POSTBOI_INBOX_URL=${inbox.base}`
		ctx.out(`export POSTBOI_INBOX=${inbox.address} POSTBOI_INBOX_TOKEN=${inbox.token}${url}`)
	} else if (ctx.json) {
		ctx.out(JSON.stringify(inbox))
	} else {
		ctx.out(inbox.address)
		ctx.err(dim(`Expires ${expires_in(inbox.expires)}. Watch it with \`postboi inbox watch\`.`))
		if (inbox.urls?.web) ctx.err(dim(`In a browser: ${inbox.urls.web}`))
	}
	return EXIT.ok
}

async function deliver_forward(ctx: Context, mail: Mail, url: string): Promise<void> {
	const body = JSON.stringify(forward_payload(mail))
	const secret =
		typeof ctx.args.flags.secret === "string"
			? ctx.args.flags.secret
			: ctx.env.POSTBOI_WEBHOOK_SECRET
	const headers: Record<string, string> = { "content-type": "application/json" }
	if (secret) Object.assign(headers, await sign_forward(body, secret, `whmsg_${mail.id}`))
	try {
		const response = await (ctx.fetch ?? fetch)(url, { method: "POST", headers, body })
		if (!response.ok) ctx.err(yellow(`Forward to ${url} answered ${response.status}`))
	} catch (error) {
		ctx.err(yellow(`Forward to ${url} failed: ${error instanceof Error ? error.message : error}`))
	}
}

function run_exec(command: string, mail: Mail, env: Env): Promise<void> {
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
		child.stdin.on("error", () => {}) // a command that never reads stdin
		child.stdin.end(JSON.stringify(mail))
	})
}

async function watch(ctx: Context): Promise<number> {
	const { flags, positional } = ctx.args
	const inbox = await open_inbox(ctx, positional[0])
	ctx.err(
		`${dim("Watching")} ${bold(inbox.address)} ${dim(`(expires ${expires_in(inbox.expires)}, Ctrl+C to stop)`)}`
	)
	const controller = new AbortController()
	const stop = () => controller.abort()
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal
	process.once("SIGINT", stop)
	try {
		for await (const mail of inbox.watch({
			all: !!flags.all,
			tag: typeof flags.tag === "string" ? flags.tag : undefined,
			from: parse_match(flags.from),
			subject: parse_match(flags.subject),
			signal,
		})) {
			ctx.out(ctx.json ? JSON.stringify(mail) : format_line(mail))
			if (typeof flags.forward === "string") await deliver_forward(ctx, mail, flags.forward)
			if (typeof flags.exec === "string") await run_exec(flags.exec, mail, ctx.env)
		}
	} finally {
		process.off("SIGINT", stop)
	}
	return EXIT.ok
}

async function wait(ctx: Context): Promise<number> {
	const { flags, positional } = ctx.args
	const inbox = await open_inbox(ctx, positional[0])
	const timeout = typeof flags.timeout === "string" ? flags.timeout : "60"
	let mail: Mail
	try {
		mail = await inbox.wait({
			tag: typeof flags.tag === "string" ? flags.tag : undefined,
			from: parse_match(flags.from),
			subject: parse_match(flags.subject),
			timeout,
			after: flags.new ? inbox.cursor : undefined,
			signal: ctx.signal,
		})
	} catch (error) {
		if (!(error instanceof InboxTimeoutError)) throw error
		report(ctx, error.message, "timeout")
		return EXIT.timeout
	}
	if (flags.code || flags.link) {
		const value = flags.code ? mail.code : mail.link
		if (!value) {
			report(
				ctx,
				`The mail "${mail.subject ?? ""}" has no ${flags.code ? "code" : "link"} in it`,
				flags.code ? "no_code" : "no_link"
			)
			return EXIT.missing
		}
		ctx.out(value)
		return EXIT.ok
	}
	if (ctx.json) ctx.out(JSON.stringify(mail))
	else ctx.out(format_line(mail))
	return EXIT.ok
}

async function read(ctx: Context): Promise<number> {
	const { flags, positional } = ctx.args
	const which = positional[0] ?? "latest"
	const inbox = await open_inbox(ctx, positional[1])
	let id = which
	if (which === "latest") {
		const newest = (await inbox.list()).at(-1)
		if (!newest) throw new InboxCommandError(`Nothing in ${inbox.address} yet`, "empty")
		id = newest.id
	}
	const mail = await inbox.read(id)
	if (flags.raw) {
		stdout.write(await mail.raw())
	} else if (flags.html) {
		ctx.out(mail.html ?? "")
	} else if (flags.headers) {
		for (const [name, value] of mail.headers) ctx.out(`${name}: ${value}`)
	} else if (ctx.json) {
		ctx.out(JSON.stringify(mail))
	} else {
		ctx.out(`${dim("From:")}    ${mail.name ? `${mail.name} <${mail.from}>` : mail.from}`)
		ctx.out(`${dim("To:")}      ${mail.to}`)
		ctx.out(`${dim("Subject:")} ${bold(mail.subject ?? "(no subject)")}`)
		ctx.out(`${dim("Date:")}    ${mail.received.toISOString()}`)
		if (mail.code) ctx.out(`${dim("Code:")}    ${green(mail.code)}`)
		if (mail.link) ctx.out(`${dim("Link:")}    ${cyan(mail.link)}`)
		if (mail.attachments.length)
			ctx.out(`${dim("Files:")}   ${mail.attachments.map((a) => a.filename ?? a.type).join(", ")}`)
		ctx.out("")
		ctx.out(mail.text ?? dim("(no text part: try --html)"))
	}
	return EXIT.ok
}

async function list(ctx: Context): Promise<number> {
	const saved = read_saved(ctx.path)
	if (ctx.json) {
		ctx.out(JSON.stringify(saved.map(({ token: _token, ...rest }) => rest)))
		return EXIT.ok
	}
	if (!saved.length) {
		ctx.err(dim("No inboxes on this machine. Make one with `postboi inbox`."))
		return EXIT.ok
	}
	saved.forEach((entry, i) => {
		const mark = i === 0 ? cyan(" (default)") : ""
		ctx.out(`${entry.address}  ${dim(`expires ${expires_in(entry.expires)}`)}${mark}`)
	})
	return EXIT.ok
}

async function remove(ctx: Context): Promise<number> {
	const inbox = await open_inbox(ctx, ctx.args.positional[0]).catch((error: unknown) => {
		if (error instanceof InboxError && error.status === 404) return undefined
		throw error
	})
	if (inbox) {
		await inbox.delete()
		forget(ctx.path, inbox.address)
	}
	if (ctx.json)
		ctx.out(JSON.stringify({ deleted: inbox?.address ?? ctx.args.positional[0] ?? null }))
	else ctx.err(dim(`Deleted ${inbox?.address ?? "(already gone)"}`))
	return EXIT.ok
}

async function extend(ctx: Context): Promise<number> {
	const [ttl, address] = ctx.args.positional
	if (!ttl) throw new InboxCommandError("Say how long: `postboi inbox extend 2h`", "invalid_args")
	const inbox = await open_inbox(ctx, address)
	await inbox.extend(ttl)
	save(ctx, inbox)
	if (ctx.json) ctx.out(JSON.stringify(inbox))
	else ctx.out(`${inbox.address} ${dim(`now expires ${expires_in(inbox.expires)}`)}`)
	return EXIT.ok
}

async function open(ctx: Context): Promise<number> {
	const inbox = await open_inbox(ctx, ctx.args.positional[0])
	const url = inbox.urls?.web
	if (!url) throw new InboxCommandError("tempboi gave no web address for this inbox", "no_url")
	ctx.out(url)
	open_browser(url)
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
	open,
	ls: list,
	list,
	rm: remove,
	delete: remove,
	extend,
}

/**
 * `postboi inbox …`. Resolves to the exit code rather than exiting, so tests can run it
 * and so a piped stdout is flushed before the process ends.
 */
export async function inbox_command(
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
		const parsed = parse_inbox_args(args)
		ctx = {
			args: parsed,
			env,
			path: inboxes_path(env),
			json,
			out,
			err,
			fetch: options.fetch,
			signal: options.signal,
		}
		// `npx tempboi --help` must not mint an inbox, which a bare `inbox` otherwise does.
		if (parsed.flags.help || parsed.sub === "help" || args.includes("-h")) {
			out(help_text(["Temp inboxes"]))
			return EXIT.ok
		}
		const run = parsed.sub === undefined ? create : COMMANDS[parsed.sub]
		if (!run) {
			report(
				ctx,
				`Unknown inbox command: ${parsed.sub}. Try new, watch, wait, read, open, ls, rm or extend.`,
				"invalid_args"
			)
			return EXIT.error
		}
		return await run(ctx)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		const code =
			error instanceof InboxError || error instanceof InboxCommandError
				? (error.code as string | undefined)
				: undefined
		const fallback = {
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
