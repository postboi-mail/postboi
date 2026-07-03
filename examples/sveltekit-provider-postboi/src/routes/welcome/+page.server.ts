import { mail } from "postboi"
import { fail } from "@sveltejs/kit"

// A second way to send: call the top-level `mail()` directly when you want to build the
// message yourself (typed subject/body/from) instead of handing the whole form to the
// `postboi/kit` action. `mail()` uses the same provider from postboi.config.ts.
export const actions = {
	async default({ request }) {
		const data = await request.formData()
		const email = String(data.get("email"))

		try {
			await mail({
				// `from` is narrowed to your Postboi Cloud domains once you've run
				// `bunx postboi sync` — see "Typed from" in the README.
				from: "Acme <hello@acme.example>",
				to: email,
				subject: "Welcome to Acme",
				body: "<p>Thanks for signing up — glad to have you aboard.</p>",
			})

			return { success: true }
		} catch (error) {
			return fail(422, { error: error instanceof Error ? error.message : String(error) })
		}
	},
}
