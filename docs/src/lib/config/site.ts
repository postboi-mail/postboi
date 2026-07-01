/**
 * Canonical site-level metadata shared across SEO tags, manifests, and feeds.
 * Keep this object project-specific when using the docs template for a new brand.
 */
export const siteConfig = {
	/** Primary site name used in titles and Open Graph site fields. */
	name: "Postboi",
	/** Compact site name for environments with strict length limits. */
	shortName: "Postboi",
	/** Public canonical URL used to build absolute links. */
	url: "https://docs.postboi.email",
	/** Default SEO description for the homepage and fallback metadata. */
	description:
		"A framework-agnostic email library optimised for SvelteKit. One API, swappable providers, zero configuration — turn FormData into tidy HTML emails.",
	/** Author shown in metadata and structured data. */
	author: "Darby Manning",
	/** Primary SEO keywords for indexing and discovery. */
	keywords: [
		"email",
		"sveltekit",
		"svelte",
		"resend",
		"postmark",
		"sendgrid",
		"mailgun",
		"transactional email",
		"formdata",
		"email library",
		"postboi",
	],
	/** Default social preview image path. */
	ogImage: "/og-image.jpg",
	/** External profile links used by docs actions and metadata. */
	links: {
		github: "https://github.com/darbymanning/postboi",
		twitter: "https://github.com/darbymanning/postboi",
	},
	/** Package metadata used in installation snippets and docs helpers. */
	package: {
		name: "postboi",
	},
}

/** Inferred type for strongly-typed consumers of `siteConfig`. */
export type SiteConfig = typeof siteConfig
