import type { RequestHandler } from "./$types"
import { siteConfig } from "$lib"
import { contentSections } from "$lib/config/navigation"
import { getContentSectionManifest, getContentSectionRawSource } from "$lib/content/sections"

export const GET: RequestHandler = () => {
	const seen = new Set<string>()
	const documents = contentSections.flatMap((section) =>
		getContentSectionManifest(section.id).flatMap((item) => {
			const key = `${section.id}:${item.slug}`
			if (seen.has(key)) return []
			seen.add(key)
			const content = getContentSectionRawSource(section.id, item.slug)
			return content ? [content.trim()] : []
		})
	)

	const preamble = [
		`# ${siteConfig.name}`,
		"",
		`> ${siteConfig.name} — ${siteConfig.description}`,
		"",
		"This file contains the complete documentation as a single Markdown document.",
		"A per-page index is available at `/llms.txt`, and individual pages at `/raw/<slug>`.",
	].join("\n")

	const body = [preamble, ...documents].join("\n\n---\n\n") + "\n"

	return new Response(body, {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "public, max-age=3600",
		},
	})
}
