/**
 * The mailboxes this machine made or opened, with their keys, in one file the library, the
 * CLI and `postboi mcp` all read. It is what lets `mailbox()` open the same address on the
 * next run without anyone copying a key into `.env`: a mailbox made without the team's
 * key is remembered here, under the directory it was made from.
 *
 * Node and Bun only. Everywhere else (a Worker, a browser) there is nothing to remember
 * with, and every function here is a quiet no-op.
 */

/** One mailbox, as `mailboxes.json` keeps it. Most recent first. */
export interface SavedMailbox {
	address: string
	key: string
	base: string
	claim_url?: string
	/** The directory it was made from, so a project's `mailbox()` finds its own. */
	project?: string
}

type Env = Record<string, string | undefined>

/** `$XDG_CONFIG_HOME/postboi/mailboxes.json`, or `~/.config/postboi/mailboxes.json`. */
export function store_path(env: Env, home: string, join: (...parts: Array<string>) => string) {
	const root = env.XDG_CONFIG_HOME || join(env.HOME || home, ".config")
	return join(root, "postboi", "mailboxes.json")
}

/** What the file says, keeping only entries that are whole. */
export function parse_saved(text: string): Array<SavedMailbox> {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
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

/** `entry` first, replacing any older entry for the same address, keeping its project. */
export function with_entry(saved: Array<SavedMailbox>, entry: SavedMailbox): Array<SavedMailbox> {
	const old = saved.find((e) => e.address === entry.address)
	const project = entry.project ?? old?.project
	return [
		{ ...entry, ...(project ? { project } : {}) },
		...saved.filter((e) => e.address !== entry.address),
	]
}

/**
 * Whether `ref` names this address: the whole address (a `+tag` ignored), or the name it
 * was asked for, which agentboi.email gives a short suffix (`support` is `support-k3f9@`).
 */
export function names_address(address: string, ref: string): boolean {
	const wanted = ref
		.replace(/\+[^@]*@/, "@")
		.trim()
		.toLowerCase()
	const have = address.toLowerCase()
	if (wanted.includes("@")) return have === wanted
	const local = have.split("@")[0]
	return local === wanted || new RegExp(`^${escape(wanted)}-[a-z0-9]{4}$`).test(local)
}

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Which remembered mailbox a call means: one named by `ref`, or else the newest made from
 * `project`. Only entries for `base` count, so a preview's mailboxes never answer for
 * agentboi.email's.
 */
export function recall_entry(
	saved: Array<SavedMailbox>,
	base: string,
	options: { ref?: string; project?: string }
): SavedMailbox | undefined {
	const here = saved.filter((e) => e.base === base)
	if (options.ref) return here.find((e) => names_address(e.address, options.ref!))
	if (options.project) return here.find((e) => e.project === options.project)
	return undefined
}

interface Disk {
	path: string
	read(): string | undefined
	write(text: string): void
	cwd: string
}

/** The file and the working directory, or undefined where there is no filesystem. */
async function disk(env?: Env): Promise<Disk | undefined> {
	if (typeof process === "undefined" || !process.versions?.node) return undefined
	try {
		const fs = await import("node:fs")
		const { dirname, join } = await import("node:path")
		const { homedir } = await import("node:os")
		const path = store_path(env ?? process.env, homedir(), join)
		return {
			path,
			cwd: process.cwd(),
			read() {
				try {
					return fs.readFileSync(path, "utf8")
				} catch {
					return undefined
				}
			},
			// Keys are credentials: the file is the owner's alone.
			write(text) {
				write_atomically(fs, dirname(path), path, text)
			},
		}
	} catch {
		return undefined
	}
}

/**
 * Write the file whole or not at all: the library, the CLI and `postboi mcp` read it from
 * separate processes, and a reader that caught it half-written would parse nothing and
 * write back only its own entry, losing every other key. A rename is atomic on one
 * filesystem, so a reader sees the old file or the new one.
 */
export function write_atomically(
	fs: Pick<
		typeof import("node:fs"),
		"mkdirSync" | "writeFileSync" | "chmodSync" | "renameSync" | "rmSync"
	>,
	dir: string,
	path: string,
	text: string
): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
	try {
		fs.writeFileSync(temp, text, { mode: 0o600 })
		try {
			fs.chmodSync(temp, 0o600)
		} catch {
			// Windows, or a filesystem without modes.
		}
		fs.renameSync(temp, path)
	} catch (error) {
		try {
			fs.rmSync(temp, { force: true })
		} catch {
			// Nothing to tidy.
		}
		throw error
	}
}

export function serialise_saved(entries: Array<SavedMailbox>): string {
	return `${JSON.stringify(entries, null, "\t")}\n`
}

/** The remembered mailbox a call means, and the directory it is asked from. */
export async function recall(
	base: string,
	ref: string | undefined,
	env?: Env
): Promise<SavedMailbox | undefined> {
	const file = await disk(env)
	if (!file) return undefined
	return recall_entry(parse_saved(file.read() ?? "[]"), base, { ref, project: file.cwd })
}

/** Keep `entry`, as made from this directory. Best effort: a read-only disk keeps nothing. */
export async function keep(entry: SavedMailbox, env?: Env): Promise<void> {
	const file = await disk(env)
	if (!file) return
	try {
		const saved = parse_saved(file.read() ?? "[]")
		file.write(serialise_saved(with_entry(saved, { project: file.cwd, ...entry })))
	} catch {
		// Nowhere to write: the next run makes another, as it always did.
	}
}

/** Drop a mailbox whose key stopped working. */
export async function drop(address: string, env?: Env): Promise<void> {
	const file = await disk(env)
	if (!file) return
	try {
		const saved = parse_saved(file.read() ?? "[]")
		if (saved.some((e) => e.address === address))
			file.write(serialise_saved(saved.filter((e) => e.address !== address)))
	} catch {
		// As above.
	}
}
