import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { getContentSectionModule, getContentSectionManifest } from '$lib/content/sections';
import { contentSections } from '$lib/config/navigation';

export const prerender = true;

// Single content section mounted at the site root.
const sectionId = contentSections[0].id;

export const entries = () =>
	getContentSectionManifest(sectionId).map((item) => ({ slug: item.slug }));

export const load: PageLoad = ({ params }) => {
	const slug = params.slug;

	const mod = getContentSectionModule(sectionId, slug);
	if (!mod) {
		error(404, 'Page not found');
	}

	return {
		component: mod.default,
		slug
	};
};
