import { mail } from "postboi"

export default defineEventHandler(async (event) => {
	// The form carries `_subject` and `_reply_to` (mirrored from the email) as hidden fields,
	// so the whole submission is handed straight to postboi — `body` accepts the promise.
	await mail({ body: readFormData(event) })
	return sendRedirect(event, "/?sent=1", 303)
})
