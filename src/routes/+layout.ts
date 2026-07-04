import type { LayoutLoad } from "./$types"
import {
	getContentSectionAdjacentItems,
	getContentSectionMetadata,
	getContentSectionTocHeadings,
	getContentSectionUiConfig,
	resolveSection,
} from "$lib/content/sections"
import { resolveTocSelector } from "$lib/config/content-ui"

export const prerender = true

export const load: LayoutLoad = ({ url }) => {
	const { sectionId, slug } = resolveSection(url.pathname)
	const { previous, next } = getContentSectionAdjacentItems(sectionId, slug)
	const metadata = getContentSectionMetadata(sectionId, url.pathname)
	const sectionUi = getContentSectionUiConfig(sectionId)
	const tocSelector = resolveTocSelector(sectionUi.toc, slug)
	const tocHeadings = getContentSectionTocHeadings(sectionId, slug, tocSelector)

	return {
		sectionId,
		slug,
		metadata,
		tocHeadings,
		previousDoc: previous,
		nextDoc: next,
		docOrigin: url.origin,
	}
}
