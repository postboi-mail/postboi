import { describe, it, expect, vi } from "vitest"
import Mock from "$library/mock.js"

// A project `bunx postboi sync` has baked a key into, so <Captcha /> renders a widget.
vi.mock("$library/register.js", () => ({
	captcha_key: "pk_test",
	whatsapp_templates: {},
	vapid_public_key: undefined,
}))

describe("a form with no captcha token", () => {
	it("is said once when the project has a key for <Captcha />", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const provider = new Mock({ default: { from: "from@test.com", to: "to@test.com" } })
		const post = (fields: Record<string, string>) => {
			const form = new FormData()
			for (const [key, value] of Object.entries(fields)) form.append(key, value)
			return form
		}
		const said = () => warn.mock.calls.filter(([m]) => String(m).includes("no captcha token"))

		// A token arrived, or the send opted out: nothing to say.
		await provider.send({ body: post({ name: "Ada", _captcha: "tok" }) })
		await provider.send({ body: post({ name: "Ada" }), captcha: { turnstile: false } })
		expect(said()).toHaveLength(0)

		// Dropped on the way (superforms, a schema without _captcha): said, once.
		await provider.send({ body: post({ name: "Ada" }) })
		await provider.send({ body: post({ name: "Ada" }) })
		expect(said()).toHaveLength(1)
		expect(String(said()[0][0])).toContain("cf-turnstile-response")
		warn.mockRestore()
	})
})
