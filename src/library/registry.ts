/**
 * Canonical provider registry — the single source of truth shared by the `postboi` CLI
 * (which uses it for prompts and the usage snippet) and the zero-config `mail()` (which
 * uses it to construct the configured provider from environment variables).
 */
import type { Channel } from "./errors.js"

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

/** The providers that can be configured by `postboi init` / driven by `mail()`. */
export const PROVIDERS = [
	{
		key: "resend",
		name: "Resend",
		import: "postboi/resend",
		class: "Resend",
		url: "https://resend.com/api-keys",
		fields: [
			{ env: "RESEND_API_KEY", arg: "api_key", label: "API key", secret: true },
			{
				env: "RESEND_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook signing secret (whsec_…, optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "postmark",
		name: "Postmark",
		import: "postboi/postmark",
		class: "Postmark",
		url: "https://account.postmarkapp.com/servers",
		fields: [
			{ env: "POSTMARK_SERVER_TOKEN", arg: "api_key", label: "Server token", secret: true },
			{
				env: "POSTMARK_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the webhook URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "sendgrid",
		name: "SendGrid",
		import: "postboi/sendgrid",
		class: "SendGrid",
		url: "https://app.sendgrid.com/settings/api_keys",
		fields: [
			{ env: "SENDGRID_API_KEY", arg: "api_key", label: "API key", secret: true },
			{
				env: "SENDGRID_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook verification key (public key, optional)",
				secret: true,
				default: "",
			},
		],
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

			{
				env: "MAILGUN_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook signing key (optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "brevo",
		name: "Brevo",
		import: "postboi/brevo",
		class: "Brevo",
		url: "https://app.brevo.com/settings/keys/api",
		fields: [
			{ env: "BREVO_API_KEY", arg: "api_key", label: "API key", secret: true },
			{
				env: "BREVO_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the webhook URL)",
				secret: true,
				default: "",
			},
		],
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
		fields: [
			{ env: "MAILERSEND_API_KEY", arg: "api_key", label: "API token", secret: true },
			{
				env: "MAILERSEND_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook signing secret (optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "sparkpost",
		name: "SparkPost",
		import: "postboi/sparkpost",
		class: "SparkPost",
		url: "https://app.sparkpost.com/account/api-keys",
		fields: [
			{ env: "SPARKPOST_API_KEY", arg: "api_key", label: "API key", secret: true },
			{
				env: "SPARKPOST_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "mandrill",
		name: "Mandrill (Mailchimp Transactional)",
		import: "postboi/mandrill",
		class: "Mandrill",
		url: "https://mandrillapp.com/settings",
		fields: [
			{ env: "MANDRILL_API_KEY", arg: "api_key", label: "API key", secret: true },
			{
				env: "MANDRILL_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook key (optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "plunk",
		name: "Plunk",
		import: "postboi/plunk",
		class: "Plunk",
		url: "https://app.useplunk.com/settings/api",
		fields: [
			{ env: "PLUNK_API_KEY", arg: "api_key", label: "Secret API key", secret: true },
			{
				env: "PLUNK_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the webhook URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "mailtrap",
		name: "Mailtrap",
		import: "postboi/mailtrap",
		class: "Mailtrap",
		url: "https://mailtrap.io/api-tokens",
		fields: [
			{ env: "MAILTRAP_TOKEN", arg: "api_key", label: "API token", secret: true },
			{
				env: "MAILTRAP_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook signing secret (optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "mailpace",
		name: "MailPace",
		import: "postboi/mailpace",
		class: "MailPace",
		url: "https://app.mailpace.com",
		fields: [
			{ env: "MAILPACE_SERVER_TOKEN", arg: "api_key", label: "Server token", secret: true },
			{
				env: "MAILPACE_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook public key (optional)",
				secret: true,
				default: "",
			},
		],
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

			{
				env: "SCALEWAY_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the webhook URL)",
				secret: true,
				default: "",
			},
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

			{
				env: "SES_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "SNS webhook token (optional; also add ?token=… to the SNS endpoint URL)",
				secret: true,
				default: "",
			},
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
		url: "https://docs.postboi.email/providers",
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
		key: "mailjet",
		name: "Mailjet (Sinch)",
		import: "postboi/mailjet",
		class: "Mailjet",
		url: "https://app.mailjet.com/account/apikeys",
		fields: [
			{ env: "MJ_APIKEY_PUBLIC", arg: "api_key", label: "API key", secret: true },
			{ env: "MJ_APIKEY_PRIVATE", arg: "api_secret", label: "Secret key", secret: true },

			{
				env: "MAILJET_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the webhook URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "elasticemail",
		name: "Elastic Email",
		import: "postboi/elasticemail",
		class: "ElasticEmail",
		url: "https://app.elasticemail.com/marketing/settings/new/manage-api",
		fields: [
			{ env: "ELASTICEMAIL_API_KEY", arg: "api_key", label: "API key", secret: true },
			{
				env: "ELASTICEMAIL_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the notification URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "zepto",
		name: "ZeptoMail",
		import: "postboi/zepto",
		class: "Postboi",
		url: "https://www.zoho.com/zeptomail/",
		fields: [
			{ env: "ZEPTO_TOKEN", arg: "api_key", label: "Send Mail token", secret: true },
			{
				env: "ZEPTO_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the webhook URL)",
				secret: true,
				default: "",
			},
		],
	},
] as const satisfies ReadonlyArray<ProviderMeta>

/** A known provider key, e.g. `"resend"` — derived from {@link PROVIDERS} so it can't drift. */
export type ProviderKey = (typeof PROVIDERS)[number]["key"]

/** Look up an email provider by its key. */
export function find_provider(key: string): ProviderMeta | undefined {
	return PROVIDERS.find((p) => p.key === key)
}

/**
 * An SMS provider's metadata. Carries more than the email equivalent because, unlike
 * email, the right SMS provider depends on **where you're sending** — `regions` and
 * `note` let `postboi init` recommend rather than just list.
 *
 * `price` is indicative only and goes stale; `verified` is the date it was last checked, so
 * a reader can tell how much to trust it. Never treat these as quotes.
 */
export type SmsProviderMeta = ProviderMeta & {
	/** ISO country codes this provider is a good fit for, or "global". */
	regions: ReadonlyArray<string>
	/** One line on why you'd pick this one. */
	note: string
	/** Indicative price per message, as a display string (e.g. "2.8p"). */
	price?: string
	/** ISO date the price was last verified. */
	verified?: string
}

/** The SMS providers `postboi init --sms` can configure and `sms()` can drive. */
export const SMS_PROVIDERS = [
	{
		key: "smsworks",
		name: "The SMS Works",
		import: "postboi/smsworks",
		class: "SmsWorks",
		url: "https://thesmsworks.co.uk/login",
		regions: ["GB"],
		note: "UK-native, and only charges for messages that actually arrive",
		price: "~2.8p effective",
		verified: "2026-08-07",
		fields: [{ env: "SMSWORKS_API_KEY", arg: "api_key", label: "API key (JWT)", secret: true }],
	},
	{
		key: "twilio",
		name: "Twilio",
		import: "postboi/twilio",
		class: "Twilio",
		url: "https://console.twilio.com",
		regions: ["global"],
		note: "Global coverage, and the provider every example on the internet uses",
		price: "~4.3p to UK",
		verified: "2026-08-07",
		fields: [
			{ env: "TWILIO_ACCOUNT_SID", arg: "account_sid", label: "Account SID", secret: true },
			{ env: "TWILIO_AUTH_TOKEN", arg: "auth_token", label: "Auth token", secret: true },
			{
				env: "TWILIO_MESSAGING_SERVICE_SID",
				arg: "messaging_service_sid",
				label: "Messaging Service SID (optional; required to schedule)",
				default: "",
			},
		],
	},
	{
		key: "sns",
		name: "Amazon SNS",
		import: "postboi/sns",
		class: "SNS",
		url: "https://console.aws.amazon.com/iam/home#/security_credentials",
		regions: ["global"],
		note: "Cheapest if you're already on AWS; no per-message sender ID in most regions",
		// Deliberately not a number: AWS SMS pricing varies by destination and region, and a
		// single figure here would be wrong more often than right.
		price: "varies by destination",
		verified: "2026-08-07",
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
] as const satisfies ReadonlyArray<SmsProviderMeta>

/** A known SMS provider key, e.g. `"twilio"` — derived from {@link SMS_PROVIDERS}. */
export type SmsProviderKey = (typeof SMS_PROVIDERS)[number]["key"]

/**
 * Provider metadata plus the one-line picker note — the shape chat, push and WhatsApp
 * share. Simpler than SMS, which also carries regions and indicative pricing.
 */
export type NotedProviderMeta = ProviderMeta & {
	/** One line on why you'd pick this one. */
	note: string
}

/** The chat providers `slack()`, `discord()`, `teams()` and `telegram()` drive. */
export const CHAT_PROVIDERS = [
	{
		key: "slack",
		name: "Slack",
		import: "postboi/slack",
		class: "Slack",
		url: "https://api.slack.com/messaging/webhooks",
		note: "Incoming webhook — the channel is baked into the URL",
		fields: [
			{
				env: "SLACK_WEBHOOK_URL",
				arg: "webhook_url",
				label: "Incoming webhook URL",
				secret: true,
			},
		],
	},
	{
		key: "discord",
		name: "Discord",
		import: "postboi/discord",
		class: "Discord",
		url: "https://discord.com/developers/docs/resources/webhook",
		note: "Channel webhook — same shape as Slack",
		fields: [
			{ env: "DISCORD_WEBHOOK_URL", arg: "webhook_url", label: "Webhook URL", secret: true },
		],
	},
	{
		key: "teams",
		name: "Microsoft Teams",
		import: "postboi/teams",
		class: "Teams",
		url: "https://learn.microsoft.com/en-us/power-automate/overview-cloud",
		// Legacy connector URLs are rejected by the provider itself, so the picker only has
		// to say which kind of URL to go and get.
		note: "Power Automate Workflows webhook (legacy connector URLs are rejected)",
		fields: [{ env: "TEAMS_WEBHOOK_URL", arg: "webhook_url", label: "Workflow URL", secret: true }],
	},
	{
		key: "telegram",
		name: "Telegram",
		import: "postboi/telegram",
		class: "Telegram",
		url: "https://core.telegram.org/bots#botfather",
		note: "Bot API — the recipient must have started a chat with your bot first",
		// Only the constructor option lives here. The default chat id is a channel default
		// (chat.default.to / POSTBOI_CHAT_TO), not a constructor option — routing it through
		// `fields` made the CLI commit it somewhere no provider reads.
		fields: [{ env: "TELEGRAM_BOT_TOKEN", arg: "bot_token", label: "Bot token", secret: true }],
	},
] as const satisfies ReadonlyArray<NotedProviderMeta>

/** A known chat provider key, e.g. `"slack"`. */
export type ChatProviderKey = (typeof CHAT_PROVIDERS)[number]["key"]

/** Look up a chat provider by its key — what the platform functions resolve with. */
export function find_chat_provider(key: string): NotedProviderMeta | undefined {
	return CHAT_PROVIDERS.find((p) => p.key === key)
}

/** The push providers `push()` can drive. */
export const PUSH_PROVIDERS = [
	{
		key: "webpush",
		name: "Web Push",
		import: "postboi/webpush",
		class: "WebPush",
		url: "https://developer.mozilla.org/en-US/docs/Web/API/Push_API",
		note: "Browsers, via VAPID. No vendor and no per-message cost",
		fields: [
			{ env: "VAPID_PUBLIC_KEY", arg: "public_key", label: "VAPID public key" },
			{ env: "VAPID_PRIVATE_KEY", arg: "private_key", label: "VAPID private key", secret: true },
			{
				env: "VAPID_SUBJECT",
				arg: "subject",
				label: "Contact (mailto: or https URL)",
			},
		],
	},
	{
		key: "fcm",
		name: "Firebase Cloud Messaging",
		import: "postboi/fcm",
		class: "FCM",
		url: "https://console.firebase.google.com",
		note: "Android and iOS via Firebase — also the simplest way to reach APNs",
		fields: [
			{ env: "FCM_PROJECT_ID", arg: "project_id", label: "Firebase project id" },
			{ env: "FCM_CLIENT_EMAIL", arg: "client_email", label: "Service account email" },
			{
				env: "FCM_PRIVATE_KEY",
				arg: "private_key",
				label: "Service account private key",
				secret: true,
			},
		],
	},
] as const satisfies ReadonlyArray<NotedProviderMeta>

/** A known push provider key, e.g. `"webpush"`. */
export type PushProviderKey = (typeof PUSH_PROVIDERS)[number]["key"]

// The WhatsApp notes carry the thing the picker most needs to say: which of the two
// onboarding paths (Twilio sender vs Meta Business verification) each provider commits
// you to.

/** The WhatsApp providers `whatsapp()` can drive. */
export const WHATSAPP_PROVIDERS = [
	{
		key: "twilio",
		name: "Twilio",
		import: "postboi/whatsapp-twilio",
		class: "TwilioWhatsapp",
		url: "https://console.twilio.com",
		note: "Same credentials as Twilio SMS; templates are Content SIDs (HX…)",
		fields: [
			{ env: "TWILIO_ACCOUNT_SID", arg: "account_sid", label: "Account SID", secret: true },
			{ env: "TWILIO_AUTH_TOKEN", arg: "auth_token", label: "Auth token", secret: true },
			{
				env: "TWILIO_MESSAGING_SERVICE_SID",
				arg: "messaging_service_sid",
				label: "Messaging Service SID (optional; supplies the WhatsApp sender)",
				default: "",
			},
		],
	},
	{
		key: "meta",
		name: "Meta Cloud API",
		import: "postboi/whatsapp-meta",
		class: "Meta",
		url: "https://developers.facebook.com/apps",
		note: "Direct — no platform fee on top of Meta's, but needs Business verification",
		fields: [
			{
				env: "WHATSAPP_ACCESS_TOKEN",
				arg: "access_token",
				label: "System User access token",
				secret: true,
			},
			{
				env: "WHATSAPP_PHONE_NUMBER_ID",
				arg: "phone_number_id",
				label: "Phone number id (from the app dashboard, not the number itself)",
			},
		],
	},
] as const satisfies ReadonlyArray<NotedProviderMeta>

/** A known WhatsApp provider key, e.g. `"meta"`. */
export type WhatsappProviderKey = (typeof WHATSAPP_PROVIDERS)[number]["key"]

/**
 * Every channel's provider list under one key. The `satisfies` is the point: adding a
 * member to {@link Channel} without registering its providers stops compiling here, rather
 * than surfacing later as a resolver that can't find anything.
 */
export const CHANNEL_PROVIDERS = {
	email: PROVIDERS,
	sms: SMS_PROVIDERS,
	chat: CHAT_PROVIDERS,
	push: PUSH_PROVIDERS,
	whatsapp: WHATSAPP_PROVIDERS,
} as const satisfies Record<Channel, ReadonlyArray<ProviderMeta>>

/** Look up any channel's provider by its key — what the shared channel resolver uses. */
export function find_channel_provider(channel: Channel, key: string): ProviderMeta | undefined {
	return CHANNEL_PROVIDERS[channel].find((p) => p.key === key)
}

/**
 * Every credential env var across every channel's providers — the set `postboi env push`
 * collects from the local environment and `postboi sync` pulls back down. Derived from
 * the registry so a new provider's credentials sync without anyone remembering to say so.
 */
export function credential_env_keys(): Array<string> {
	const keys = new Set<string>()
	for (const providers of Object.values(CHANNEL_PROVIDERS)) {
		for (const provider of providers) {
			for (const field of provider.fields) keys.add(field.env)
		}
	}
	return [...keys]
}
