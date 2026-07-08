import { receive, mock_request, type WebhookEvent } from "postboi/webhooks"

// Receive provider delivery events — delivered, opened, clicked, bounced — normalized
// across every provider, with signatures verified. See https://docs.postboi.email/webhooks.
//
// In a real app this handler lives on an HTTP endpoint, e.g. on SvelteKit:
//
//   import { webhook } from "postboi/kit"
//   export const POST = webhook(handle_event)
//
// Here we drive the exact same path with a correctly-signed mock request instead, so the
// script runs with no provider, no tunnel and no configuration.

function handle_event(event: WebhookEvent) {
	switch (event.type) {
		case "opened":
			// The user-agent parses locally into client/OS/device — no lookup service.
			console.log(
				`${event.email} opened "${event.subject}" in ${event.client?.name} on ${event.client?.device}`
			)
			break
		case "clicked":
			console.log(`${event.email} clicked ${event.url}`)
			break
		case "bounced":
			console.log(`${event.email} bounced (${event.bounce?.category}): ${event.bounce?.detail}`)
			break
		default:
			console.log(`${event.type} — ${event.email}`)
	}
}

for (const type of ["delivered", "opened", "clicked", "bounced"] as const) {
	const { request, secret } = await mock_request({ provider: "resend", type })
	const events = await receive(request, { provider: "resend", secret })
	for (const event of events) handle_event(event)
}
