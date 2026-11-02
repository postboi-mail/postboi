import { resolve_inbox } from "./inbox.js"
import { PostboiError } from "./errors.js"

/** Loopback inbox discovery only. A missing inbox never falls through to hosted mail. */
export async function local_newsletter_base(): Promise<string> {
	const inbox = await resolve_inbox()
	if (!inbox)
		throw new PostboiError({
			provider: "postboi",
			code: "local_inbox_unavailable",
			message:
				"Start postboi dev, or set POSTBOI_INBOX to its local port. Newsletter operations were not sent to the hosted API.",
		})
	return `${inbox.url.replace(/\/$/, "")}/api/newsletter`
}
