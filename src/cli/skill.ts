import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { bold, dim, green, red, type create_prompts } from "./prompts.js"

type Prompts = ReturnType<typeof create_prompts>

export const SKILL_TARGET = join(".claude", "skills", "postboi", "SKILL.md")
/** The same skill for agents that read the Agent Skills layout rather than Claude's. */
export const AGENTS_TARGET = join(".agents", "skills", "postboi", "SKILL.md")
/** The file most other agents read first; a pointer there is the whole footprint. */
export const AGENTS_MD = "AGENTS.md"

/** What the pointer in AGENTS.md says — short, because the skill is where the content is. */
export const AGENTS_MD_POINTER = `
## Postboi

Email here goes through the \`postboi\` package. Before touching mail, forms or exports,
read \`.claude/skills/postboi/SKILL.md\` (the same file is at
\`node_modules/postboi/skills/postboi/SKILL.md\`) and run \`bunx postboi doctor\`.
`

/** Where the package keeps the skill, relative to its root — the same path the link targets. */
const SKILL_IN_PACKAGE = join("skills", "postboi")
const REFERENCES = "references"

/**
 * The agent skill ships inside the npm package (skills/postboi/SKILL.md) so an installed
 * copy always matches the installed version.
 */
export function bundled_skill_path(): string | undefined {
	// ../skills resolves from dist/cli.js in the published package, ../../skills from src/cli in dev.
	for (const path of ["../skills/postboi/SKILL.md", "../../skills/postboi/SKILL.md"]) {
		const file = fileURLToPath(new URL(path, import.meta.url))
		if (existsSync(file)) return file
	}
	return undefined
}

export function bundled_skill(): string | undefined {
	const file = bundled_skill_path()
	return file ? readFileSync(file, "utf8") : undefined
}

/**
 * The recipes SKILL.md points at (`references/exports.md`) live beside it in the package,
 * and an agent reads them on demand — so they are installed beside the copy too.
 */
export function bundled_references_path(): string | undefined {
	const skill = bundled_skill_path()
	if (!skill) return undefined
	const dir = join(dirname(skill), REFERENCES)
	return existsSync(dir) ? dir : undefined
}

/** existsSync follows symlinks, so a dangling link (package not installed yet) reads as absent. */
function present(path: string): boolean {
	try {
		lstatSync(path)
		return true
	} catch {
		return false
	}
}

function is_link(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink()
	} catch {
		return false
	}
}

/**
 * Link the installed skill at node_modules/postboi/skills — new releases then land with no
 * diff at all. Falls back to a copy where symlinks don't work (Windows without dev mode).
 */
function link_skill(target: string, source = bundled_skill_path()): boolean {
	return link_installed(target, join(SKILL_IN_PACKAGE, "SKILL.md"), source)
}

/** Link `target` at `sub` inside the installed package, or at `source` when none is found. */
function link_installed(target: string, sub: string, source: string | undefined): boolean {
	try {
		// Prefer node_modules/postboi over import.meta.url: pnpm and bun resolve the running
		// file into a version-pinned store path, which would pin the link to today's version.
		const dir = realpathSync(dirname(resolve(target)))
		const nm = ancestors(dir)
			.map((d) => join(d, "node_modules", "postboi", sub))
			.find((p) => existsSync(p))
		if (!nm && !source) return false
		rmSync(target, { force: true, recursive: true })
		// The link is resolved from the *real* directory, so anything symlinked above the
		// target (macOS /var, a linked checkout) would send a relative link astray.
		symlinkSync(relative(dir, nm ?? source!), target)
		return true
	} catch {
		return false
	}
}

/**
 * Put `references/` beside an installed SKILL.md — a link like the skill's where links
 * work, a copy where they don't. Returns true when it was absent and is now there; an
 * existing link is left alone and an existing copy is refreshed silently, matching
 * `refresh_skill`'s idea of what deserves a line.
 */
function place_references(target: string): boolean {
	const source = bundled_references_path()
	if (!source) return false
	const dest = join(dirname(target), REFERENCES)
	const was_present = present(dest)
	if (was_present && is_link(dest)) return false
	if (!link_installed(dest, join(SKILL_IN_PACKAGE, REFERENCES), source)) {
		try {
			cpSync(source, dest, { recursive: true })
		} catch {
			return false
		}
	}
	return !was_present
}

function ancestors(dir: string): Array<string> {
	const out = [dir]
	for (let d = dirname(dir); d !== out[out.length - 1]; d = dirname(d)) out.push(d)
	return out
}

/**
 * Point an already-installed copy at the bundled skill, so upgrades don't leave a stale one
 * behind. Never creates the file — installing is init's (prompted) job.
 */
