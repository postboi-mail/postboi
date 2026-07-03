import { mail } from "postboi"

export default defineEventHandler(async (event) => {
	const form = await readFormData(event)
	form.set("_reply_to", String(form.get("contact→email") ?? ""))
	form.set("_subject", "Contact Form")
	await mail({ body: form })
	return sendRedirect(event, "/?sent=1", 303)
})
