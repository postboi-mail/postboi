import type { ActionFunctionArgs } from "@remix-run/node"
import { Form, useActionData } from "@remix-run/react"
import { mail } from "postboi"

export async function action({ request }: ActionFunctionArgs) {
	const form = await request.formData()

	form.set("_reply_to", String(form.get("contact→email") ?? ""))
	form.set("_subject", "Contact Form")

	await mail({ body: form })

	return { ok: true }
}

export default function Index() {
	const data = useActionData<typeof action>()

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
				<input name="contact→name" placeholder="Name" required />
				<input name="contact→email" type="email" placeholder="Email" required />
				<textarea name="details→message" placeholder="Message" rows={5} />
				<button type="submit">Send</button>
			</Form>
		</main>
	)
}
