import type { LayoutLoad } from './$types';
import {
	getContentSectionAdjacentItems,
	getContentSectionMetadata,
	getContentSectionSlug,
	getContentSectionTocHeadings,
	getContentSectionUiConfig
} from '$lib/content/sections';
import { contentSections } from '$lib/config/navigation';
import { resolveTocSelector } from '$lib/config/content-ui';

export const prerender = true;

// Single content section mounted at the site root.
const sectionId = contentSections[0].id;

export const load: LayoutLoad = ({ url }) => {
	const slug = getContentSectionSlug(sectionId, url.pathname);
	const { previous, next } = getContentSectionAdjacentItems(sectionId, slug);
	const metadata = getContentSectionMetadata(sectionId, url.pathname);
	const sectionUi = getContentSectionUiConfig(sectionId);
	const tocSelector = resolveTocSelector(sectionUi.toc, slug);
	const tocHeadings = getContentSectionTocHeadings(sectionId, slug, tocSelector);

	return {
		sectionId,
		slug,
		metadata,
		tocHeadings,
		previousDoc: previous,
		nextDoc: next,
		docOrigin: url.origin
	};
};
