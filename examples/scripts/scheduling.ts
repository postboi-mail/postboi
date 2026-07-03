import { mail } from "postboi"

// `scheduled_at` takes a relative duration ({ days, hours, … }), a Date, or an ISO 8601
// string. Providers that support scheduling (Postboi Cloud, Resend, Brevo, Mailgun, SendGrid)
// honour it; every other provider sends immediately. See https://docs.postboi.email/scheduling.
const result = await mail({
	to: "contact@example.com",
	subject: "Your weekly digest",
	body: "<p>Here is what you missed this week.</p>",
	scheduled_at: { days: 1, hours: 5 },
})

console.log("scheduled", result)
