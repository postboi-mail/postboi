import { fileURLToPath, URL } from "node:url"
import type { Element, Parent, Root, RootContent, Text } from "hast"
import type { VFile } from "vfile"
import adapter from "@sveltejs/adapter-cloudflare"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"
import { escapeSvelte, mdsvex } from "mdsvex"
import rehypeSlug from "rehype-slug"
import { highlight } from "./src/site/utils/highlight.js"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vitest/config"
import { sveltekit } from "@sveltejs/kit/vite"

/** A node of the tree a rehype plugin walks. */
type Node = Root | RootContent

const children = (node: Node): Array<RootContent> => ("children" in node ? node.children : [])

const tableCellFormatter = () => {
	return (tree: Root) => {
		const ancestors: Array<Element> = []

		const visit = (node: Node, parent: Parent | null = null, index = 0) => {
			const isElement = node.type === "element"

			if (node.type === "element") {
				ancestors.push(node)
			}

			if (node.type === "text") {
				const textNode = node

				if (textNode.value.includes("\\|")) {
					const directParent = ancestors[ancestors.length - 1]
					const grandParent = ancestors[ancestors.length - 2]
					const isCodeBlock = directParent?.tagName === "code" && grandParent?.tagName === "pre"

					if (!isCodeBlock) {
						textNode.value = textNode.value.replace(/\\\|/g, "|")
					}
				}
			}

			if (node.type === "element") {
				const el = node
				const childText = el.children.length === 1 ? el.children[0] : undefined

				if (el.tagName === "code" && childText?.type === "text") {
					const parentNode = ancestors[ancestors.length - 2]
					const isBlockCode = parentNode?.tagName === "pre"

					const insideTableCell = ancestors.some((ancestor) => {
						if (ancestor === el) return false

						return ancestor.tagName === "td" || ancestor.tagName === "th"
					})

					let raw = childText.value

					if (raw.includes("\\|")) {
						raw = raw.replace(/\\\|/g, "|")
						childText.value = raw
					}

					if (!isBlockCode && insideTableCell && raw.includes("|") && parent) {
						const parentChildren = parent.children

						if (Array.isArray(parentChildren)) {
							const segments = raw.split("|").map((segment) => segment.trim())

							if (segments.length > 1) {
								const replacements = segments.flatMap((segment, segmentIndex) => {
									const codeNode: Element = {
										type: "element",
										tagName: "code",
										properties: el.properties,
										children: [{ type: "text", value: segment }],
									}

									if (segmentIndex === segments.length - 1) {
										return [codeNode]
									}

									const space: Text = { type: "text", value: " " }

									return [codeNode, space]
								})

								parentChildren.splice(index, 1, ...replacements)
								ancestors.pop()

								replacements.forEach((child, childIndex) => {
									visit(child, parent, index + childIndex)
								})

								return
							}
						}
					}
				}
			}

			if ("children" in node) {
				const childNodes = node.children

				for (let i = 0; i < childNodes.length; i += 1) {
					visit(childNodes[i], node, i)
				}
			}

			if (isElement) {
				ancestors.pop()
			}
		}

		visit(tree)
	}
}

// Archived versions live under `content/vX.Y.Z/`. Their prose has root-relative
// links (e.g. `/settings`) that would otherwise resolve against the latest site
// — 404ing on renamed slugs and yanking the reader out of the version. Rewrite
// such links to the version's own base path.
const versionScopedLinks = () => (tree: Root, file: VFile & { filename?: string }) => {
	const path = file.filename ?? file.path ?? file.history[0] ?? ""
	const match = /[/\\]content[/\\](v\d[^/\\]*)[/\\]/.exec(path)

	if (!match) return

	const base = `/${match[1]}`

	const visit = (node: Node) => {
		if (node.type === "element" && node.tagName === "a") {
			const href = node.properties.href

			if (typeof href === "string" && href.startsWith("/") && !href.startsWith("//")) {
				node.properties.href = href === "/" ? base : `${base}${href}`
			}
		}

		for (const child of children(node)) visit(child)
	}

	visit(tree)
}

const markdownLayout = fileURLToPath(
	new URL("./src/site/components/docs/MarkdownLayout.svelte", import.meta.url)
)

// SvelteKit 3 has no svelte.config.js: the preprocessors, the adapter and the aliases are
// options of the sveltekit() plugin itself.
export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			extensions: [".svelte", ".svx"],
			// Consult https://svelte.dev/docs/kit/integrations
			// for more information about preprocessors
			preprocess: [
				mdsvex({
					extensions: [".svx"],
					layout: { _: markdownLayout },
					rehypePlugins: [tableCellFormatter, rehypeSlug, versionScopedLinks],
					highlight: {
						// One rendering for both modes: the theme is CSS (see highlight.js).
						highlighter: (code, lang = "text") => {
							const htmlProp = JSON.stringify(escapeSvelte(highlight(code, lang)))
							const langProp = JSON.stringify(lang)
							const rawProp = JSON.stringify(code)

							return `<svelte:component this={Reflect.get(globalThis, "__MarkdownPre")} lang={${langProp}} html={${htmlProp}} raw={${rawProp}} />`
						},
					},
				}),
				vitePreprocess(),
			],
			adapter: adapter(),
			// The library's tests import via `$library/*`; the docs site's own pieces live in
			// `$site` — named so nobody has to remember which of lib/library meant what.
			alias: { $library: "src/library", $site: "src/site" },
		}),
	],
	optimizeDeps: { exclude: ["@rollup/browser"] },
	worker: { format: "es" },
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: "./vite.config.ts",
				test: {
					name: "server",
					environment: "node",
					// Empty unless POSTBOI_TEST_POLLUTE=1; see src/testing/pollute.ts.
					setupFiles: ["./src/testing/setup.ts"],
					include: ["src/**/*.{test,spec}.{js,ts}"],
					exclude: ["src/**/*.svelte.{test,spec}.{js,ts}"],
				},
			},
		],
	},
})
