import { describe, it, expect } from "vitest"
import { push_route } from "./push_route.js"
import { push_key } from "./postboi.js"
import { render_runtime, parse_runtime } from "./typegen.js"

const has =
	(...paths: Array<string>) =>
	(path: string) =>
		paths.includes(path)

describe("push_route", () => {
	it("writes SvelteKit's route as one push.handler line", () => {
		const route = push_route({ dependencies: { "@sveltejs/kit": "2" } }, has("tsconfig.json"))
		expect(route?.path).toBe("src/routes/push/+server.ts")
		expect(route?.url).toBe("/push")
		expect(route?.source).toContain(
			"export const { POST, DELETE } = push.handler((event) => event.locals.user?.id)"
		)
	})

	it("puts Next's route in whichever app directory the project has, signed out until edited", () => {
		const route = push_route({ dependencies: { next: "15" } }, has("src/app"))
		expect(route?.path).toBe("src/app/push/route.js")
		expect(route?.source).toContain("return null")
		expect(push_route({ dependencies: { next: "15" } }, has("pages"))).toBeUndefined()
	})

	it("turns prerendering off for Astro's endpoint", () => {
		const route = push_route({ devDependencies: { astro: "5" } }, has())
		expect(route?.path).toBe("src/pages/push.js")
		expect(route?.source).toContain("export const prerender = false")
	})

	it("leaves a framework it can't wrap to the manual calls", () => {
		expect(push_route({ dependencies: { express: "5" } }, has())).toBeUndefined()
		expect(push_route(undefined, has())).toBeUndefined()
	})
})

describe("push_key", () => {
	const answer = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

	it("switches managed push on with a POST and reads the key back", async () => {
		const calls: Array<[string, RequestInit | undefined]> = []
		const result = await push_key(
			"https://api.test",
			"pb",
			{ kind: "enable" },
			async (url, init) => {
				calls.push([url, init])
				return answer(201, { public_key: "BPUB", subject: "mailto:abuse@postboi.app" })
			}
		)
		expect(result).toEqual({
			ok: true,
			key: { public_key: "BPUB", subject: "mailto:abuse@postboi.app" },
		})
		expect(calls[0][0]).toBe("https://api.test/v1/push/keys")
		expect(calls[0][1]?.method).toBe("POST")
	})

	it("exports the private half only when asked, and carries a refusal's reason", async () => {
		const exported = await push_key(
			"https://api.test",
			"pb",
			{ kind: "get", export: true },
			async (url) => {
				expect(url).toBe("https://api.test/v1/push/keys?private=1")
				return answer(200, { public_key: "BPUB", subject: "s", private_key: "PRIV" })
			}
		)
		expect(exported.ok && exported.key.private_key).toBe("PRIV")

		const refused = await push_key(
			"https://api.test",
			"pb",
			{ kind: "import", public_key: "A", private_key: "B" },
			async () => answer(409, { message: "This account already has a different push key." })
		)
		expect(refused).toEqual({
			ok: false,
			status: 409,
			reason: "This account already has a different push key.",
		})
	})
})

describe("the managed push bake", () => {
	it("round-trips, and is absent unless managed push is on", () => {
		const managed = render_runtime("pk_1", {}, "BPUB", { api: "https://postboi.app" })
		expect(managed).toContain('export const managed_push = {"api":"https://postboi.app"}')
		expect(parse_runtime(managed).managed_push).toEqual({ api: "https://postboi.app" })
		const plain = render_runtime("pk_1", {}, "BPUB")
		expect(plain).toContain("export const managed_push = undefined")
		expect(parse_runtime(plain).managed_push).toBeUndefined()
	})
})
