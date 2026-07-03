import { fileURLToPath, URL } from "node:url"
import adapter from "@sveltejs/adapter-cloudflare"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"
import { escapeSvelte, mdsvex } from "mdsvex"
import { createHighlighter } from "shiki"
import rehypeSlug from "rehype-slug"

const tableCellFormatter = () => {
	return (tree) => {
		const ancestors = []

		const visit = (node, parent = null, index = 0) => {
			const isElement = node.type === "element"
			const isRoot = node.type === "root"

			if (isElement) {
				ancestors.push(node)
			}

			if (node.type === "text") {
				const textNode = node
				if (typeof textNode.value === "string" && textNode.value.includes("\\|")) {
					const directParent = ancestors[ancestors.length - 1]
					const grandParent = ancestors[ancestors.length - 2]
					const isCodeBlock = directParent.tagName === "code" && grandParent.tagName === "pre"

					if (!isCodeBlock) {
						textNode.value = textNode.value.replace(/\\\|/g, "|")
					}
				}
			}

			if (isElement) {
				const el = node
				if (
					el.tagName === "code" &&
					Array.isArray(el.children) &&
					el.children.length === 1 &&
					el.children[0].type === "text"
				) {
					const parentNode = ancestors[ancestors.length - 2]
					const isBlockCode = parentNode.tagName === "pre"
					const insideTableCell = ancestors.some((ancestor) => {
						if (ancestor === el) return false
						const a = ancestor
						return a.tagName === "td" || a.tagName === "th"
					})

					const childText = el.children[0]
					let raw = typeof childText.value === "string" ? childText.value : ""
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
									const codeNode = {
										type: "element",
										tagName: "code",
										properties: el.properties,
										children: [
											{
												type: "text",
												value: segment,
											},
										],
									}

									if (segmentIndex === segments.length - 1) {
										return [codeNode]
									}

									return [codeNode, { type: "text", value: " " }]
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

			const childNodes = isElement || isRoot ? node.children : []
			for (let i = 0; i < childNodes.length; i += 1) {
				visit(childNodes[i], node, i)
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
const versionScopedLinks = () => (tree, file) => {
	const path = file?.filename ?? file?.path ?? file?.history?.[0] ?? ""
	const match = /[/\\]content[/\\](v\d[^/\\]*)[/\\]/.exec(path)
	if (!match) return
	const base = `/${match[1]}`

	const visit = (node) => {
		if (node.type === "element" && node.tagName === "a") {
			const href = node.properties?.href
			if (typeof href === "string" && href.startsWith("/") && !href.startsWith("//")) {
				node.properties.href = href === "/" ? base : `${base}${href}`
			}
		}
		for (const child of node.children ?? []) visit(child)
	}
	visit(tree)
}

const themes = {
	light: "github-light",
	dark: "github-dark",
}
const highlighter = await createHighlighter({
	themes: Object.values(themes),
	langs: ["svelte", "bash", "json", "typescript", "tsx", "vue", "html"],
})

const markdownLayout = fileURLToPath(
	new URL("./src/lib/components/docs/MarkdownLayout.svelte", import.meta.url)
)

/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: [".svelte", ".svx"],
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: [
		mdsvex({
			extensions: [".svx"],
			layout: {
				_: markdownLayout,
			},
			rehypePlugins: [tableCellFormatter, rehypeSlug, versionScopedLinks],
			highlight: {
				highlighter: (code, lang = "text") => {
					const safeLang = lang ?? "text"
					const lightHtml = escapeSvelte(
						highlighter.codeToHtml(code, {
							lang: safeLang,
							theme: themes.light,
						})
					)
					const darkHtml = escapeSvelte(
						highlighter.codeToHtml(code, {
							lang: safeLang,
							theme: themes.dark,
						})
					)
					const htmlLightProp = JSON.stringify(lightHtml)
					const htmlDarkProp = JSON.stringify(darkHtml)
					const langProp = JSON.stringify(lang)
					const rawProp = JSON.stringify(code)
					return `<svelte:component this={Reflect.get(globalThis, "__MarkdownPre")} lang={${langProp}} htmlLight={${htmlLightProp}} htmlDark={${htmlDarkProp}} raw={${rawProp}} />`
				},
			},
		}),
		vitePreprocess(),
	],

	kit: {
		adapter: adapter(),
	},
}

export default config
