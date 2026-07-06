import { describe, it, expect, vi, beforeEach } from "vitest"
import maizzle from "$library/maizzle.js"

const render = vi.hoisted(() => vi.fn())

vi.mock("@maizzle/framework", () => ({ render }))

beforeEach(() => {
	render.mockReset()
	render.mockResolvedValue({ html: "<p>rendered</p>", config: {} })
})

describe("postboi/maizzle", () => {
	it("resolves to the rendered HTML string", async () => {
		await expect(maizzle("./emails/welcome.vue")).resolves.toBe("<p>rendered</p>")
	})

	it("passes the template and props through to render()", async () => {
		await maizzle("./emails/welcome.vue", { name: "Ava" })

		expect(render).toHaveBeenCalledWith("./emails/welcome.vue", { props: { name: "Ava" } })
	})

	it("forwards config overrides, with the props argument winning", async () => {
		await maizzle("./emails/welcome.vue", { name: "Ava" }, { minify: true })

		expect(render).toHaveBeenCalledWith("./emails/welcome.vue", {
			minify: true,
			props: { name: "Ava" },
		})
	})

	it("leaves config props alone when the props argument is omitted", async () => {
		await maizzle("./emails/welcome.vue", undefined, { props: { name: "Ava" } })

		expect(render).toHaveBeenCalledWith("./emails/welcome.vue", { props: { name: "Ava" } })
	})

	it("accepts a raw SFC source string", async () => {
		const source = "<template><Text>Hi</Text></template>"
		await maizzle(source)

		expect(render).toHaveBeenCalledWith(source, {})
	})

	it("types props via the generic", async () => {
		interface WelcomeProps extends Record<string, unknown> {
			name: string
		}

		await maizzle<WelcomeProps>("./emails/welcome.vue", { name: "Ava" })
		// @ts-expect-error - missing required prop
		await maizzle<WelcomeProps>("./emails/welcome.vue", {})

		expect(render).toHaveBeenCalledTimes(2)
	})

	it("throws a helpful error when @maizzle/framework is missing", async () => {
		vi.resetModules()
		vi.doMock("@maizzle/framework", () => {
			throw new Error("Cannot find package '@maizzle/framework'")
		})

		const { default: fresh_maizzle } = await import("$library/maizzle.js")
		await expect(fresh_maizzle("./emails/welcome.vue")).rejects.toThrow(/needs @maizzle\/framework/)

		vi.doUnmock("@maizzle/framework")
	})
})
