import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getContentSectionRawSource, getContentSectionManifest } from '$lib/content/sections';
import { contentSections } from '$lib/config/navigation';

const normalize = (value: string) => value.replace(/^\/+|\/+$/g, '');

export const prerender = true;

// Single content section mounted at the site root.
const sectionId = contentSections[0].id;

export const entries = () =>
	getContentSectionManifest(sectionId)
		.filter((item) => getContentSectionRawSource(sectionId, item.slug))
		.map((item) => ({ slug: item.slug || 'index' }));

export const GET: RequestHandler = ({ params }) => {
	const slugParam = normalize(params.slug);
	const targetSlug = slugParam === '' || slugParam === 'index' ? '' : slugParam;

	const content = getContentSectionRawSource(sectionId, targetSlug);

	if (!content) {
		error(404, 'Document not found');
	}

	return new Response(content, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			'Cache-Control': 'public, max-age=60',
			'X-Robots-Tag': 'noindex, nofollow'
		}
	});
};
