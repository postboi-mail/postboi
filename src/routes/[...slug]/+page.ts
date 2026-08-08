import { error, redirect } from "@sveltejs/kit"
import type { PageLoad } from "./$types"
import {
	getAllContentEntries,
	getContentSectionModule,
	resolveSection,
} from "$lib/content/sections"

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

export const load: PageLoad = ({ params }) => {
	const moved = MOVED[params.slug]
	if (moved) redirect(308, moved)

	const { sectionId, slug } = resolveSection(`/${params.slug}`)

	const mod = getContentSectionModule(sectionId, slug)
	if (!mod) {
		error(404, "Page not found")
	}

	return {
		component: mod.default,
		slug,
	}
}
