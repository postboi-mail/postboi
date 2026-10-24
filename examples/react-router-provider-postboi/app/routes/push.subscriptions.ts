import { push } from "postboi"
import type { PushSubscriptionJSON } from "postboi/push"
import type { Route } from "./+types/push.subscriptions"

// The server half of Web Push, as a React Router resource route: POST files the subscription
// the browser minted, PUT sends to everyone stored. In-memory on purpose — this is the
// example's database. A restart forgets everyone; a real app stores rows keyed by
// endpoint (the endpoint IS the address).
const subscriptions = new Map<string, PushSubscriptionJSON>()

export async function action({ request }: Route.ActionArgs) {
	if (request.method === "POST") {
		const { old_endpoint, ...subscription } = (await request.json()) as PushSubscriptionJSON & {
			old_endpoint?: string
		}
		if (old_endpoint) subscriptions.delete(old_endpoint)
		subscriptions.set(subscription.endpoint, subscription)
		return Response.json({ stored: subscriptions.size })
	}

	let sent = 0
	for (const [endpoint, subscription] of subscriptions) {
		try {
			await push({
				to: subscription,
				title: "It works",
				message: "This came from your own server, via push().",
				url: "/push",
			})
			sent++
		} catch (error) {
			// Expiring subscriptions are push's steady state, not an error — delete your
			// stored copy, never retry or alert.
			if (push.expired(error)) subscriptions.delete(endpoint)
			else throw error
		}
	}
	return Response.json({ sent })
}
