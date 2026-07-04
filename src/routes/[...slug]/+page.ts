import { error } from "@sveltejs/kit"
import type { PageLoad } from "./$types"
import {
	getAllContentEntries,
	getContentSectionModule,
	resolveSection,
} from "$lib/content/sections"

export const prerender = true

export const entries = () => getAllContentEntries()

export const load: PageLoad = ({ params }) => {
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
