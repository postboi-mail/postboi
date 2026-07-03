import { mail } from "postboi"

export default defineEventHandler(async (event) => {
	// The form carries `_subject` and `_reply_to` (mirrored from the email) as hidden fields,
	// so the whole submission is just handed to postboi as the body.
	const body = await readFormData(event)
	await mail({ body })
	return sendRedirect(event, "/?sent=1", 303)
})
