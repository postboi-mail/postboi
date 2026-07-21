import { mail } from "postboi"

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
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		if (request.method === "POST" && url.pathname === "/contact") {
			// The POSTBOI_TOKEN binding is read for us — Workers have no filesystem, so only
			// a postboi.config.ts would need wiring up by hand.
			await mail({ body: request.formData(), to: "team@acme.example" })
			return Response.redirect(new URL("/?sent=1", url).toString(), 303)
		}

		return page(url.searchParams.get("sent") === "1")
	},
}