export function refresh_skill(target = SKILL_TARGET, skill = bundled_skill()): boolean {
	if (!skill || !present(target)) return false
	// An install from before the skill had references gets them on the next refresh.
	const added_references = place_references(target)
	if (added_references) {
		console.log(
			`${green("✓")} added ${bold(join(dirname(target), REFERENCES))} beside the agent skill`
		)
	}
	if (is_link(target)) return added_references // already live — the link tracks the installed version
	if (link_skill(target)) {
		console.log(
			`${green("✓")} linked ${bold(target)} to the installed postboi ${dim("— future releases update it with no diff")}`
		)
		return true
	}
	if (readFileSync(target, "utf8") === skill) return added_references
	writeFileSync(target, skill)
	console.log(`${green("✓")} refreshed the agent skill at ${bold(target)}`)
	return true
}

/**
 * Where the installed skill stands, for `postboi doctor`: absent, a link (always current),
 * a copy that matches the bundled one, or a copy that has fallen behind it.
 */
export function skill_state(
	target = SKILL_TARGET,
	skill = bundled_skill()
): "missing" | "linked" | "current" | "stale" {
	if (!present(target)) return "missing"
	if (is_link(target)) return "linked"
	try {
		return skill !== undefined && readFileSync(target, "utf8") === skill ? "current" : "stale"
	} catch {
		return "stale"
	}
}

/**
 * The other places a skill install reaches, derived from the Claude target so a test
 * pointing at a temp file gets none of them: `.agents/skills/…` beside `.claude/skills/…`,
 * and the project's AGENTS.md when it has one.
 */
export function companions(target: string): { agents?: string; agents_md?: string } {
	const claude = join(".claude", "skills", "postboi", "SKILL.md")
	if (!target.endsWith(claude)) return {}
	const root = target.slice(0, -claude.length)
	return { agents: join(root, AGENTS_TARGET), agents_md: join(root, AGENTS_MD) }
}

/**
 * Append the pointer to an AGENTS.md that exists and doesn't already mention postboi.
 * Never creates the file: a project without one has chosen not to have one.
 */
export function point_agents_md(path: string | undefined): boolean {
	if (!path || !existsSync(path)) return false
	const current = readFileSync(path, "utf8")
	if (/postboi/i.test(current)) return false
	writeFileSync(path, current.replace(/\s*$/, "\n") + AGENTS_MD_POINTER)
	console.log(`${green("✓")} pointed ${bold(path)} at the skill`)
	return true
}

/** Install or refresh the skill's companions beside a freshly placed Claude copy. */
function place_companions(target: string, skill: string): void {
	const { agents, agents_md } = companions(target)
	if (agents) {
		if (present(agents)) refresh_skill(agents, skill)
		else install_skill(agents, skill)
	}
	point_agents_md(agents_md)
}

/** Offer to install the agent skill into .claude/skills/; an existing copy is refreshed silently. */
export async function offer_skill(prompts: Prompts, target = SKILL_TARGET): Promise<void> {
	const skill = bundled_skill()
	if (!skill) return
	if (present(target)) {
		refresh_skill(target, skill)
		place_companions(target, skill)
		return
	}
	const question = `\nInstall the ${bold("postboi")} agent skill? ${dim("— teaches AI coding agents the library")}`
	if (!(await prompts.confirm(question))) return
	install_skill(target, skill)
	place_companions(target, skill)
}

/** Write (or link) the skill into place. Callers decide whether to ask first. */
function install_skill(target: string, skill: string): void {
	mkdirSync(dirname(target), { recursive: true })
	place_references(target)
	if (link_skill(target)) {
		console.log(
			`${green("✓")} linked ${bold(target)} to the installed postboi ${dim("— commit it; upgrades update the skill for free")}`
		)
		// The link points into node_modules, so a fresh clone has it dangling until deps are
		// installed — and a dangling skill is silently absent rather than visibly broken.
		console.log(dim("  (it resolves once dependencies are installed — say so in your README)"))
		return
	}
	writeFileSync(target, skill)
	console.log(`${green("✓")} wrote ${bold(target)} — commit it so agents pick it up`)
}

/**
 * `bunx postboi skill` — install the skill on its own, no prompts and no other setup.
 *
 * The prompted offer only fires during `init`, so the case it misses is the common one:
 * postboi is already a dependency (often added by the very agent that then has to guess at
 * the API), init never ran, and nothing in an installed package announces itself. This is
 * the one command to reach for there.
 *
 * Returns false when the bundled skill can't be found, so the caller can exit non-zero.
 */
export function skill_command(target = SKILL_TARGET): boolean {
	const skill = bundled_skill()
	if (!skill) {
		console.log(red("Couldn't find the bundled skill — is postboi installed in this project?"))
		return false
	}
	// An existing copy is upgraded to a link where it can be; already-linked is a no-op that
	// still deserves a line, or the command looks like it did nothing.
	if (present(target)) {
		if (!refresh_skill(target, skill)) {
			console.log(`${green("✓")} already installed at ${bold(target)}`)
		}
		place_companions(target, skill)
		return true
	}
	install_skill(target, skill)
	place_companions(target, skill)
	return true
}
