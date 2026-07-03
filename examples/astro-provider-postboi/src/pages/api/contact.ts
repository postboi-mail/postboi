import type { APIRoute } from "astro"
import { mail } from "postboi"

export const POST: APIRoute = async ({ request, redirect }) => {
	// The form carries `_subject` and `_reply_to` (mirrored from the email) as hidden fields,
	// so the whole submission is just handed to postboi as the body.
	const body = await request.formData()
	await mail({ body })
	return redirect("/?sent=1", 303)
}
