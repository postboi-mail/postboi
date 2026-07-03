import type { DeepPartial, SectionUiConfig } from "$lib/config/content-ui"
import Email from "carbon-icons-svelte/lib/Email.svelte"
import type { Component } from "svelte"

export type ContentSectionLink = {
	label: string
	href: string
	icon?: Component<{ size?: number; class?: string }>
	description?: string
}

export type ContentSectionConfig = {
	/**
	 * URL-safe identifier used as the route segment and content directory name.
	 * The base path is derived as `/${id}`.
	 */
	id: string
	label: string
	navigation: ContentItem[]
	ui?: DeepPartial<SectionUiConfig>
	icon?: Component
	description?: string
}

export type ContentItem = {
	slug: string
	name: string
	category?: string
	showPagination?: boolean
	items?: ContentItem[]
}

export const contentSections: ContentSectionConfig[] = [
	{
		id: "docs",
		label: "Docs",
		icon: Email,
		description: "Send email from anywhere with zero configuration",
		navigation: [
			{
				slug: "getting-started",
				name: "Getting started",
				items: [
					{ slug: "", name: "Introduction" },
					{ slug: "quick-start", name: "Quick start" },
					{ slug: "cloud", name: "Postboi Cloud" },
					{ slug: "manual-setup", name: "Manual setup" },
				],
			},
			{
				slug: "frameworks",
				name: "Frameworks",
				items: [
					{ slug: "sveltekit", name: "SvelteKit" },
					{ slug: "nextjs", name: "Next.js" },
					{ slug: "astro", name: "Astro" },
					{ slug: "nuxt", name: "Nuxt (Vue)" },
					{ slug: "remix", name: "Remix" },
					{ slug: "hono", name: "Hono" },
					{ slug: "express", name: "Express" },
					{ slug: "cloudflare-workers", name: "Cloudflare Workers" },
				],
			},
			{
				slug: "guides",
				name: "Guides",
				items: [
					{ slug: "formdata", name: "FormData" },
					{ slug: "providers", name: "Providers" },
					{ slug: "config", name: "Global config" },
					{ slug: "hooks", name: "Hooks" },
					{ slug: "errors", name: "Errors & retries" },
					{ slug: "bulk", name: "Bulk sending" },
					{ slug: "scheduling", name: "Scheduling" },
				],
			},
			{
				slug: "reference",
				name: "Reference",
				items: [{ slug: "api", name: "API reference" }],
			},
		],
	},
]
