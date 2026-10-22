import { parseContentSource } from "#site/content/frontmatter.js"
import {
	getContentSectionConfig,
	getContentSectionHref,
	getContentSectionItemBySlug,
	getContentSectionSlug,
	type ContentMetadata,
	type ContentModule,
	type ContentSectionId,
	type ContentTocHeading,
} from "#site/content/sections.js"
import GithubSlugger from "github-slugger"

// Every page's own source: the compiled component, the Markdown behind it, the frontmatter
// and headings read back out of that Markdown — for the live docs and all 47 archived
// versions alike.
//
// Lazy on purpose — these globs cover every archived version snapshot, and eager they
// all land in ONE chunk that every visitor downloads and that grows with every release.
// It crossed Workers' 25 MiB static-asset limit at 33 versions and broke deploys; lazy,
// each page is its own chunk, fetched when someone actually opens it.
//
// Lazy alone doesn't save the server, though: a Worker has to carry every module it could
// reach, dynamic imports included, so whatever imports this file drags every version into
// the deployed script — that is what crossed the 62 MiB Worker limit at 0.41.0. Import it
// only from routes that prerender (the page, the endpoints), never from `+layout.ts` or
// `+layout.svelte`: SvelteKit always keeps the root layout in the Worker's manifest, so an
// import there is an import in production. What the layout needs is in `sections.ts`.
const allSvxRaw = import.meta.glob<string>("/src/site/content/**/*.svx", {
	query: "?raw",
	import: "default",
})

const allSvxModules = import.meta.glob<ContentModule>("/src/site/content/**/*.svx")

const allSvelteModules = import.meta.glob<ContentModule>("/src/site/content/**/*.svelte")

const allSvelteMetadatas = import.meta.glob<Record<string, unknown>>(
	"/src/site/content/**/*.svelte",
	{
		import: "metadata",
	}
)

function toBaseKey(sectionId: string, slug: string): string {
	const filename = slug === "" ? "index" : slug
	return `/src/site/content/${sectionId}/${filename}`
}

function findSvxKey(sectionId: string, slug: string): string | null {
	const svxKey = `${toBaseKey(sectionId, slug)}.svx`
	return Object.prototype.hasOwnProperty.call(allSvxModules, svxKey) ? svxKey : null
}

function findSvelteKey(sectionId: string, slug: string): string | null {
	const svelteKey = `${toBaseKey(sectionId, slug)}.svelte`
	return Object.prototype.hasOwnProperty.call(allSvelteModules, svelteKey) ? svelteKey : null
}

export async function getContentSectionMetadata(
	sectionId: ContentSectionId,
	pathname: string
): Promise<ContentMetadata | null> {
	const section = getContentSectionConfig(sectionId)
	const slug = getContentSectionSlug(sectionId, pathname)
	const svxKey = findSvxKey(sectionId, slug)
	const svelteKey = findSvelteKey(sectionId, slug)

	if (!svxKey && !svelteKey) {
		return null
	}

	const navItem = getContentSectionItemBySlug(sectionId, slug)
	const fallbackTitle = slugToTitle(slug) || section.label
	let title = navItem?.name ?? fallbackTitle
	let description: string | undefined
	const sourceType: ContentMetadata["sourceType"] = svxKey ? "svx" : "svelte"

	if (svxKey) {
		const rawSource = await allSvxRaw[svxKey]()
		const { metadata } = parseContentSource(rawSource)
		title = metadata.name ?? metadata.title ?? title
		description = metadata.description
	} else if (svelteKey) {
		const meta = await allSvelteMetadatas[svelteKey]()
		title =
			(typeof meta.name === "string" ? meta.name : undefined) ??
			(typeof meta.title === "string" ? meta.title : undefined) ??
			title
		description = typeof meta.description === "string" ? meta.description : undefined
	}

	return {
		href: getContentSectionHref(sectionId, slug),
		slug,
		title,
		description,
		sourceType,
	}
}

export async function getContentSectionModule(
	sectionId: ContentSectionId,
	slug: string
): Promise<ContentModule | null> {
	const svxKey = findSvxKey(sectionId, slug)
	if (svxKey) {
		return allSvxModules[svxKey]()
	}

	const svelteKey = findSvelteKey(sectionId, slug)
	if (svelteKey) {
		return allSvelteModules[svelteKey]()
	}

	return null
}

export async function getContentSectionRawSource(
	sectionId: ContentSectionId,
	slug: string
): Promise<string | null> {
	const svxKey = findSvxKey(sectionId, slug)
	if (!svxKey) return null
	return allSvxRaw[svxKey]()
}

/** Whether raw source exists for a slug — sync, for prerender entry lists. */
export function hasContentSectionRawSource(sectionId: ContentSectionId, slug: string): boolean {
	return findSvxKey(sectionId, slug) !== null
}

export async function getContentSectionTocHeadings(
	sectionId: ContentSectionId,
	slug: string,
	selector: string
): Promise<ContentTocHeading[]> {
	const rawSource = await getContentSectionRawSource(sectionId, slug)
	if (!rawSource) return []

	const { body } = parseContentSource(rawSource)
	return extractTocHeadings(body, selector)
}

function slugToTitle(slug: string) {
	return slug
		.split("/")
		.filter(Boolean)
		.map((segment) => segment.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()))
		.join(" - ")
}

function extractHeadingLevels(selector: string) {
	const levels = new Set<number>()
	const headingRe = /\bh([1-6])\b/gi
	let match: RegExpExecArray | null

	while ((match = headingRe.exec(selector))) {
		levels.add(Number(match[1]))
	}

	return levels.size > 0 ? levels : new Set([2, 3])
}

function decodeHtmlEntities(value: string) {
	const namedEntities: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
	}

	return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, raw: string) => {
		if (raw.startsWith("#")) {
			const radix = raw[1].toLowerCase() === "x" ? 16 : 10
			const codePoint = Number.parseInt(raw.slice(radix === 16 ? 2 : 1), radix)
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
		}

		return namedEntities[raw.toLowerCase()] ?? entity
	})
}

function normalizeHeadingText(rawText: string) {
	return decodeHtmlEntities(
		rawText
			.replace(/\s+#+\s*$/g, "")
			.replace(/\\([\\`*_[\]{}()#+.!|-])/g, "$1")
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/`([^`]*)`/g, "$1")
			.replace(/<[^>]+>/g, "")
			.replace(/\{([^{}]*)\}/g, "$1")
			.replace(/[*_~]/g, "")
			.replace(/\s+/g, " ")
			.trim()
	)
}

function extractTocHeadings(source: string, selector: string): ContentTocHeading[] {
	const levels = extractHeadingLevels(selector)
	const slugger = new GithubSlugger()
	const headings: ContentTocHeading[] = []
	let inFence = false

	for (const line of source.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence
			continue
		}

		if (inFence) continue

		const match = /^( {0,3})(#{1,6})\s+(.+?)\s*$/.exec(line)
		if (!match) continue

		const level = match[2].length
		if (!levels.has(level)) continue

		const text = normalizeHeadingText(match[3])
		if (!text) continue

		headings.push({
			id: slugger.slug(text),
			text,
			level,
		})
	}

	return headings
}
