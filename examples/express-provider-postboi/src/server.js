import express from "express"
import { mail } from "postboi"

const app = express()
app.use(express.urlencoded({ extended: true })) // parses form fields onto req.body — no multer needed

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
		<form method="post" action="/contact">
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

app.post("/contact", async ({ body }, res) => {
	await mail({ body })
	res.redirect(303, "/?sent=1")
})

app.listen(3000, () => console.log("→ http://localhost:3000"))
