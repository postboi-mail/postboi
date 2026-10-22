import { error, redirect } from "@sveltejs/kit"
import type { PageLoad } from "./$types"
import {
	getAllContentEntries,
	getContentSectionUiConfig,
	resolveSection,
} from "#site/content/sections.js"
import {
	getContentSectionMetadata,
	getContentSectionModule,
	getContentSectionTocHeadings,
} from "#site/content/sources.js"
import { resolveTocSelector } from "#site/config/content-ui.js"

export const prerender = true

/** Old URLs that still arrive from external links. */
const MOVED: Record<string, string> = {
	// The chat channel page became one page per platform.
	chat: "/slack",
}

// The moved slugs stay in the prerender list so their redirect pages exist as files —
// otherwise an old link 404s at the asset layer before the redirect could run.
export const entries = () => [
	...getAllContentEntries(),
	...Object.keys(MOVED).map((slug) => ({ slug })),
]

// Title, description and headings load here rather than in the layout: they belong to one
// page, and this node is dropped from the Worker once the page is prerendered, which keeps
// every archived version's Markdown out of the deployed script. The layout reads them off
// `page.data`.
export const load: PageLoad = async ({ params, url }) => {
	const moved = MOVED[params.slug]
	if (moved) redirect(308, moved)

	const { sectionId, slug } = resolveSection(`/${params.slug}`)

	const mod = await getContentSectionModule(sectionId, slug)
	if (!mod) {
		error(404, "Page not found")
	}

	const tocSelector = resolveTocSelector(getContentSectionUiConfig(sectionId).toc, slug)

	return {
		component: mod.default,
		slug,
		metadata: await getContentSectionMetadata(sectionId, url.pathname),
		tocHeadings: await getContentSectionTocHeadings(sectionId, slug, tocSelector),
	}
}
