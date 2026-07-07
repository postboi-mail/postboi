import type { ActionFunctionArgs } from "@remix-run/node"
import { Form, useActionData } from "@remix-run/react"
import { useState } from "react"
import { mail } from "postboi"
import { Captcha } from "postboi/react"

export async function action({ request }: ActionFunctionArgs) {
	// The form carries `_subject` and `_reply_to` (mirrored from the email) as hidden fields,
	// so the whole submission is handed straight to postboi — `body` accepts the promise.
	await mail({ body: request.formData() })
	return { ok: true }
}

export default function Index() {
	const data = useActionData<typeof action>()

	// Mirror the submitted email into the hidden _reply_to field so replies reach the sender.
	const [email, setEmail] = useState("")

	return (
		<main style={{ maxWidth: "32rem", margin: "4rem auto", fontFamily: "system-ui, sans-serif" }}>
			<h1>Contact us</h1>

			{data?.ok ? (
				<p>Thanks — we got your message and will be in touch.</p>
			) : null}

			<Form
				method="post"
				encType="multipart/form-data"
				style={{ display: "grid", gap: "0.75rem" }}
			>
				<input type="hidden" name="_subject" value="Contact Form" />
				<input type="hidden" name="_reply_to" value={email} />
				{/* Invisible spam protection: 🍯 honeypot plus, with a Postboi key, the managed captcha. */}
				<Captcha />
				<input name="contact→name" placeholder="Name" required />
				<input
					name="contact→email"
					type="email"
					placeholder="Email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<textarea name="details→message" placeholder="Message" rows={5} />
				<button type="submit">Send</button>
			</Form>
		</main>
	)
}
