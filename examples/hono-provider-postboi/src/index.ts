import { Hono } from "hono"
import { mail } from "postboi"

const app = new Hono()

app.get("/", function (c) {
	const sent = new URL(c.req.url).searchParams.get("sent") === "1"

	return c.html(`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Contact us</title>
	</head>
	<body>
		<h1>Contact us</h1>
		${sent ? `<p>Thanks — we'll be in touch.</p>` : ""}
		<form method="post" action="/contact" enctype="multipart/form-data">
			<input name="contact→name" placeholder="Name" required />
			<input name="contact→email" type="email" placeholder="Email" required />
			<textarea name="details→message" placeholder="Message"></textarea>
			<button type="submit">Send</button>
		</form>
	</body>
</html>`)
})

app.post("/contact", async function (c) {
	const form = await c.req.formData()

	form.set("_reply_to", String(form.get("contact→email") ?? ""))
	form.set("_subject", "Contact Form")

	await mail({ body: form })

	return c.redirect("/?sent=1", 303)
})

export default app
