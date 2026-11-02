import { afterEach, expect, it, vi } from "vitest"
import Postboi from "./postboi_provider.js"
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})
it("updates exactly the encoded newsletter segment with an inert rule payload", async () => {
	vi.stubEnv("NODE_ENV", "production")
	const requests: Array<{ url: string; init?: RequestInit }> = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(url), init })
			return Response.json({ id: "segment" })
		})
	)
	const client = new Postboi({ token: "pb_synthetic" })
	const rule = {
		include_tag_ids: ["ntag_readers"],
		exclude_tag_ids: [],
		field: { key: "topic", value: "product" },
	}
	expect(
		await client.newsletters.segments.update("list/a", "segment/b", "Product readers", rule)
	).toEqual({ id: "segment" })
	expect(requests).toHaveLength(1)
	expect(requests[0].url).toBe("https://postboi.app/v1/newsletters/list%2Fa/segments/segment%2Fb")
	expect(requests[0].init?.method).toBe("PATCH")
	expect(JSON.parse(String(requests[0].init?.body))).toEqual({ name: "Product readers", rule })
	expect(new Headers(requests[0].init?.headers).get("authorization")).toBe("Bearer pb_synthetic")
})
