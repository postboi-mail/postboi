import type { ImportStatus } from "./newsletter_import_rules.js"

export const IMPORT_PROFILES = [
	{
		id: "generic",
		name: "Generic CSV",
		note: "Match columns yourself. Unknown subscription states stay pending.",
	},
	{
		id: "mailchimp",
		name: "Mailchimp",
		note: "Export subscribed, unsubscribed and cleaned contacts. Include Email Marketing Status, or choose the state of each separate export.",
	},
	{
		id: "activecampaign",
		name: "ActiveCampaign",
		note: "Export each list separately with its list status and opt-out fields. Global contact activity is not list permission.",
	},
	{
		id: "beehiiv",
		name: "beehiiv",
		note: "Include subscriber status and custom fields. An inactive reader stays opted out; validating readers stay pending.",
	},
	{
		id: "substack",
		name: "Substack",
		note: "Export all columns, including email disabled. Paid/free membership and payment dates are not email permission.",
	},
	{
		id: "kit",
		name: "Kit",
		note: "Export every subscriber status separately if the CSV has no status column. Include tags and custom fields.",
	},
	{
		id: "mailerlite",
		name: "MailerLite",
		note: "Export each status and make the desired columns visible first. Groups are retained as tags.",
	},
	{
		id: "buttondown",
		name: "Buttondown",
		note: "Include type or subscriber_type. Unactivated and paused readers remain pending; billing type is never inferred as permission.",
	},
	{
		id: "ghost",
		name: "Ghost",
		note: "Include subscribed_to_emails. Paid/free member status is not email permission. Review newsletter-specific preferences separately.",
	},
	{
		id: "emailoctopus",
		name: "EmailOctopus",
		note: "Export all contact statuses and fields for the chosen list, including unsubscribed contacts.",
	},
	{
		id: "listmonk",
		name: "listmonk",
		note: "Export list subscription status as well as global status. An enabled subscriber alone is not confirmed for this newsletter.",
	},
] as const
export type ImportProfile = (typeof IMPORT_PROFILES)[number]["id"]
export function valid_import_profile(value: unknown): value is ImportProfile {
	return IMPORT_PROFILES.some((profile) => profile.id === value)
}
export function profile_aliases(profile: ImportProfile) {
	return {
		email: ["email", "email address", "email_address", "e-mail address"],
		name: ["name", "full name", "full_name"],
		status:
			profile === "ghost"
				? ["subscribed_to_emails"]
				: profile === "buttondown"
					? ["subscriber_type", "type", "status"]
					: profile === "listmonk"
						? ["subscription_status", "subscription status", "status"]
						: [
								"email marketing status",
								"subscription status",
								"subscription_status",
								"subscriber status",
								"subscriber_status",
								"status",
								"state",
							],
		tags:
			profile === "ghost"
				? ["labels", "tags"]
				: profile === "mailerlite"
					? ["groups", "tags"]
					: ["tags", "tag"],
		consent_at: ["confirm_time", "optin_time", "consent_at", "confirmed_at", "confirmed at"],
		topic_opt_out: [] as Array<string>,
	}
}
export const PROFILE_STATES: Partial<Record<ImportProfile, Record<string, ImportStatus>>> = {
	activecampaign: {
		"0": "pending",
		"1": "subscribed",
		"2": "unsubscribed",
		"3": "bounced",
		unconfirmed: "pending",
	},
	beehiiv: { inactive: "unsubscribed", validating: "pending", invalid: "bounced" },
	kit: {
		confirmed: "subscribed",
		cancelled: "unsubscribed",
		canceled: "unsubscribed",
		blocked: "unsubscribed",
		cold: "pending",
	},
	mailerlite: { junk: "complained", unconfirmed: "pending" },
	buttondown: {
		regular: "subscribed",
		unactivated: "pending",
		paused: "pending",
		suppressed: "unsubscribed",
	},
	ghost: { true: "subscribed", false: "unsubscribed", "1": "subscribed", "0": "unsubscribed" },
	listmonk: {
		confirmed: "subscribed",
		unconfirmed: "pending",
		enabled: "pending",
		disabled: "unsubscribed",
		blocklisted: "unsubscribed",
	},
}
