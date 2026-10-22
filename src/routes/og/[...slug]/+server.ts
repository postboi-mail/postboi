import { error } from "@sveltejs/kit"
import { ImageResponse } from "takumi-js/response"
import type { RequestHandler } from "./$types"
import { brandLogoRaw, siteConfig } from "$site"
import {
	getContentSectionConfig,
	getContentSectionItemBySlug,
	getContentSectionHref,
	getContentSectionManifest,
} from "$site/content/sections"
import { getContentSectionMetadata } from "$site/content/sources"
import { contentSections } from "$site/config/navigation"
// The static cuts, not the variable ones the site loads: the image renderer wants
// a single instance per weight, and a variable file would arrive at whatever its
// default axis happens to be.
import archivo_700 from "@fontsource/archivo/files/archivo-latin-700-normal.woff2?inline"
import golos_400 from "@fontsource/golos-text/files/golos-text-latin-400-normal.woff2?inline"

export const prerender = true

// Single content section mounted at the site root.
const sectionId = contentSections[0].id

export const entries = () =>
	getContentSectionManifest(sectionId).map((item) => ({ slug: item.slug || "index" }))

const OG_WIDTH = 1200
const OG_HEIGHT = 630
const MAX_TITLE_LENGTH = 88
const MAX_DESCRIPTION_LENGTH = 180
const canonicalOrigin = new URL(siteConfig.url).origin

type TakumiElement = {
	type: string
	props: Record<string, unknown>
}

type TakumiChild = TakumiElement | string

const el = (
	type: string,
	props: Record<string, unknown> = {},
	...children: TakumiChild[]
): TakumiElement => ({
	type,
	props:
		children.length === 0
			? props
			: {
					...props,
					children: children.length === 1 ? children[0] : children,
				},
})

const clampText = (value: string, maxLength: number) => {
	const text = value.trim()
	if (text.length <= maxLength) return text
	return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

const dataUriToArrayBuffer = (dataUri: string) => {
	const base64 = dataUri.slice(dataUri.indexOf(",") + 1)

	if (typeof Buffer !== "undefined") {
		const bytes = Buffer.from(base64, "base64")
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
	}

	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes.buffer
}

const fontDataPromise = Promise.all([
	Promise.resolve(dataUriToArrayBuffer(archivo_700)),
	Promise.resolve(dataUriToArrayBuffer(golos_400)),
])

const takumiFontLoaders = [
	{
		key: "archivo-latin-700-normal",
		name: "Archivo",
		weight: 700,
		style: "normal" as const,
		data: async () => (await fontDataPromise)[0],
	},
	{
		key: "golos-text-latin-400-normal",
		name: "Golos Text",
		weight: 400,
		style: "normal" as const,
		data: async () => (await fontDataPromise)[1],
	},
]

/* The press, as literals. The renderer has no CSS engine, so the oklch tokens in
   layout.css are converted here once rather than approximated per use. */
const PAPER = "#f5f0e3"
const INK = "#080c1b"
const MUTED = "#505561"
const YELLOW = "#fdc010"

// The mark is drawn in currentColor, and the renderer has no cascade to take it
// from — so it is substituted here. Ink, not the brand orange the white card used
// to need: on manila this is a printed mark, and the yellow block under the title
// is where the brand colour lands. See BRANDING.md.
const logoDataUri = `data:image/svg+xml,${encodeURIComponent(
	brandLogoRaw.replaceAll("currentColor", "#080c1b")
)}`
const LOGO_DISPLAY_HEIGHT = 78

const extractLogoAspectRatio = (svgMarkup: string) => {
	const viewBoxMatch = /viewBox="([^"]+)"/i.exec(svgMarkup)
	if (viewBoxMatch) {
		const [, rawViewBox] = viewBoxMatch
		const values = rawViewBox
			.trim()
			.split(/\s+/)
			.map((value) => Number(value))
		if (
			values.length === 4 &&
			Number.isFinite(values[2]) &&
			Number.isFinite(values[3]) &&
			values[2] > 0 &&
			values[3] > 0
		) {
			return values[2] / values[3]
		}
	}

	const widthMatch = /width="([^"]+)"/i.exec(svgMarkup)
	const heightMatch = /height="([^"]+)"/i.exec(svgMarkup)
	if (widthMatch && heightMatch) {
		const width = Number(widthMatch[1])
		const height = Number(heightMatch[1])
		if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
			return width / height
		}
	}

	return 1
}

