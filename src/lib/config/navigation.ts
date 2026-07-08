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
	/** Show the framework's brand icon (from BrandIcon, keyed by slug) beside the label. */
	icon?: boolean
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
					{ slug: "provider", name: "The Postboi provider" },
					{ slug: "manual-setup", name: "Manual setup" },
				],
			},
			{
				slug: "frameworks",
				name: "Frameworks",
				items: [
					{ slug: "sveltekit", name: "SvelteKit", icon: true },
					{ slug: "nextjs", name: "Next.js", icon: true },
					{ slug: "astro", name: "Astro", icon: true },
					{ slug: "nuxt", name: "Nuxt (Vue)", icon: true },
					{ slug: "remix", name: "Remix", icon: true },
					{ slug: "hono", name: "Hono", icon: true },
					{ slug: "express", name: "Express", icon: true },
					{ slug: "cloudflare-workers", name: "Cloudflare Workers", icon: true },
				],
			},
			{
				slug: "guides",
				name: "Guides",
				items: [
					{ slug: "formdata", name: "FormData" },
					{ slug: "spam", name: "Spam protection" },
					{ slug: "templates", name: "Email templates" },
					{ slug: "providers", name: "Providers" },
					{ slug: "config", name: "Global config" },
					{ slug: "hooks", name: "Hooks" },
					{ slug: "errors", name: "Errors & retries" },
					{ slug: "bulk", name: "Bulk sending" },
					{ slug: "scheduling", name: "Scheduling" },
					{ slug: "tracking", name: "Tracking & unsubscribe" },
					{ slug: "webhooks", name: "Webhooks" },
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
