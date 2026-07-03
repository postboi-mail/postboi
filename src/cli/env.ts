/** Supported env-file flavours and how a line is written for each. */
export type EnvFormat = "dotenv" | "direnv" | "devvars"

export type EnvTarget = {
	file: string
	format: EnvFormat
	/** Optional note shown to the user (e.g. varlock schema reminder). */
	note?: string
}

/**
 * Decide which env file(s) a project uses from a directory listing. Recognises varlock
 * (`.env.schema`), dotenv (`.env`, `.env.local`), direnv (`.envrc`) and Cloudflare
 * Workers (`.dev.vars`). Falls back to `.env` when nothing is detected.
 */
export function detect_env_targets(files: ReadonlyArray<string>): Array<EnvTarget> {
	const has = (name: string) => files.includes(name)
	const targets: Array<EnvTarget> = []

	if (has(".env.schema")) {
		// varlock: values live in .env, declarations in .env.schema
		targets.push({
			file: ".env",
			format: "dotenv",
			note: "remember to declare it in .env.schema (varlock)",
		})
	} else if (has(".env")) {
		targets.push({ file: ".env", format: "dotenv" })
	}
	if (has(".env.local") && !targets.some((t) => t.file === ".env.local")) {
		targets.push({ file: ".env.local", format: "dotenv" })
	}
	if (has(".envrc")) targets.push({ file: ".envrc", format: "direnv" })
	if (has(".dev.vars")) targets.push({ file: ".dev.vars", format: "devvars" })

	if (targets.length === 0) targets.push({ file: ".env", format: "dotenv" })
	return targets
}

/** Quote a value safely for an env file (tokens rarely need it, but be correct). */
function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** Format a single `KEY=value` assignment for the given flavour. */
export function format_line(format: EnvFormat, key: string, value: string): string {
	const assignment = `${key}=${quote(value)}`
	return format === "direnv" ? `export ${assignment}` : assignment
}

/**
 * Insert or replace a `KEY=` assignment in existing env-file content, preserving the
 * rest. Returns the updated content (newline-terminated).
 */
export function upsert_env(content: string, key: string, value: string, format: EnvFormat): string {
	const line = format_line(format, key, value)
	const pattern = new RegExp(`^(export\\s+)?${escape_regex(key)}=.*$`, "m")

	if (pattern.test(content)) return content.replace(pattern, line)

	const base = content.length === 0 || content.endsWith("\n") ? content : `${content}\n`
	return `${base}${line}\n`
}

/**
 * Drop a `KEY=` assignment from env-file content, or return the content unchanged when
 * the key isn't there. Older inits wrote default fields (POSTBOI_FROM, …) to the
 * environment; they're config-first now, and a stale env var silently shadows the config.
 */
export function remove_env(content: string, key: string): string {
	const pattern = new RegExp(`^(export\\s+)?${escape_regex(key)}=.*\\n?`, "m")
	return content.replace(pattern, "")
}

/** Does a .gitignore already cover this file? Handles plain names and simple `*` globs. */
export function is_gitignored(gitignore: string, file: string): boolean {
	return gitignore
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"))
		.some((rule) => {
			const normalized = rule.replace(/^\//, "").replace(/\/$/, "")
			if (!normalized.includes("*")) return normalized === file
			const regex = new RegExp(`^${normalized.split("*").map(escape_regex).join(".*")}$`)
			return regex.test(file)
		})
}

function escape_regex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
