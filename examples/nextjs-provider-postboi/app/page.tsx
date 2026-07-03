import { redirect } from "next/navigation"
import { mail } from "postboi"

async function submit(formData: FormData) {
	"use server"

	// Reply-to comes from the submitted email, so replying reaches the sender.
	formData.set("_reply_to", String(formData.get("contact→email") ?? ""))
	formData.set("_subject", "Contact Form")

	await mail({ body: formData })

	redirect("/?sent=1")
}

export default async function Home({
	searchParams,
}: {
	searchParams: Promise<{ sent?: string }>
}) {
	const { sent } = await searchParams

	return (
		<main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
			<h1>Contact us</h1>

			{sent ? (
				<p>Thanks — your message is on its way.</p>
			) : (
				<form
					action={submit}
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
				>
					<input name="contact→name" placeholder="Name" required />
					<input name="contact→email" type="email" placeholder="Email" required />
					<textarea name="details→message" placeholder="Message" />
					<button type="submit">Send</button>
				</form>
			)}
		</main>
	)
}
