import type { APIRoute } from "astro"
import { mail } from "postboi"

export const POST: APIRoute = async ({ request, redirect }) => {
	const form = await request.formData()
	form.set("_reply_to", String(form.get("contact→email") ?? ""))
	form.set("_subject", "Contact Form")
	await mail({ body: form })
	return redirect("/?sent=1", 303)
}
