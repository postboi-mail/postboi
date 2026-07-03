import { config } from "postboi"

// ─────────────────────────────────────────────────────────────────────────────────────────
// This is the ONLY file that changes between providers. The routes and every `mail()` call
// stay identical — Postboi normalises the rest. To switch provider:
//
//   1. Set `provider` below to its key.
//   2. Put that provider's secret(s) in .env (see .env.example).
//   3. Any non-secret bits (a Mailgun domain, an SES region) go in `options` here.
//
// A few of the ~20 providers (full list: https://postboi.dev/providers):
//
//   provider       secret env var(s)                        non-secret options
//   ─────────      ───────────────────────────────────      ─────────────────────────────
//   "resend"       RESEND_API_KEY                           —
//   "postmark"     POSTMARK_SERVER_TOKEN                    —
//   "sendgrid"     SENDGRID_API_KEY                         —
//   "brevo"        BREVO_API_KEY                            —
//   "mailgun"      MAILGUN_API_KEY                          { domain: "mg.example.com" }
//   "ses"          AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY { region: "us-east-1" }
//   "smtp"         SMTP_PASS                                { host, port, user }
// ─────────────────────────────────────────────────────────────────────────────────────────

export default config({
	provider: "resend",

	// Non-secret provider options (secrets stay in .env). Uncomment the line for your provider:
	// options: { domain: "mg.example.com" },                                              // Mailgun
	// options: { region: "us-east-1" },                                                   // Amazon SES
	// options: { host: "smtp.example.com", port: "587", user: "postmaster@example.com" }, // SMTP

	default: {
		// The address every email is sent from — use one your provider is allowed to send for.
		from: "Acme <hello@acme.example>",
		to: "team@acme.example",
	},
})
