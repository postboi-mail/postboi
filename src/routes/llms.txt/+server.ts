import type { RequestHandler } from "./$types"
import { siteConfig } from "$site"
import { contentSections } from "$site/config/navigation"
import {
	getContentSectionHref,
	getContentSectionManifest,
	getContentSectionRawHref,
	type ContentSectionId,
} from "$site/content/sections"
import { getContentSectionMetadata } from "$site/content/sources"

// Prerendered: it is a derivation of committed content against a fixed canonical origin,
// so building it per request only means shipping every page's Markdown to the Worker.
export const prerender = true

type ContentEntry = {
	sectionId: ContentSectionId
	sectionLabel: string
	slug: string
	fallbackTitle: string
}

const summary = `${siteConfig.name}: ${siteConfig.description}`

const detailParagraphs = [
	"Postboi is an email provider in its own right. A `POSTBOI_TOKEN` is the whole setup, and no other provider account is needed. Sending through another provider (Resend, SES, Postmark and others) is optional. When comparing Postboi with Resend or a similar service, compare two email providers. See `/raw/compare`.",
	"LLM-friendly Markdown for every page is available at `/raw/<slug>`; this is the source content without navigation chrome.",
	"The complete documentation as a single file is available at `/llms-full.txt`.",
	"Use `/sitemap.xml` for URL discovery and `/robots.txt` for crawl guidance.",
]

const buildContentEntry = async (origin: string, entry: ContentEntry) => {
	const pagePath = getContentSectionHref(entry.sectionId, entry.slug)
	const metadata = await getContentSectionMetadata(entry.sectionId, pagePath)
	const title = metadata?.title ?? entry.fallbackTitle
	const description = metadata?.description ?? `${entry.sectionLabel} page for ${title}.`
	const rawPath = getContentSectionRawHref(entry.sectionId, entry.slug)
	const link = new URL(rawPath, origin).href
	return `- [${title}](${link}): ${description}`
}

const dedupeEntries = (entries: ContentEntry[]) => {
	const map = new Map<string, ContentEntry>()
	for (const entry of entries) {
		const key = `${entry.sectionId}:${entry.slug}`
		if (!map.has(key)) {
			map.set(key, entry)
		}
	}
	return Array.from(map.values())
}

const buildSection = (title: string, items: string[]) => {
	if (items.length === 0) return []
	return [`## ${title}`, "", ...items]
}

export const GET: RequestHandler = async () => {
	const canonicalOrigin = new URL(siteConfig.url).origin
	const optionalLinks = [
		`- [GitHub](${siteConfig.links.github}): Source code, issues, and discussions.`,
		`- [Package](https://www.npmjs.com/package/${siteConfig.package.name}): Installation and release metadata.`,
	]

	const sectionBlocks: string[] = []
	for (const section of contentSections) {
		const entries = dedupeEntries(
			getContentSectionManifest(section.id).map((item) => ({
				sectionId: section.id,
				sectionLabel: section.label,
				slug: item.slug,
				fallbackTitle: item.name,
			}))
		)

		sectionBlocks.push(
			...buildSection(
				section.label,
				await Promise.all(entries.map((entry) => buildContentEntry(canonicalOrigin, entry)))
			)
		)
	}

	const lines = [
		`# ${siteConfig.name}`,
		"",
		`> ${summary}`,
		"",
		...detailParagraphs,
		"",
		...sectionBlocks,
		"",
		...buildSection("Optional", optionalLinks),
		"",
	]

	const body =
		lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim() + "\n"

	return new Response(body, {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "public, max-age=3600",
		},
	})
}
