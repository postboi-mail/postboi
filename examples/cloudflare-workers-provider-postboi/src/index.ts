import Postboi from "postboi"

interface Env {
	POSTBOI_TOKEN: string
}

function page(sent: boolean): Response {
	return new Response(
		`<!doctype html>
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
</html>`,
		{ headers: { "content-type": "text/html; charset=utf-8" } }
	)
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		if (request.method === "POST" && url.pathname === "/contact") {
			// No filesystem and no ambient env on Workers: pass the token from the binding and
			// set defaults here instead of a postboi.config.ts file.
			const mail = new Postboi({ token: env.POSTBOI_TOKEN, default: { to: "team@acme.example" } })
			await mail.send({ body: request.formData() })
			return Response.redirect(new URL("/?sent=1", url).toString(), 303)
		}

		return page(url.searchParams.get("sent") === "1")
	},
}
