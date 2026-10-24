#!/usr/bin/env bun
/**
 * Freeze the outgoing docs version before a release.
 *
 * `src/site/content/docs/` always holds the latest docs, so the version that is
 * about to be superseded has to be copied into `src/site/content/v<prev>/` and
 * listed in `src/site/config/versions.json` — with the nav as it looked then, so
 * renaming or reordering pages in the new version can't reach back into the
 * archive.
 *
 * Both copies come from `--before`: the last commit that still carried the
 * outgoing version's docs. On a merge that's the commit the release PR landed
 * on, which is why this is worth running in CI — the hand-run version has to
 * guess at that ref, and guessing wrong archives the new docs under the old
 * version's name.
 *
 * Usage: bun scripts/snapshot-docs.ts --version X.Y.Z [--before <ref>]
 *
 * Minors only. `latest` names the docs *line*, not the published package, so a
 * patch leaves it where it is (0.33.1 ships with "latest": "0.33.0") — see
 * RELEASING.md. A patch release exits 0 having done nothing.
 */

import { execFileSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ContentItem } from "../src/site/config/navigation"

const VERSIONS_PATH = "src/site/config/versions.json"
const NAVIGATION_PATH = "src/site/config/navigation.ts"
const DOCS_PATH = "src/site/content/docs"

type Versions = {
	latest: string
	archived: Array<{ version: string; slug: string; nav: ContentItem[] }>
}

function git(...args: Array<string>) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
}

function fail(message: string): never {
	console.error(`✗ ${message}`)
	process.exit(1)
}

function arg(name: string) {
	const index = process.argv.indexOf(`--${name}`)
	return index === -1 ? undefined : process.argv[index + 1]
}

function minor_line(version: string) {
	const [major, minor] = version.split(".")
	return `${major}.${minor}`
}

/**
 * `navigation.ts` is data apart from its imports — `icon: Email` on the section,
 * types everywhere else — so stubbing the imports out leaves a module that
 * evaluates to exactly the nav we want to serialise. The archived nav only holds
 * `ContentItem`s (`icon` there is the boolean the sidebar renders from), so the
 * stubs never reach the output.
 */
