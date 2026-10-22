import type { LayoutLoad } from "./$types"
import { getContentSectionAdjacentItems, resolveSection } from "#site/content/sections.js"

export const prerender = true

// Nav data only. A page's own metadata and headings are loaded by `+page.ts` and read back
// here through `page.data` — the layout node is the one node SvelteKit always ships to the
// Worker, so anything it imports ships with it, and `#site/content/sources` is every
// archived version of the docs. See the note at the top of that file.
export const load: LayoutLoad = async ({ url }) => {
	const { sectionId, slug } = resolveSection(url.pathname)
	const { previous, next } = getContentSectionAdjacentItems(sectionId, slug)

	return {
		sectionId,
		slug,
		previousDoc: previous,
		nextDoc: next,
		docOrigin: url.origin,
	}
}
