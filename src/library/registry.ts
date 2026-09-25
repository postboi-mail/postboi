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
	/**
	 * The env var is a well-known third-party name that environments set for reasons that
	 * have nothing to do with postboi — `AWS_ACCESS_KEY_ID` on any box near S3, `SMTP_HOST`
	 * for somebody else's mailer, `CLOUDFLARE_API_TOKEN` wherever wrangler has run.
	 *
	 * Such a name is not evidence of intent, so a provider carrying one is never inferred
	 * (see `infer_channel_provider`) — it has to be named. Without this, an unrelated AWS
	 * credential in the environment makes `sms()` decide "SNS, then" and attempt a live
	 * send with the wrong keys, in place of the clean "no provider configured" error.
	 */
	ambient?: true
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
	/**
	 * Present when Postboi has a registered OAuth app that can mint this provider's
	 * credential in the browser — `init` offers "Connect in the browser" and the flow
	 * fills `env`. The registry is the single place that knows this, so a new connect
	 * provider is one field here, not a hunt through init's branches.
	 */
	connect?: { env: string }
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
			{
				env: "CLOUDFLARE_API_TOKEN",
				arg: "api_key",
				label: "API token",
				secret: true,
				ambient: true,
			},
			{ env: "CLOUDFLARE_ACCOUNT_ID", arg: "account_id", label: "Account ID", ambient: true },
			// Read by poll() (webhooks/poll_cloudflare.ts), not the send constructor: the
			// Queue an Email Sending event subscription publishes delivery events to.
			// Auto-provisioned when empty; here so `postboi sync` carries a manual choice.
			{
				env: "CLOUDFLARE_QUEUE_ID",
				arg: "queue_id",
				label: "Event queue ID (optional, auto-provisioned)",
				default: "",
				ambient: true,
			},
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
		key: "lettermint",
		name: "Lettermint",
		import: "postboi/lettermint",
		class: "Lettermint",
		url: "https://app.lettermint.co",
		fields: [
			{
				env: "LETTERMINT_SENDING_TOKEN",
				arg: "api_key",
				label: "Sending token (lm_…)",
				secret: true,
			},
			{ env: "LETTERMINT_ROUTE", arg: "route", label: "Route slug (optional)", default: "" },
			{
				env: "LETTERMINT_WEBHOOK_SECRET",
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
			{
				env: "AWS_ACCESS_KEY_ID",
				arg: "access_key_id",
				label: "Access key ID",
				secret: true,
				ambient: true,
			},
			{
				env: "AWS_SECRET_ACCESS_KEY",
				arg: "secret_access_key",
				label: "Secret access key",
				secret: true,
				ambient: true,
			},
			{
				env: "AWS_REGION",
				arg: "region",
				label: "Region",
				default: "us-east-1",
				ambient: true,
			},

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
		url: "https://docs.postboi.app/providers",
		fields: [
			{ env: "SMTP_HOST", arg: "host", label: "Host (e.g. smtp.example.com)", ambient: true },
			{ env: "SMTP_PORT", arg: "port", label: "Port", default: "587", ambient: true },
			{ env: "SMTP_USER", arg: "user", label: "Username", default: "", ambient: true },
			{
				env: "SMTP_PASS",
				arg: "pass",
				label: "Password",
				secret: true,
				default: "",
				ambient: true,
			},
			{
				env: "SMTP_SECURE",
				arg: "secure",
				label: "Implicit TLS (auto/true/false)",
				default: "auto",
				ambient: true,
			},
			// The bounce-mailbox half of the SMTP story: poll() reads DSN reports from the
			// return-path's POP3 mailbox (see webhooks/poll_smtp.ts). The SMTP constructor
			// ignores these, like other providers ignore their webhook_secret fields —
			// they're here so `postboi sync` carries them.
			{
				env: "POP3_HOST",
				arg: "pop3_host",
				label: "Bounce mailbox host (POP3, optional)",
				default: "",
				ambient: true,
			},
			{
				env: "POP3_PORT",
				arg: "pop3_port",
				label: "Bounce mailbox port",
				default: "995",
				ambient: true,
			},
			{
				env: "POP3_USER",
				arg: "pop3_user",
				label: "Bounce mailbox user",
				default: "",
				ambient: true,
			},
			{
				env: "POP3_PASS",
				arg: "pop3_pass",
				label: "Bounce mailbox password",
				secret: true,
				default: "",
				ambient: true,
			},
			{
				env: "POP3_SECURE",
				arg: "pop3_secure",
				label: "Bounce mailbox implicit TLS (auto/true/false)",
				default: "auto",
				ambient: true,
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
			{ env: "MJ_APIKEY_PUBLIC", arg: "api_key", label: "API key", secret: true, ambient: true },
			{
				env: "MJ_APIKEY_PRIVATE",
				arg: "api_secret",
				label: "Secret key",
				secret: true,
				ambient: true,
			},

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
		key: "unosend",
		name: "Unosend",
		import: "postboi/unosend",
		class: "Unosend",
		url: "https://app.unosend.co",
		fields: [
			{ env: "UNOSEND_API_KEY", arg: "api_key", label: "API key (un_…)", secret: true },
			{
				env: "UNOSEND_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook signing secret (whsec_…, optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "sequenzy",
		name: "Sequenzy",
		import: "postboi/sequenzy",
		class: "Sequenzy",
		url: "https://www.sequenzy.com/dashboard",
		fields: [
			{ env: "SEQUENZY_API_KEY", arg: "api_key", label: "API key (seq_live_…)", secret: true },
			{
				env: "SEQUENZY_COMPANY_ID",
				arg: "company_id",
				label: "Workspace id (optional; only for seq_user_ account keys)",
				default: "",
			},
			{
				env: "SEQUENZY_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook signing secret (whsec_…, optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "loops",
		name: "Loops",
		import: "postboi/loops",
		class: "Loops",
		url: "https://app.loops.so/settings?page=api",
		fields: [
			{ env: "LOOPS_API_KEY", arg: "api_key", label: "API key", secret: true },
			{
				env: "LOOPS_TRANSACTIONAL_ID",
				arg: "transactional_id",
				label: "Transactional email id (from the Transactional page)",
			},
			{
				env: "LOOPS_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook signing secret (whsec_…, optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "mailchannels",
		name: "MailChannels",
		import: "postboi/mailchannels",
		class: "MailChannels",
		url: "https://console.mailchannels.net",
		fields: [{ env: "MAILCHANNELS_API_KEY", arg: "api_key", label: "API key", secret: true }],
	},
	{
		key: "smtp2go",
		name: "SMTP2GO",
		import: "postboi/smtp2go",
		class: "SMTP2GO",
		url: "https://app.smtp2go.com/settings/apikeys/",
		fields: [
			{ env: "SMTP2GO_API_KEY", arg: "api_key", label: "API key (api-…)", secret: true },
			{
				env: "SMTP2GO_REGION",
				arg: "region",
				label: "Region (us, eu or au; optional)",
				default: "",
			},
			{
				env: "SMTP2GO_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the webhook URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "socketlabs",
		name: "SocketLabs",
		import: "postboi/socketlabs",
		class: "SocketLabs",
		url: "https://cp.socketlabs.com",
		fields: [
			{ env: "SOCKETLABS_SERVER_ID", arg: "server_id", label: "Server id" },
			{ env: "SOCKETLABS_API_KEY", arg: "api_key", label: "Injection API key", secret: true },
			{
				env: "SOCKETLABS_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Event webhook secret key (optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "azure",
		name: "Azure Communication Services",
		import: "postboi/azure",
		class: "Azure",
		url: "https://portal.azure.com",
		fields: [
			{
				env: "COMMUNICATION_SERVICES_CONNECTION_STRING",
				arg: "connection_string",
				label: "Connection string (endpoint=…;accesskey=…)",
				secret: true,
				ambient: true,
			},
			{
				env: "AZURE_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Event Grid webhook token (optional; also add ?token=… to the endpoint URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "gmail",
		name: "Gmail (Google Workspace)",
		import: "postboi/gmail",
		class: "Gmail",
		url: "https://console.cloud.google.com/iam-admin/serviceaccounts",
		fields: [
			{ env: "GMAIL_CLIENT_EMAIL", arg: "client_email", label: "Service account email" },
			{
				env: "GMAIL_PRIVATE_KEY",
				arg: "private_key",
				label: "Service account private key (PEM)",
				secret: true,
			},
			{
				env: "GMAIL_USER",
				arg: "user",
				label: "Mailbox to send as (optional; defaults to the from address)",
				default: "",
			},
		],
	},
	{
		key: "maileroo",
		name: "Maileroo",
		import: "postboi/maileroo",
		class: "Maileroo",
		url: "https://app.maileroo.com",
		fields: [{ env: "MAILEROO_API_KEY", arg: "api_key", label: "API key", secret: true }],
	},
	{
		key: "ahasend",
		name: "AhaSend",
		import: "postboi/ahasend",
		class: "AhaSend",
		url: "https://dash.ahasend.com",
		fields: [
			{ env: "AHASEND_API_KEY", arg: "api_key", label: "API key (aha-sk-…)", secret: true },
			{ env: "AHASEND_ACCOUNT_ID", arg: "account_id", label: "Account id" },
			{
				env: "AHASEND_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook secret (optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "postal",
		name: "Postal",
		import: "postboi/postal",
		class: "Postal",
		url: "https://docs.postalserver.io",
		fields: [
			{
				env: "POSTAL_HOST",
				arg: "host",
				label: "Your Postal installation (https://postal.example.com)",
			},
			{ env: "POSTAL_API_KEY", arg: "api_key", label: "Mail server API key", secret: true },
			{
				env: "POSTAL_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the webhook URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "customerio",
		name: "Customer.io",
		import: "postboi/customerio",
		class: "CustomerIO",
		url: "https://fly.customer.io/settings/api_credentials?keyType=app",
		fields: [
			{ env: "CUSTOMERIO_APP_API_KEY", arg: "api_key", label: "App API key", secret: true },
			{
				env: "CUSTOMERIO_REGION",
				arg: "region",
				label: "Region (us or eu; optional)",
				default: "",
			},
			{
				env: "CUSTOMERIO_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Reporting webhook signing key (optional)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "infobip",
		name: "Infobip",
		import: "postboi/infobip",
		class: "Infobip",
		url: "https://portal.infobip.com/dev/api-keys",
		fields: [
			{ env: "INFOBIP_API_KEY", arg: "api_key", label: "API key", secret: true },
			{ env: "INFOBIP_BASE_URL", arg: "base_url", label: "API base URL (xxxxx.api.infobip.com)" },
			{
				env: "INFOBIP_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Delivery report token (optional; also add ?token=… to the notify URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "sendpulse",
		name: "SendPulse",
		import: "postboi/sendpulse",
		class: "SendPulse",
		url: "https://login.sendpulse.com/settings/#api",
		fields: [
			{ env: "SENDPULSE_CLIENT_ID", arg: "client_id", label: "REST API id" },
			{
				env: "SENDPULSE_CLIENT_SECRET",
				arg: "client_secret",
				label: "REST API secret",
				secret: true,
			},
			{
				env: "SENDPULSE_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the webhook URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "iterable",
		name: "Iterable",
		import: "postboi/iterable",
		class: "Iterable",
		url: "https://app.iterable.com/settings/apiKeys",
		fields: [
			{ env: "ITERABLE_API_KEY", arg: "api_key", label: "API key", secret: true },
			{ env: "ITERABLE_CAMPAIGN_ID", arg: "campaign_id", label: "Triggered campaign id" },
			{ env: "ITERABLE_REGION", arg: "region", label: "Region (us or eu; optional)", default: "" },
		],
	},
	{
		key: "jetemail",
		name: "JetEmail",
		import: "postboi/jetemail",
		class: "JetEmail",
		url: "https://app.jetemail.com",
		fields: [{ env: "JETEMAIL_API_KEY", arg: "api_key", label: "API key", secret: true }],
	},
	{
		key: "lettr",
		name: "Lettr",
		import: "postboi/lettr",
		class: "Lettr",
		url: "https://app.lettr.com",
		fields: [{ env: "LETTR_API_KEY", arg: "api_key", label: "API key", secret: true }],
	},
	{
		key: "primitive",
		name: "Primitive",
		import: "postboi/primitive",
		class: "Primitive",
		url: "https://app.primitive.dev",
		fields: [{ env: "PRIMITIVE_API_KEY", arg: "api_key", label: "API key", secret: true }],
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
	{
		key: "netcore",
		name: "Netcore (Pepipost)",
		import: "postboi/netcore",
		class: "Netcore",
		url: "https://cpaas.netcorecloud.com/app/settings/api",
		fields: [
			{ env: "NETCORE_API_KEY", arg: "api_key", label: "API key", secret: true },
			{
				env: "NETCORE_REGION",
				arg: "region",
				label: "Region (global or eu; optional)",
				default: "",
			},
		],
	},
	{
		key: "klaviyo",
		name: "Klaviyo",
		import: "postboi/klaviyo",
		class: "Klaviyo",
		url: "https://www.klaviyo.com/settings/account/api-keys",
		fields: [
			{ env: "KLAVIYO_API_KEY", arg: "api_key", label: "Private API key (pk_…)", secret: true },
			{
				env: "KLAVIYO_METRIC",
				arg: "metric",
				label: "Metric the flow is triggered by",
				default: "Postboi Email",
			},
		],
	},
	{
		key: "hubspot",
		name: "HubSpot",
		import: "postboi/hubspot",
		class: "HubSpot",
		url: "https://app.hubspot.com/private-apps",
		fields: [
			{
				env: "HUBSPOT_ACCESS_TOKEN",
				arg: "api_key",
				label: "Private app access token",
				secret: true,
			},
			{ env: "HUBSPOT_EMAIL_ID", arg: "email_id", label: "Transactional email id" },
		],
	},
	{
		key: "onesignal",
		name: "OneSignal",
		import: "postboi/onesignal",
		class: "OneSignal",
		url: "https://dashboard.onesignal.com",
		fields: [
			{ env: "ONESIGNAL_API_KEY", arg: "api_key", label: "REST API key", secret: true },
			{ env: "ONESIGNAL_APP_ID", arg: "app_id", label: "App ID" },
		],
	},
	{
		key: "alibaba",
		name: "Alibaba Cloud Direct Mail",
		import: "postboi/alibaba",
		class: "DirectMail",
		url: "https://ram.console.aliyun.com/manage/ak",
		fields: [
			{
				env: "ALIBABA_CLOUD_ACCESS_KEY_ID",
				arg: "access_key_id",
				label: "Access key ID",
				secret: true,
				ambient: true,
			},
			{
				env: "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
				arg: "access_key_secret",
				label: "Access key secret",
				secret: true,
				ambient: true,
			},
			{
				env: "ALIBABA_CLOUD_REGION_ID",
				arg: "region",
				label: "Region",
				default: "cn-hangzhou",
				ambient: true,
			},
		],
	},
	{
		key: "yandex",
		name: "Yandex Cloud Postbox",
		import: "postboi/yandex",
		class: "Postbox",
		url: "https://console.yandex.cloud",
		fields: [
			{
				env: "YANDEX_ACCESS_KEY_ID",
				arg: "access_key_id",
				label: "Static access key ID",
				secret: true,
			},
			{
				env: "YANDEX_SECRET_ACCESS_KEY",
				arg: "secret_access_key",
				label: "Static secret access key",
				secret: true,
			},
			{ env: "YANDEX_REGION", arg: "region", label: "Region", default: "ru-central1" },
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
		fields: [
			{ env: "SMSWORKS_API_KEY", arg: "api_key", label: "API key (JWT)", secret: true },
			{
				env: "SMSWORKS_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label: "Webhook token (optional; also add ?token=… to the delivery-report URL)",
				secret: true,
				default: "",
			},
		],
	},
	{
		key: "puresms",
		name: "PureSMS",
		import: "postboi/puresms",
		class: "PureSms",
		url: "https://new.puresms.app/",
		regions: ["GB"],
		note: "UK-native flat-rate pay-as-you-go, hosted in the EU, with signed delivery webhooks",
		price: "2.8p",
		verified: "2026-09-01",
		fields: [{ env: "PURESMS_API_KEY", arg: "api_key", label: "API key", secret: true }],
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
			{
				env: "TWILIO_ACCOUNT_SID",
				arg: "account_sid",
				label: "Account SID",
				secret: true,
				ambient: true,
			},
			{
				env: "TWILIO_AUTH_TOKEN",
				arg: "auth_token",
				label: "Auth token",
				secret: true,
				ambient: true,
			},
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
			{
				env: "AWS_ACCESS_KEY_ID",
				arg: "access_key_id",
				label: "Access key ID",
				secret: true,
				ambient: true,
			},
			{
				env: "AWS_SECRET_ACCESS_KEY",
				arg: "secret_access_key",
				label: "Secret access key",
				secret: true,
				ambient: true,
			},
			{
				env: "AWS_REGION",
				arg: "region",
				label: "Region",
				default: "us-east-1",
				ambient: true,
			},
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
		note: "Incoming webhook. The channel is baked into the URL",
		connect: { env: "SLACK_WEBHOOK_URL" },
		fields: [
			{
				env: "SLACK_WEBHOOK_URL",
				arg: "webhook_url",
				label: "Incoming webhook URL",
				secret: true,
				ambient: true,
			},
		],
	},
	{
		key: "discord",
		name: "Discord",
		import: "postboi/discord",
		class: "Discord",
		url: "https://discord.com/developers/docs/resources/webhook",
		note: "Channel webhook, same shape as Slack",
		connect: { env: "DISCORD_WEBHOOK_URL" },
		fields: [
			{
				env: "DISCORD_WEBHOOK_URL",
				arg: "webhook_url",
				label: "Webhook URL",
				secret: true,
				ambient: true,
			},
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
		fields: [
			{
				env: "TEAMS_WEBHOOK_URL",
				arg: "webhook_url",
				label: "Workflow URL",
				secret: true,
				ambient: true,
			},
		],
	},
	{
		key: "telegram",
		name: "Telegram",
		import: "postboi/telegram",
		class: "Telegram",
		url: "https://core.telegram.org/bots#botfather",
		note: "Bot API. The recipient must have started a chat with your bot first",
		// Only the constructor option lives here. The default chat id is a channel default
		// (chat.default.to / POSTBOI_CHAT_TO), not a constructor option — routing it through
		// `fields` made the CLI commit it somewhere no provider reads.
		fields: [
			{
				env: "TELEGRAM_BOT_TOKEN",
				arg: "bot_token",
				label: "Bot token",
				secret: true,
				ambient: true,
			},
		],
	},
	{
		key: "bluesky",
		name: "Bluesky",
		import: "postboi/bluesky",
		class: "Bluesky",
		url: "https://bsky.app/settings/app-passwords",
		note: "AT Protocol. Posts publicly to your own feed, not to a room",
		fields: [
			{ env: "BLUESKY_HANDLE", arg: "identifier", label: "Handle (e.g. you.bsky.social)" },
			{ env: "BLUESKY_APP_PASSWORD", arg: "app_password", label: "App password", secret: true },
			{
				env: "BLUESKY_SERVICE",
				arg: "service",
				label: "PDS URL (only if you self-host)",
				default: "https://bsky.social",
			},
		],
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
			{
				env: "VAPID_PUBLIC_KEY",
				arg: "public_key",
				label: "VAPID public key",
				// Not sensitive, but env-routed (`secret`) on purpose: the pair must travel
				// together through team sync. A synced private key without its public half
				// leaves init offering to regenerate over the team's pair, orphaning every
				// subscription collected under it.
				secret: true,
			},
			{ env: "VAPID_PRIVATE_KEY", arg: "private_key", label: "VAPID private key", secret: true },
			{
				env: "VAPID_SUBJECT",
				arg: "subject",
				// A bare address is what this prompt invites, and the provider now turns one
				// into a mailto: URI rather than letting it 401 at the push service.
				label: "Contact (your email, or an https URL)",
			},
		],
	},
	{
		key: "fcm",
		name: "Firebase Cloud Messaging",
		import: "postboi/fcm",
		class: "FCM",
		url: "https://console.firebase.google.com",
		note: "Android apps: the only route to them, and it reaches iOS too",
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
	{
		key: "apns",
		name: "Apple Push Notification service",
		import: "postboi/apns",
		class: "APNs",
		url: "https://developer.apple.com/account/resources/authkeys/list",
		note: "iOS, iPadOS, macOS and Safari, direct, with no Firebase in the middle",
		fields: [
			{ env: "APNS_KEY_ID", arg: "key_id", label: "Key ID of the .p8 auth key" },
			{ env: "APNS_TEAM_ID", arg: "team_id", label: "Apple Developer team ID" },
			{
				env: "APNS_PRIVATE_KEY",
				arg: "private_key",
				label: "Contents of the .p8 file",
				secret: true,
			},
			{ env: "APNS_TOPIC", arg: "topic", label: "App bundle ID (e.g. com.example.app)" },
			{
				env: "APNS_ENVIRONMENT",
				arg: "environment",
				// Defaulted rather than prompted: production is what a shipped app needs, and
				// the wrong one here fails as `BadDeviceToken`, which reads like a bad token
				// rather than a bad setting.
				label: "APNs environment (production or sandbox)",
				default: "production",
			},
		],
	},
	{
		key: "hms",
		name: "Huawei Push Kit",
		import: "postboi/hms",
		class: "HMS",
		url: "https://developer.huawei.com/consumer/en/console",
		note: "Huawei phones sold since 2020. They have no Play Services, so FCM can't reach them",
		fields: [
			{ env: "HMS_APP_ID", arg: "app_id", label: "App ID from AppGallery Connect" },
			{ env: "HMS_APP_SECRET", arg: "app_secret", label: "App secret", secret: true },
		],
	},
	{
		key: "expo",
		name: "Expo",
		import: "postboi/expo",
		class: "Expo",
		url: "https://expo.dev/accounts/[account]/settings/access-tokens",
		note: "Expo and React Native apps, both platforms. Expo holds the FCM and APNs credentials, so the server needs none",
		fields: [
			{
				env: "EXPO_ACCESS_TOKEN",
				arg: "access_token",
				// Optional, and the only push credential that is: the push service takes any
				// request until the project switches on enhanced security. Never inferred
				// from, twice over — with every field optional the provider would otherwise
				// count as configured on every machine and stop the VAPID trio inferring Web
				// Push, and the name is the one expo-server-sdk's own README reads, so it is
				// set by anyone already sending Expo push their own way. POSTBOI_PUSH_PROVIDER
				// names it, which `init` writes anyway.
				label: "Access token (only with Enhanced Security for Push Notifications on)",
				secret: true,
				default: "",
				ambient: true,
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
			{
				env: "TWILIO_ACCOUNT_SID",
				arg: "account_sid",
				label: "Account SID",
				secret: true,
				ambient: true,
			},
			{
				env: "TWILIO_AUTH_TOKEN",
				arg: "auth_token",
				label: "Auth token",
				secret: true,
				ambient: true,
			},
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
		note: "Direct: no platform fee on top of Meta's, but needs Business verification",
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
			{
				env: "WHATSAPP_BUSINESS_ACCOUNT_ID",
				arg: "business_account_id",
				label: "WhatsApp Business Account id (optional; types your template names)",
				default: "",
			},
			// Read by receive() (webhooks/meta.ts), not the send constructor, like the email
			// providers' webhook_secret fields. Named META_* rather than WHATSAPP_* because
			// both are the app's: the app secret signs every Meta product's webhooks.
			{
				env: "META_WEBHOOK_SECRET",
				arg: "webhook_secret",
				label:
					"App secret (optional; signs delivery webhooks, from Basic Settings in the app dashboard)",
				secret: true,
				default: "",
			},
			{
				env: "META_WEBHOOK_VERIFY_TOKEN",
				arg: "webhook_verify_token",
				label:
					"Webhook verify token (optional; a string you choose, also typed into the webhook form)",
				secret: true,
				default: "",
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
 * Which provider a channel's credentials can only mean, when nothing names one.
 *
 * `mail()` has always done this for its own shortcut — a `POSTBOI_TOKEN` and nothing else
 * dispatches to the Postboi provider — and the reasoning generalises: if exactly one
 * provider in the channel has every field it needs, naming it again in
 * `POSTBOI_<CHANNEL>_PROVIDER` is a second place to keep in sync for no information. Web
 * Push is the case that stings, because it has no vendor account to sign up for: mint a
 * VAPID pair and the provider is already decided.
 *
 * Deliberately strict, in three ways:
 *
 * - Two candidates is a genuine question about intent, not a coin to flip — it returns
 *   undefined and the caller's "no provider configured" error stands, with the env var
 *   still the way to say which.
 * - Optional fields (anything carrying a `default`) don't count towards a provider being
 *   configured, or every provider with one required field would qualify off a single stray
 *   variable. (A provider whose every field is optional would therefore count as
 *   configured everywhere, and must carry an `ambient` field — Expo does.)
 * - A provider with any `ambient` field is never inferred. Inference reads credentials as
 *   a statement of intent, which only holds while the env var name belongs to postboi's
 *   world: `VAPID_PRIVATE_KEY` is set by exactly one kind of person, `AWS_ACCESS_KEY_ID`
 *   by anyone who has ever touched S3. Shipped without this, an unrelated AWS credential
 *   made `sms()` pick SNS and attempt a live send with the wrong keys — worse than the
 *   error it replaced, because it leaves the process and it isn't obviously postboi's
 *   doing. New providers are safe only to the extent their fields are honestly marked, so
 *   `inferable_channel_providers` is pinned by a test.
 *
 * `has` is injected rather than imported so this file stays the registry and nothing else —
 * it's shared with the CLI, which reads env differently.
 */
export function infer_channel_provider(
	channel: Channel,
	has: (env: string) => boolean
): string | undefined {
	// The registry's entries are literal-typed, so a field without `default` doesn't carry
	// the property at all — read them through the shape they satisfy instead.
	const configured = inferable_channel_providers(channel).filter((provider) =>
		provider.fields.every((field) => field.default !== undefined || has(field.env))
	)
	return configured.length === 1 ? configured[0].key : undefined
}

/**
 * The `options` a config section may contribute to the provider being built — or nothing,
 * when they were written for a different one.
 *
 * `options` is a flat bag keyed by `arg`, and `arg` names collide by design: `api_key` is
 * shared by 15 email providers, `webhook_url` by Slack/Discord/Teams, `private_key` by Web
 * Push/FCM/APNs. So when a config file names one provider and something else selects
 * another — `POSTBOI_PROVIDER`, a platform function, inference — the bag happily hands the
 * first provider's credential to the second. That is not a mis-set option: a Mailgun key
 * went out in an Authorization header to `api.resend.com`, and a Slack webhook URL (a
 * secret in its own right) was posted to by the Discord provider.
 *
 * The rule: options belong to the provider the section names. A section naming nothing
 * keeps the old behaviour, because unscoped options can only have been written for
 * whatever ends up running.
 */
export function scoped_options(
	section: { provider?: string; options?: Record<string, string> } | undefined,
	key: string
): Record<string, string> | undefined {
	if (section?.provider !== undefined && section.provider !== key) return undefined
	return section?.options
}

/**
 * The providers on a channel whose credentials are specific enough to read as intent —
 * everything except those carrying an `ambient` field. Exported so a test can pin the list:
 * adding a provider whose credentials are a generic third-party name should fail loudly
 * here rather than silently widening what gets inferred in someone's deploy.
 */
export function inferable_channel_providers(channel: Channel): ReadonlyArray<ProviderMeta> {
	// The registry's entries are literal-typed, so a field without `ambient` doesn't carry
	// the property at all — read them through the shape they satisfy instead.
	const providers: ReadonlyArray<ProviderMeta> = CHANNEL_PROVIDERS[channel]
	return providers.filter((provider) => provider.fields.every((field) => !field.ambient))
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