async function read_navigation(before: string): Promise<Array<ContentItem>> {
	// Only component imports are provably safe to stub: the JSON round-trip
	// below drops component values anyway, so replacing them with undefined
	// can't change the archived data. A value import from anywhere else could
	// BE nav data — stubbing it would archive a silently corrupted nav — so
	// anything unrecognised aborts the release instead.
	const unstubbable: Array<string> = []
	const source = git("show", `${before}:${NAVIGATION_PATH}`)
		.replace(/^import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?[ \t]*$/gm, "")
		// A side-effect import has nothing to stub — and can't affect a data module.
		.replace(/^import\s+["'][^"']+["'];?[ \t]*$/gm, "")
		.replace(
			/^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm,
			(statement, clause: string, specifier: string) => {
				if (!/\.svelte$/.test(specifier) && !specifier.startsWith("carbon-icons-svelte")) {
					unstubbable.push(statement)
					return statement
				}
				const names = clause
					.replace(/[{}]/g, " ")
					.split(",")
					.map((part) =>
						part
							.trim()
							// `{ type Component, Email }` — the inline specifier is erased at runtime.
							.replace(/^type\s+/, "")
							.split(/\s+as\s+/)
							.pop()
							?.trim()
					)
					.filter((name): name is string => Boolean(name))
				return names.map((name) => `const ${name} = undefined`).join("\n")
			}
		)

	// A shape these regexes don't cover must abort the release, not evaluate wrong.
	if (unstubbable.length || /^import\b/m.test(source)) {
		fail(
			`${NAVIGATION_PATH} at ${before} has imports that may carry nav data — refusing to stub them:\n` +
				`${unstubbable.join("\n")}\n` +
				`If they can't affect the archived nav, teach read_navigation in scripts/snapshot-docs.ts about them.`
		)
	}

	const dir = mkdtempSync(join(tmpdir(), "postboi-nav-"))
	const file = join(dir, "navigation.ts")
	writeFileSync(file, source)

	try {
		const module = (await import(pathToFileURL(file).href)) as {
			contentSections?: Array<{ id: string; navigation: ContentItem[] }>
		}
		const docs = module.contentSections?.find((section) => section.id === "docs")
		if (!docs) fail(`no "docs" content section in ${NAVIGATION_PATH} at ${before}`)
		// Round-trip so components and undefined stubs drop out and only data lands in the file.
		const nav = JSON.parse(JSON.stringify(docs.navigation)) as Array<ContentItem>
		assert_nav(nav, before)
		return nav
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

/**
 * If a stubbed import was actually load-bearing data, the round trip leaves
 * holes instead of throwing — so refuse anything that isn't a complete nav.
 */
function assert_nav(items: unknown, before: string, path = "nav"): asserts items is ContentItem[] {
	if (!Array.isArray(items) || items.length === 0) {
		fail(
			`${path} from ${NAVIGATION_PATH} at ${before} is not a non-empty array — refusing to archive it`
		)
	}
	for (const [index, item] of items.entries()) {
		const at = `${path}[${index}]`
		if (typeof item !== "object" || item === null) {
			fail(
				`${at} from ${NAVIGATION_PATH} at ${before} is ${JSON.stringify(item)} — refusing to archive it`
			)
		}
		const entry = item as Record<string, unknown>
		if (typeof entry.slug !== "string" || typeof entry.name !== "string" || !entry.name) {
			fail(`${at} from ${NAVIGATION_PATH} at ${before} has no slug/name — refusing to archive it`)
		}
		if (entry.items !== undefined) assert_nav(entry.items, before, `${at}.items`)
	}
}

function extract_docs(before: string, destination: string) {
	if (!git("ls-tree", "--name-only", before, `${DOCS_PATH}/`).trim()) {
		fail(`${before} has no ${DOCS_PATH}/ to archive`)
	}

	const dir = mkdtempSync(join(tmpdir(), "postboi-docs-"))
	const archive = join(dir, "docs.tar")

	try {
		writeFileSync(
			archive,
			execFileSync("git", ["archive", "--format=tar", before, DOCS_PATH], {
				maxBuffer: 256 * 1024 * 1024,
			})
		)
		mkdirSync(destination, { recursive: true })
		// src/site/content/docs/<file> → <file>
		execFileSync("tar", ["-x", "--strip-components=4", "-C", destination, "-f", archive])
		// Docs from before package.json's imports map name the site `$site`.
		for (const file of readdirSync(destination)) {
			const svx = join(destination, file)
			writeFileSync(
				svx,
				readFileSync(svx, "utf8").replace(/(from\s+["'])\$site(?=["'/])/g, "$1#site")
			)
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const version =
	arg("version") ?? fail("usage: bun scripts/snapshot-docs.ts --version X.Y.Z [--before <ref>]")
const before = arg("before") ?? "HEAD"

if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`--version must be X.Y.Z, got "${version}"`)
git("rev-parse", "--verify", `${before}^{commit}`)

const versions = (await Bun.file(VERSIONS_PATH).json()) as Versions
const prev = versions.latest

if (prev === version) {
	console.log(`• ${VERSIONS_PATH} already names ${version} as latest — docs snapshot already taken`)
	process.exit(0)
}

if (minor_line(prev) === minor_line(version)) {
	console.log(
		`• ${version} is a patch on the ${minor_line(prev)} line — leaving "latest" at ${prev} (RELEASING.md: minors only)`
	)
	process.exit(0)
}

const slug = `v${prev}`
const destination = `src/site/content/${slug}`
if (existsSync(destination))
	fail(`${destination} already exists — snapshot it once, by hand or here, not both`)

extract_docs(before, destination)

versions.latest = version
versions.archived.unshift({ version: prev, slug, nav: await read_navigation(before) })
writeFileSync(VERSIONS_PATH, `${JSON.stringify(versions, null, "\t")}\n`)

console.log(
	`✓ froze ${prev} docs as ${destination} (from ${git("rev-parse", "--short", before).trim()})`
)
console.log(`✓ ${VERSIONS_PATH}: latest ${prev} → ${version}, archived ${slug}`)
