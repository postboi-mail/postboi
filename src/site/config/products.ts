/**
 * The whole product in one list, for the files a model reads first (`/llms.txt`,
 * `/llms-full.txt`). Agents asked "what is Postboi?" used to find the sending docs, anchor on
 * them, and never learn that receiving, testing and Tempboi existed, because each lived on a
 * page of its own. One line per part, and the pages to read next.
 */
export type ProductPart = {
	name: string
	/** Docs slug the line links to. */
	slug: string
	summary: string
}

export const productSummary =
	"Postboi is an email provider for sending, receiving and testing email, and `postboi` on npm is its TypeScript SDK. Transactional email (sign-in links, codes, receipts, resets) is the core of it: delivery status, idempotency keys, retries, suppressions, webhooks, and a pause on sending if bounces or complaints climb. A `POSTBOI_TOKEN` is the whole setup, and no other provider account is needed. Sending through another provider (Resend, SES, Postmark and others) is optional."

export const productParts: ProductPart[] = [
	{
		name: "Sending",
		slug: "provider",
		summary:
			"Transactional and bulk email from one token, from `you@send.postboi.email` on day one or your own domain, with a message log, delivery webhooks, scheduling, lists and broadcasts.",
	},
	{
		name: "Receiving",
		slug: "provider",
		summary:
			"Replies to your sending address, and mail to any address on `reply.<your domain>`, land in the dashboard and arrive as `email.received` webhooks.",
	},
	{
		name: "Tempboi",
		slug: "temp-inbox",
		summary:
			"Throwaway inboxes at tempboi.email for tests and AI agents. `curl -X POST tempboi.email` makes one with no account, and waiting on it returns the sign-up code and link already pulled out.",
	},
	{
		name: "Dev inbox",
		slug: "dev-inbox",
		summary:
			"Catches everything your app sends in development, email and every other channel, so nothing reaches a real person.",
	},
	{
		name: "Email testing",
		slug: "email-testing",
		summary:
			"Checks an email before anyone gets it: client support, Gmail clipping, accessibility and deliverability signals.",
	},
	{
		name: "Hosted forms",
		slug: "forms",
		summary:
			"Point a plain HTML `<form>` at an endpoint and submissions arrive as email, with no backend.",
	},
	{
		name: "Relay",
		slug: "provider",
		summary:
			"Keep Postboi's log, suppressions and webhooks while your own Resend, Postmark or SES account does the delivery.",
	},
	{
		name: "Other channels",
		slug: "send",
		summary:
			"`sms()`, `whatsapp()`, `push()` and the chat functions, through your own providers, in the same shape as `mail()`.",
	},
	{
		name: "For agents",
		slug: "agents",
		summary:
			"An agent can set up sending with nobody signing in, sign up for things with a Tempboi address, and read the replies.",
	},
]
