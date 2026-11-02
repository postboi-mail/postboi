import { afterEach, expect, it, vi } from "vitest"
import Postboi from "./postboi_provider.js"
import { api_command } from "../cli/api.js"
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})
it("SDK and CLI preview encode the exact sample ID in a read-only HTML request", async () => {
	vi.stubEnv("NODE_ENV", "production")
	vi.stubEnv("POSTBOI_INBOX", "off")
	vi.stubEnv("POSTBOI_PROVIDER", "postboi")
	vi.stubEnv("POSTBOI_TOKEN", "pb_synthetic_preview")
	const calls: Array<{ url: URL; init?: RequestInit }> = [],
		output: Array<string> = []
	vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)))
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			expect(url.origin).toBe("https://postboi.app")
			calls.push({ url, init })
			return new Response("<p>Private preview</p>", { headers: { "content-type": "text/html" } })
		})
	)
	const sample = "ct/a&b?=x",
		client = new Postboi({ token: "pb_synthetic_preview" })
	expect(await client.campaigns.preview("camp/a", { sample_contact_id: sample })).toBe(
		"<p>Private preview</p>"
	)
	await api_command("campaigns", ["preview", "camp/a", "--sample-contact", sample, "--json"])
	expect(calls).toHaveLength(2)
	for (const call of calls) {
		expect(call.url.pathname).toBe("/v1/campaigns/camp%2Fa/preview")
		expect(call.url.searchParams.get("sample_contact_id")).toBe(sample)
		expect(call.init?.method ?? "GET").toBe("GET")
		expect(call.init?.body).toBeUndefined()
	}
	expect(output.map((line) => JSON.parse(line))).toEqual([{ html: "<p>Private preview</p>" }])
})
