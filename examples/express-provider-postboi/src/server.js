import express from "express"
import multer from "multer"
import { mail } from "postboi"

const app = express()
const form = multer() // parses multipart/form-data text fields into req.body

app.get("/", function (req, res) {
	const sent = req.query.sent === "1"
	res.type("html").send(`<!doctype html>
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
			<input type="hidden" name="_subject" value="Contact Form" />
			<input type="hidden" name="_reply_to" />
			<input name="contact→name" placeholder="Name" required />
			<input
				name="contact→email"
				type="email"
				placeholder="Email"
				required
				oninput="this.form._reply_to.value = this.value"
			/>
			<textarea name="details→message" placeholder="Message"></textarea>
			<button type="submit">Send</button>
		</form>
	</body>
</html>`)
})

app.post("/contact", form.none(), async function (req, res) {
	try {
		// Express gives you parsed fields on req.body, not a Web FormData — rebuild one so
		// postboi can extract the special fields and render the rest into an HTML table.
		const body = new FormData()
		for (const [key, value] of Object.entries(req.body)) body.append(key, String(value))

		await mail({ body })
		res.redirect(303, "/?sent=1")
	} catch (error) {
		res.status(500).send(error instanceof Error ? error.message : String(error))
	}
})

app.listen(3000, () => console.log("→ http://localhost:3000"))
