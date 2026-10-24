import { webhook } from "postboi/webhooks"

// Provider delivery events on a React Router resource route (no default export = no UI).
// webhook() accepts the action's args directly (they carry .request), so the handler
// is the entire endpoint. Set <PROVIDER>_WEBHOOK_SECRET in .env.
export const action = webhook(async (event) => {
	console.log(`${event.type} — ${event.email ?? ""}`)
})
