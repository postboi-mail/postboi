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

// A Shiki port of Aura Soft Dark (https://github.com/daltonmenezes/aura-theme) — the Aura
// palette mapped onto TextMate scopes. Used for code blocks in both light and dark mode.
const aura = {
	bg: "#21202e",
	fg: "#edecee",
	purple: "#a277ff",
	green: "#61ffca",
	orange: "#ffca85",
	blue: "#82e2ff",
	pink: "#f694ff",
	red: "#ff6767",
	gray: "#6d6d6d",
}
const auraSoftDark = {
	name: "aura-soft-dark",
	type: "dark",
	colors: {
		"editor.background": aura.bg,
		"editor.foreground": aura.fg,
	},
	tokenColors: [
		{
			scope: ["comment", "punctuation.definition.comment"],
			settings: { foreground: aura.gray, fontStyle: "italic" },
		},
		{
			scope: ["string", "string.quoted", "punctuation.definition.string", "string.template"],
			settings: { foreground: aura.green },
		},
		{
			scope: [
				"constant.numeric",
				"constant.language",
				"constant.language.boolean",
				"constant.character",
				"constant.other",
				"support.constant",
			],
			settings: { foreground: aura.orange },
		},
		{
			scope: [
				"keyword",
				"keyword.control",
				"keyword.operator.new",
				"keyword.operator.expression",
				"storage",
				"storage.type",
				"storage.modifier",
			],
			settings: { foreground: aura.purple },
		},
		{ scope: ["keyword.operator"], settings: { foreground: aura.fg } },
		{
			scope: [
				"entity.name.function",
				"support.function",
				"meta.function-call",
				"meta.function-call.generic",
			],
			settings: { foreground: aura.blue },
		},
		{
			scope: [
				"entity.name.type",
				"entity.name.class",
				"support.type",
				"support.class",
				"entity.other.inherited-class",
				"meta.type",
			],
			settings: { foreground: aura.orange },
		},
		{
			scope: ["variable", "variable.other", "variable.parameter", "meta.definition.variable"],
			settings: { foreground: aura.fg },
		},
		{
			scope: ["variable.language", "variable.language.this", "keyword.other.this"],
			settings: { foreground: aura.purple },
		},
		{
			scope: ["entity.name.tag", "punctuation.definition.tag", "meta.tag"],
			settings: { foreground: aura.purple },
		},
		{ scope: ["entity.other.attribute-name"], settings: { foreground: aura.green } },
		{
			scope: ["support.type.property-name", "meta.object-literal.key", "variable.other.property"],
			settings: { foreground: aura.fg },
		},
		{ scope: ["string.regexp", "constant.character.escape"], settings: { foreground: aura.pink } },
		{
			scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"],
			settings: { foreground: aura.fg },
		},
		{ scope: ["invalid", "invalid.illegal"], settings: { foreground: aura.red } },
	],
}

// A Shiki port of Ayu Light (https://github.com/ayu-theme) — the light counterpart used in
// light mode. Warm, soft palette that pairs with Aura's dark.
const ayu = {
	bg: "#fcfcfc",
	fg: "#5c6166",
	orange: "#fa8d3e",
	salmon: "#ed9366",
	gold: "#f2ae49",
	green: "#86b300",
	purple: "#a37acc",
	blue: "#399ee6",
	cyan: "#55b4d4",
	teal: "#4cbf99",
	gray: "#8a9199",
	red: "#e65050",
}
const ayuLight = {
	name: "ayu-light",
	type: "light",
	colors: {
		"editor.background": ayu.bg,
		"editor.foreground": ayu.fg,
	},
	tokenColors: [
		{
			scope: ["comment", "punctuation.definition.comment"],
			settings: { foreground: ayu.gray, fontStyle: "italic" },
		},
		{
			scope: ["string", "string.quoted", "punctuation.definition.string", "string.template"],
			settings: { foreground: ayu.green },
		},
		{
			scope: [
				"constant.numeric",
				"constant.language",
				"constant.language.boolean",
				"constant.character",
				"constant.other",
				"support.constant",
			],
			settings: { foreground: ayu.purple },
		},
		{
			scope: [
				"keyword",
				"keyword.control",
				"keyword.operator.new",
				"keyword.operator.expression",
				"storage",
				"storage.type",
				"storage.modifier",
			],
			settings: { foreground: ayu.orange },
		},
		{ scope: ["keyword.operator"], settings: { foreground: ayu.salmon } },
		{
			scope: [
				"entity.name.function",
				"support.function",
				"meta.function-call",
				"meta.function-call.generic",
			],
			settings: { foreground: ayu.gold },
		},
		{
			scope: [
				"entity.name.type",
				"entity.name.class",
				"support.type",
				"support.class",
				"entity.other.inherited-class",
				"meta.type",
			],
			settings: { foreground: ayu.blue },
		},
		{
			scope: ["variable", "variable.other", "variable.parameter", "meta.definition.variable"],
			settings: { foreground: ayu.fg },
		},
		{
			scope: ["variable.language", "variable.language.this", "keyword.other.this"],
			settings: { foreground: ayu.orange },
		},
		{
			scope: ["entity.name.tag", "punctuation.definition.tag", "meta.tag"],
			settings: { foreground: ayu.cyan },
		},
		{ scope: ["entity.other.attribute-name"], settings: { foreground: ayu.gold } },
		{
			scope: ["support.type.property-name", "meta.object-literal.key", "variable.other.property"],
			settings: { foreground: ayu.fg },
		},
		{ scope: ["string.regexp", "constant.character.escape"], settings: { foreground: ayu.teal } },
		{
			scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"],
			settings: { foreground: ayu.fg },
		},
		{ scope: ["invalid", "invalid.illegal"], settings: { foreground: ayu.red } },
	],
}

const themes = {
	light: "ayu-light",
	dark: "aura-soft-dark",
}
const highlighter = await createHighlighter({
	themes: [ayuLight, auraSoftDark],
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
		// The library's tests import via `$library/*`; the docs app uses the default `$lib`.
		alias: {
			$library: "src/library",
		},
	},
}

export default config
