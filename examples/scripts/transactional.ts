import { mail } from "postboi"

// The simplest send: no form, no FormData — just call mail() from anywhere in your backend
// (after a signup, an order, a password reset, …). Build the message yourself.
const result = await mail({
	to: "new-user@example.com",
	subject: "Welcome to Acme",
	body: "<p>Thanks for signing up — glad to have you aboard.</p>",
})

console.log("sent", result)
