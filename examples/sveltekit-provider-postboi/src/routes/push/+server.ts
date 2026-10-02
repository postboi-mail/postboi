import { json } from "@sveltejs/kit"
import { push } from "postboi"

// Managed push: Postboi keeps the subscriptions, so there's no table here, no 410 cleanup
// and no rotation endpoint. `bunx postboi init --push` switches it on and writes
// POSTBOI_PUSH_PROVIDER=postboi.
//
// This example has no sign-in, so "who is signed in" is a demo cookie the page sets. In your
// app it's your session: `push.handler((event) => event.locals.user?.id)`.
const who = (event: { cookies: { get(name: string): string | undefined } }) =>
	event.cookies.get("demo_user")

/** POST files the subscription the page sends under that user; DELETE unfiles it. */
export const { POST, DELETE } = push.handler(who)

/** Push to every browser this person turned on, by who they are rather than by device. */
export async function PUT(event) {
	const user = who(event)
	if (!user) return json({ sent: 0 })
	// `url` is where a click takes the user, focusing a tab already there rather than
	// opening a second one. A person with no browsers is `sent: 0`, not an error.
	const result = (await push({
		to: { user },
		title: "It works",
		message: "This came from your own server, via push().",
		url: "/push",
	})) as { sent: number }
	return json({ sent: result.sent })
}
