/**
 * Canonical provider registry — the single source of truth shared by the `postboi` CLI
 * (which uses it for prompts and the usage snippet) and the zero-config `send()` (which
 * uses it to construct the configured provider from environment variables).
 */

/** A single piece of configuration a provider needs, and the env var it maps to. */
export type ProviderField = {
	/** Environment variable name, e.g. "RESEND_API_KEY". */
	env: string
	/** Constructor option this maps to, e.g. "api_key". */
	arg: string
	/** Human label shown in the CLI prompt. */
	label: string
	/** Whether the value is a secret (token/key). */
	secret?: boolean
	/** Default value (its presence also marks the field optional). */
	default?: string
}

/** A provider's metadata: how to import it, where to get credentials, and what it needs. */
export type ProviderMeta = {
	key: string
	name: string
	import: string
	class: string
	/** Dashboard URL where the user gets their credentials. */
	url: string
	fields: Array<ProviderField>
}

/** The providers that can be configured by `postboi init` / driven by `send()`. */
export const PROVIDERS: Array<ProviderMeta> = [
	{
		key: "resend",
		name: "Resend",
		import: "postboi/resend",
		class: "Resend",
		url: "https://resend.com/api-keys",
		fields: [{ env: "RESEND_API_KEY", arg: "api_key", label: "API key", secret: true }],
	},
	{
		key: "postmark",
		name: "Postmark",
		import: "postboi/postmark",
		class: "Postmark",
		url: "https://account.postmarkapp.com/servers",
		fields: [{ env: "POSTMARK_SERVER_TOKEN", arg: "api_key", label: "Server token", secret: true }],
	},
	{
		key: "sendgrid",
		name: "SendGrid",
		import: "postboi/sendgrid",
		class: "SendGrid",
		url: "https://app.sendgrid.com/settings/api_keys",
		fields: [{ env: "SENDGRID_API_KEY", arg: "api_key", label: "API key", secret: true }],
	},
	{
		key: "mailgun",
		name: "Mailgun",
		import: "postboi/mailgun",
		class: "Mailgun",
		url: "https://app.mailgun.com/settings/api_security/api_keys",
		fields: [
			{ env: "MAILGUN_API_KEY", arg: "api_key", label: "API key", secret: true },
			{ env: "MAILGUN_DOMAIN", arg: "domain", label: "Sending domain (e.g. mg.example.com)" },
		],
	},
	{
		key: "brevo",
		name: "Brevo",
		import: "postboi/brevo",
		class: "Brevo",
		url: "https://app.brevo.com/settings/keys/api",
		fields: [{ env: "BREVO_API_KEY", arg: "api_key", label: "API key", secret: true }],
	},
	{
		key: "cloudflare",
		name: "Cloudflare Email Service",
		import: "postboi/cloudflare",
		class: "Cloudflare",
		url: "https://dash.cloudflare.com/profile/api-tokens",
		fields: [
			{ env: "CLOUDFLARE_API_TOKEN", arg: "api_key", label: "API token", secret: true },
			{ env: "CLOUDFLARE_ACCOUNT_ID", arg: "account_id", label: "Account ID" },
		],
	},
	{
		key: "mailersend",
		name: "MailerSend",
		import: "postboi/mailersend",
		class: "MailerSend",
		url: "https://app.mailersend.com/api-tokens",
		fields: [{ env: "MAILERSEND_API_KEY", arg: "api_key", label: "API token", secret: true }],
	},
	{
		key: "sparkpost",
		name: "SparkPost",
		import: "postboi/sparkpost",
		class: "SparkPost",
		url: "https://app.sparkpost.com/account/api-keys",
		fields: [{ env: "SPARKPOST_API_KEY", arg: "api_key", label: "API key", secret: true }],
	},
	{
		key: "mandrill",
		name: "Mandrill (Mailchimp Transactional)",
		import: "postboi/mandrill",
		class: "Mandrill",
		url: "https://mandrillapp.com/settings",
		fields: [{ env: "MANDRILL_API_KEY", arg: "api_key", label: "API key", secret: true }],
	},
	{
		key: "plunk",
		name: "Plunk",
		import: "postboi/plunk",
		class: "Plunk",
		url: "https://app.useplunk.com/settings/api",
		fields: [{ env: "PLUNK_API_KEY", arg: "api_key", label: "Secret API key", secret: true }],
	},
	{
		key: "mailtrap",
		name: "Mailtrap",
		import: "postboi/mailtrap",
		class: "Mailtrap",
		url: "https://mailtrap.io/api-tokens",
		fields: [{ env: "MAILTRAP_TOKEN", arg: "api_key", label: "API token", secret: true }],
	},
	{
		key: "mailpace",
		name: "MailPace",
		import: "postboi/mailpace",
		class: "MailPace",
		url: "https://app.mailpace.com",
		fields: [{ env: "MAILPACE_SERVER_TOKEN", arg: "api_key", label: "Server token", secret: true }],
	},
	{
		key: "scaleway",
		name: "Scaleway Transactional Email",
		import: "postboi/scaleway",
		class: "Scaleway",
		url: "https://console.scaleway.com/iam/api-keys",
		fields: [
			{ env: "SCALEWAY_SECRET_KEY", arg: "secret_key", label: "Secret key", secret: true },
			{ env: "SCALEWAY_PROJECT_ID", arg: "project_id", label: "Project ID" },
			{ env: "SCALEWAY_REGION", arg: "region", label: "Region", default: "fr-par" },
		],
	},
	{
		key: "zepto",
		name: "ZeptoMail",
		import: "postboi/zepto",
		class: "Postboi",
		url: "https://www.zoho.com/zeptomail/",
		fields: [{ env: "ZEPTO_TOKEN", arg: "api_key", label: "Send Mail token", secret: true }],
	},
]

/** Look up a provider by its key. */
export function find_provider(key: string): ProviderMeta | undefined {
	return PROVIDERS.find((p) => p.key === key)
}
