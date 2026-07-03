import type { APIRoute } from "astro"
import { mail } from "postboi"

export const POST: APIRoute = async ({ request, redirect }) => {
	// The form carries `_subject` and `_reply_to` (mirrored from the email) as hidden fields,
	// so the whole submission is handed straight to postboi — `body` accepts the promise.
	await mail({ body: request.formData() })
	return redirect("/?sent=1", 303)
}
