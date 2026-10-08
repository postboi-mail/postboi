import { describe, it, expect, vi, afterEach } from "vitest"
import { from_base64url, to_base64url } from "./encoding.js"
import { parse_view_key, replace_web_url, seal_token, views } from "./views.js"
import Mock from "./mock.js"

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.useRealTimers()
})

/** A view key in the spec's format, from fixed bytes. */
const secret = new Uint8Array(32).map((_, i) => i + 1)
const KEY = `pbv_k1_${to_base64url(secret)}`

/**
 * The server's side of the token, written from the spec rather than from the SDK:
 * `v1.<key_id>.<iv>.<ciphertext>`, AES-256-GCM, AAD = slug, payload `{ d, e? }`.
 */
async function open_token(token: string, slug: string, now = Date.now()) {
	const [version, key_id, iv, ciphertext] = token.split(".")
	expect(version).toBe("v1")
	expect(key_id).toBe("k1")
	const key = await crypto.subtle.importKey("raw", secret, "AES-GCM", false, ["decrypt"])
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: from_base64url(iv), additionalData: new TextEncoder().encode(slug) },
		key,
		from_base64url(ciphertext)
	)
	const payload = JSON.parse(new TextDecoder().decode(plain)) as { d: unknown; e?: number }
	if (payload.e !== undefined && payload.e <= Math.floor(now / 1000)) return undefined
	return payload
}

describe("view tokens", () => {
	it("round-trips through a decrypter written from the spec", async () => {
		const token = await seal_token(KEY, "welcome", { first_name: "Ada" })
		expect(token).toMatch(/^v1\.k1\.[\w-]{16}\.[\w-]+$/)
		expect(await open_token(token, "welcome")).toEqual({ d: { first_name: "Ada" } })
	})

	it("is bound to its slug", async () => {
		const token = await seal_token(KEY, "welcome", { a: 1 })
		await expect(open_token(token, "goodbye")).rejects.toThrow()
	})

	it("carries an expiry in unix seconds, from seconds or a Date", async () => {
		const now = Date.parse("2026-10-08T12:00:00Z")
		vi.useFakeTimers({ now })
		const later = await open_token(await seal_token(KEY, "w", 1, 60), "w", now)
		expect(later).toEqual({ d: 1, e: now / 1000 + 60 })
		const dated = await seal_token(KEY, "w", 1, new Date(now + 1000))
		expect(await open_token(dated, "w", now + 2000)).toBeUndefined()
	})

	it("refuses a key that isn't one, and seals with the first of two", async () => {
		expect(() => parse_view_key("pbf_nope")).toThrow(/POSTBOI_VIEW_KEY/)
		expect(() => parse_view_key("pbv_k1_short")).toThrow(/postboi sync/)
		expect(parse_view_key(`${KEY} pbv_k0_${to_base64url(new Uint8Array(32))}`).id).toBe("k1")
	})
})

describe("views.url", () => {
	function api(answers: Record<string, unknown>) {
		const calls: Array<{ key: string; body?: unknown }> = []
		vi.stubEnv("POSTBOI_TOKEN", "pb_test")
		vi.stubEnv("POSTBOI_API_URL", "https://api.test")
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`
				calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined })
				const answer = answers[key]
				return answer === undefined
					? new Response("Not found", { status: 404 })
					: new Response(JSON.stringify(answer))
			})
		)
		return calls
	}

	it("seals locally with POSTBOI_VIEW_KEY under POSTBOI_VIEW_URL, with no request", async () => {
		const calls = api({})
		vi.stubEnv("POSTBOI_VIEW_KEY", KEY)
		vi.stubEnv("POSTBOI_VIEW_URL", "https://view.example.com/")
		const url = await views.url("welcome", { week: 20 })
		expect(url.startsWith("https://view.example.com/welcome?s=v1.k1.")).toBe(true)
		expect(await open_token(new URL(url).searchParams.get("s")!, "welcome")).toEqual({
			d: { week: 20 },
		})
		expect(await views.url("welcome")).toBe("https://view.example.com/welcome")
		expect(calls).toEqual([])
	})

	it("asks the API for the page once when no base is set", async () => {
		const calls = api({
			"GET /v1/views/digest": { slug: "digest", url: "https://view.postboi.app/acct/digest" },
		})
		vi.stubEnv("POSTBOI_VIEW_KEY", KEY)
		await views.url("digest", { a: 1 })
		expect(await views.url("digest")).toBe("https://view.postboi.app/acct/digest")
		expect(calls.map((c) => c.key)).toEqual(["GET /v1/views/digest"])
	})

	it("falls back to the seal API without a key", async () => {
		const calls = api({
			"POST /v1/views/welcome/seal": { token: "t", url: "https://view.postboi.app/a/welcome?s=t" },
		})
		vi.stubEnv("POSTBOI_VIEW_KEY", "")
		expect(await views.url("welcome", { a: 1 }, { expires: 3600 })).toBe(
			"https://view.postboi.app/a/welcome?s=t"
		)
		expect(calls[0].body).toEqual({ data: { a: 1 }, expires_in: 3600 })
	})

	it("says the server has no views yet on a bare 404", async () => {
		api({})
		vi.stubEnv("POSTBOI_VIEW_KEY", "")
		await expect(views.seal("welcome", {})).rejects.toMatchObject({
			code: "views_unavailable",
			message: expect.stringContaining("doesn't host views yet"),
		})
	})
})

describe("mail({ view })", () => {
	it("fills {{ postboi.web_url }} and %postboi_web_url% in html and text before sending", async () => {
		vi.stubEnv("POSTBOI_VIEW_KEY", KEY)
		vi.stubEnv("POSTBOI_VIEW_URL", "https://view.example.com")
		const mail = new Mock({ default: { from: "a@example.com" } })
		await mail.send({
			to: "ada@example.com",
			subject: "Hi",
			body: '<a href="{{ postboi.web_url }}">View in browser</a><a href="{{postboi.web_url}}">again</a>',
			text: "Web: %postboi_web_url%",
			view: { name: "welcome", data: { first_name: "Ada" } },
		})
		const html = mail.last?.html ?? ""
		const link = /href="([^"]+)"/.exec(html)![1]
		expect(link.startsWith("https://view.example.com/welcome?s=v1.k1.")).toBe(true)
		expect(html).not.toContain("postboi.web_url")
		expect(mail.last?.text).toBe(`Web: ${link}`)
	})

	it("replace_web_url leaves a $ in the link alone", () => {
		expect(replace_web_url("{{ postboi.web_url }}", "https://x/$1")).toBe("https://x/$1")
	})
})
