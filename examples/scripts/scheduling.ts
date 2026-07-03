import { mail } from "postboi"

// `scheduled_at` takes a Date or an ISO 8601 string. Providers that support scheduling
// (Postboi Cloud, Resend, Brevo, Mailgun, SendGrid) honour it; every other provider sends
// immediately. See https://postboi.dev/scheduling.
const in_one_hour = new Date(Date.now() + 60 * 60 * 1000)

const result = await mail({
	to: "contact@example.com",
	subject: "Your weekly digest",
	body: "<p>Here is what you missed this week.</p>",
	scheduled_at: in_one_hour,
})

console.log(`scheduled for ${in_one_hour.toISOString()}`, result)
