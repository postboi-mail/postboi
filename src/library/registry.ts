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
export const PROVIDERS = [
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
		key: "ses",
		name: "Amazon SES",
		import: "postboi/ses",
		class: "SES",
		url: "https://console.aws.amazon.com/iam/home#/security_credentials",
		fields: [
			{ env: "AWS_ACCESS_KEY_ID", arg: "access_key_id", label: "Access key ID", secret: true },
			{
				env: "AWS_SECRET_ACCESS_KEY",
				arg: "secret_access_key",
				label: "Secret access key",
				secret: true,
			},
			{ env: "AWS_REGION", arg: "region", label: "Region", default: "us-east-1" },
		],
	},
	{
		key: "microsoft365",
		name: "Microsoft 365 (Graph)",
		import: "postboi/microsoft365",
		class: "Microsoft365",
		url: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
		fields: [
			{ env: "MS365_TENANT_ID", arg: "tenant_id", label: "Tenant ID" },
			{ env: "MS365_CLIENT_ID", arg: "client_id", label: "Client ID" },
			{ env: "MS365_CLIENT_SECRET", arg: "client_secret", label: "Client secret", secret: true },
		],
	},
	{
		key: "smtp",
		name: "SMTP (any server)",
		import: "postboi/smtp",
		class: "SMTP",
		url: "https://postboi.uilo.co/providers",
		fields: [
			{ env: "SMTP_HOST", arg: "host", label: "Host (e.g. smtp.example.com)" },
			{ env: "SMTP_PORT", arg: "port", label: "Port", default: "587" },
			{ env: "SMTP_USER", arg: "user", label: "Username", default: "" },
			{ env: "SMTP_PASS", arg: "pass", label: "Password", secret: true, default: "" },
			{
				env: "SMTP_SECURE",
				arg: "secure",
				label: "Implicit TLS (auto/true/false)",
				default: "auto",
			},
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
] as const satisfies ReadonlyArray<ProviderMeta>

/** A known provider key, e.g. `"resend"` — derived from {@link PROVIDERS} so it can't drift. */
export type ProviderKey = (typeof PROVIDERS)[number]["key"]

/** Look up a provider by its key. */
export function find_provider(key: string): ProviderMeta | undefined {
	return PROVIDERS.find((p) => p.key === key)
}
