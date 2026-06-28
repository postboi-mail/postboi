/** A single piece of configuration the user must supply for a provider. */
export type ProviderField = {
	/** Environment variable name written to the env file, e.g. "RESEND_API_KEY". */
	env: string
	/** Constructor option this maps to, e.g. "api_key". */
	arg: string
	/** Human label shown in the prompt. */
	label: string
	/** Whether the value is a secret (token/key) — only affects how it's presented. */
	secret?: boolean
	/** Default value (and signals the field is optional). */
	default?: string
}

/** A provider as the CLI knows it: how to import it and what to collect. */
export type CliProvider = {
	key: string
	name: string
	import: string
	class: string
	/** Dashboard URL where the user gets their credentials. */
	url: string
	fields: Array<ProviderField>
}

/**
 * The providers `postboi init` can configure. Excludes the mock (test-only) and the
 * cloud client (which has its own auth flow).
 */
export const PROVIDERS: Array<CliProvider> = [
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
		fields: [{ env: "ZEPTO_TOKEN", arg: "token", label: "Send Mail token", secret: true }],
	},
]

/** Build the example `new Provider({...})` snippet for the configured provider. */
export function usage_snippet(provider: CliProvider): string {
	const args = provider.fields.map((f) => `\t${f.arg}: process.env.${f.env},`).join("\n")
	return [
		`import ${provider.class} from "${provider.import}"`,
		"",
		`const mail = new ${provider.class}({`,
		args,
		`})`,
	].join("\n")
}
