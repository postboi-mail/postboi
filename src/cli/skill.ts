import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { bold, dim, green, type create_prompts } from "./prompts.js"

type Prompts = ReturnType<typeof create_prompts>

export const SKILL_TARGET = join(".claude", "skills", "postboi", "SKILL.md")

/**
 * The agent skill ships inside the npm package (skills/postboi/SKILL.md) so an installed
 * copy always matches the installed version.
 */
export function bundled_skill(): string | undefined {
	// ../skills resolves from dist/cli.js in the published package, ../../skills from src/cli in dev.
	for (const path of ["../skills/postboi/SKILL.md", "../../skills/postboi/SKILL.md"]) {
		try {
			return readFileSync(new URL(path, import.meta.url), "utf8")
		} catch {
			// try the next location
		}
	}
	return undefined
}

/**
 * Rewrite an already-installed copy that drifted from the bundled one, so upgrades don't
 * leave a stale skill behind. Never creates the file — installing is init's (prompted) job.
 */
export function refresh_skill(target = SKILL_TARGET, skill = bundled_skill()): boolean {
	if (!skill || !existsSync(target) || readFileSync(target, "utf8") === skill) return false
	writeFileSync(target, skill)
	console.log(`${green("✓")} refreshed the agent skill at ${bold(target)}`)
	return true
}

/** Offer to install the agent skill into .claude/skills/; an existing copy is refreshed silently. */
export async function offer_skill(prompts: Prompts, target = SKILL_TARGET): Promise<void> {
	const skill = bundled_skill()
	if (!skill) return
	if (existsSync(target)) {
		refresh_skill(target, skill)
		return
	}
	const question = `\nInstall the ${bold("postboi")} agent skill? ${dim("— teaches AI coding agents the library")}`
	if (!(await prompts.confirm(question))) return
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, skill)
	console.log(`${green("✓")} wrote ${bold(target)} — commit it so agents pick it up`)
}
