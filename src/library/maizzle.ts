import type { MaizzleConfig } from "@maizzle/framework"

type Framework = typeof import("@maizzle/framework")

let framework: Framework | undefined

async function load_framework(): Promise<Framework> {
	if (framework) return framework

	try {
		framework = await import("@maizzle/framework")
	} catch (cause) {
		throw new Error(
			"postboi/maizzle needs @maizzle/framework — install it alongside postboi (e.g. `npm install @maizzle/framework`)",
			{ cause }
		)
	}

	return framework
}

/**
 * Render a [Maizzle](https://maizzle.com) template to an HTML string, ready to pass as a
 * `body`. A thin wrapper over Maizzle's `render()` that resolves to the transformed,
 * inlined HTML — and since `body` accepts a promise, no intermediate `await` is needed.
 *
 * Requires `@maizzle/framework` (an optional peer dependency) to be installed.
 *
 * @param template A path to a template file, or a raw SFC source string.
 * @param props Props passed to the template's root component — map 1:1 to its `defineProps`.
 * @param config Maizzle config overrides forwarded to `render()`, e.g. `{ minify: true }`.
 *
 * @example
 * import { mail } from "postboi"
 * import maizzle from "postboi/maizzle"
 *
 * await mail({
 * 	to: "ava@example.com",
 * 	subject: "Welcome to Acme",
 * 	body: maizzle("./emails/welcome.vue", { name: "Ava" }),
 * })
 */
export default async function maizzle<
	Props extends Record<string, unknown> = Record<string, unknown>,
>(template: string, props?: Props, config?: Partial<MaizzleConfig>): Promise<string> {
	const { render } = await load_framework()

	const options: Partial<MaizzleConfig> = { ...config }
	if (props) options.props = props

	const { html } = await render(template, options)
	return html
}
