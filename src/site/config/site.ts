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
	url: "https://docs.postboi.app",
	/** Default SEO description for the homepage and fallback metadata. */
	description:
		"An email provider and TypeScript SDK: managed sending with one token and no DNS, plus SMS, WhatsApp, push and chat behind the same API. Bringing your own provider is optional.",
	/** Author shown in metadata and structured data. */
	author: "Darby Manning",
	/** Primary SEO keywords for indexing and discovery. */
	keywords: [
		"postboi",
		"email",
		"email provider",
		"email service",
		"resend alternative",
		"sendgrid alternative",
		"email for ai agents",
		"send sms javascript",
		"whatsapp api javascript",
		"web push notifications library",
		"multi-channel notifications",
		"notification library typescript",
		"send email javascript",
		"javascript email library",
		"typescript email",
		"node email",
		"easy email setup",
		"email api",
		"transactional email",
		"contact form email",
		"formdata",
		"nodemailer alternative",
		"sveltekit",
		"svelte",
		"next.js email",
		"astro email",
		"nuxt email",
		"remix email",
		"hono email",
		"cloudflare workers email",
		"resend",
		"postmark",
		"sendgrid",
		"mailgun",
		"email library",
	],
	/** Default social preview image path. */
	ogImage: "/og-image.jpg",
	/** External profile links used by docs actions and metadata. */
	links: {
		github: "https://github.com/postboi-mail/postboi",
		twitter: "https://github.com/postboi-mail/postboi",
		site: "https://postboi.app",
	},
	/** Package metadata used in installation snippets and docs helpers. */
	package: {
		name: "postboi",
	},
}

/** Inferred type for strongly-typed consumers of `siteConfig`. */
export type SiteConfig = typeof siteConfig
