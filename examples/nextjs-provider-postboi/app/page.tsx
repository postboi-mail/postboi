"use client"

import { useActionState, useState } from "react"
import { Captcha } from "postboi/react"
import { submit } from "./actions"

export default function Home() {
	// Mirror the submitted email into the hidden _reply_to field so replies reach the sender.
	const [email, setEmail] = useState("")
	const [state, action] = useActionState(submit, null)

	return (
		<main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
			<h1>Contact us</h1>

			{state?.ok ? (
				<p>Thanks — your message is on its way.</p>
			) : (
				<form
					action={action}
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
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
					<textarea name="details→message" placeholder="Message" />
					<button type="submit">Send</button>
				</form>
			)}
		</main>
	)
}
