import { afterEach, expect, it, vi } from "vitest"
import Postboi from "./postboi_provider.js"
afterEach(function () {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})
it("saved segment updates use the exact newsletter and segment IDs without invoking any sending operation", async function () {
	vi.stubEnv("NODE_ENV", "production")
	vi.stubEnv("POSTBOI_INBOX", "off")
	const requests: Array<{ url: URL; init?: RequestInit }> = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async function (input: RequestInfo | URL, init?: RequestInit) {
			requests.push({ url: new URL(input instanceof Request ? input.url : String(input)), init })
			return Response.json({ id: "segment/a&b" })
		})
	)
	const client = new Postboi({ token: "pb_synthetic_segment_review" }),
		rule = {
			include_tag_ids: ["tag-include"],
			exclude_tag_ids: ["tag-exclude"],
			field: { key: "membership", value: "current" },
		}
	expect(
		await client.newsletters.segments.update(
			"newsletter/a?b",
			"segment/a&b",
			"Current members",
			rule
		)
	).toEqual({ id: "segment/a&b" })
	expect(requests).toHaveLength(1)
	expect(requests[0].url.origin).toBe("https://postboi.app")
	expect(requests[0].url.pathname).toBe(
		"/v1/newsletters/newsletter%2Fa%3Fb/segments/segment%2Fa%26b"
	)
	expect(requests[0].init?.method).toBe("PATCH")
	expect(JSON.parse(String(requests[0].init?.body))).toEqual({ name: "Current members", rule })
})
