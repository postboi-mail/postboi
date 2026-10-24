import { webhook } from "postboi/webhooks"

// Provider delivery events. webhook() verifies the signature, normalizes the payload,
// and answers the provider correctly (200 ok, 401 bad signature, 400 bad payload, 500
// so it retries when your handler throws). This same line is the whole endpoint in
// Astro, React Router, SvelteKit and Workers too. Point your provider's webhook at
// POST /webhooks and set <PROVIDER>_WEBHOOK_SECRET.
export const POST = webhook(async (event) => {
	console.log(`${event.type} — ${event.email ?? ""}`)
})