const logoDisplayWidth = Math.round(LOGO_DISPLAY_HEIGHT * extractLogoAspectRatio(brandLogoRaw))

export const GET: RequestHandler = async ({ params }) => {
	const section = getContentSectionConfig(sectionId)
	const rawSlug = params.slug.replace(/^\/+|\/+$/g, "")
	const slug = rawSlug === "" || rawSlug === "index" ? "" : rawSlug

	const metadata = await getContentSectionMetadata(
		sectionId,
		getContentSectionHref(sectionId, slug)
	)
	if (!metadata) {
		error(404, "Document not found")
	}

	const category = getContentSectionItemBySlug(sectionId, metadata.slug)?.category ?? section.label
	const title = clampText(metadata.title, MAX_TITLE_LENGTH)
	const description = clampText(
		metadata.description ?? `${section.label} documentation.`,
		MAX_DESCRIPTION_LENGTH
	)
	const pageUrl = new URL(getContentSectionHref(sectionId, metadata.slug), canonicalOrigin).href

	const component = el(
		"div",
		{
			style: {
				display: "flex",
				flexDirection: "column",
				justifyContent: "space-between",
				width: "100%",
				height: "100%",
				padding: 56,
				background: PAPER,
				fontFamily: "Golos Text, sans-serif",
			},
		},
		el(
			"div",
			{
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				},
			},
			el("img", {
				src: logoDataUri,
				alt: "",
				style: {
					display: "flex",
					width: logoDisplayWidth,
					height: LOGO_DISPLAY_HEIGHT,
				},
			}),
			el(
				"div",
				{
					style: {
						display: "flex",
						fontFamily: "Archivo, sans-serif",
						fontSize: 20,
						letterSpacing: "0.2em",
						textTransform: "uppercase",
						color: MUTED,
						fontWeight: 700,
					},
				},
				pageUrl.replace(/^https?:\/\//, "")
			)
		),
		el(
			"div",
			{
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 26,
				},
			},
			el(
				"div",
				{
					style: {
						display: "flex",
						fontFamily: "Archivo, sans-serif",
						fontSize: 20,
						letterSpacing: "0.2em",
						textTransform: "uppercase",
						color: MUTED,
						fontWeight: 700,
					},
				},
				category
			),
			el(
				"div",
				{
					style: {
						display: "flex",
						maxWidth: 1060,
						fontFamily: "Archivo, sans-serif",
						fontSize: 92,
						lineHeight: 0.98,
						letterSpacing: "-0.03em",
						textTransform: "uppercase",
						color: INK,
						fontWeight: 700,
					},
				},
				title
			),
			// The rule the site draws under every masthead, with the brand's own
			// block struck on the left of it.
			el(
				"div",
				{ style: { display: "flex", height: 6 } },
				el("div", { style: { display: "flex", width: 96, height: 6, background: YELLOW } }),
				el("div", { style: { display: "flex", flexGrow: 1, height: 6, background: INK } })
			),
			el(
				"div",
				{
					style: {
						display: "flex",
						maxWidth: 1020,
						fontSize: 34,
						lineHeight: 1.3,
						color: MUTED,
						fontWeight: 400,
					},
				},
				description
			)
		)
	)

	// Takumi renders these plain element objects fine; its param is typed as ReactNode,
	// which only bites now that @types/react is installed (for the postboi/react export).
	const response = new ImageResponse(component as never, {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		format: "png",
		fonts: takumiFontLoaders,
		headers: {
			"content-type": "image/png",
			"cache-control": "public, max-age=3600",
		},
	})

	await response.ready
	return response
}
