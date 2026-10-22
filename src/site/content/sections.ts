import type { ContentItem, ContentSectionLink } from "#site/config/navigation.js"
import { contentSections, type ContentSectionConfig } from "#site/config/navigation.js"
import { mergeSectionUiConfig, type SectionUiConfig } from "#site/config/content-ui.js"
import {
	flattenNavigationToManifest,
	getAdjacentItems,
	getHref,
	getItemBySlug,
} from "#site/content/manifest.js"
import versions from "#site/config/versions.json"
import type { Component } from "svelte"

// Sections are nav data: which pages exist, where they live, what sits next to them.
// Reading a page's own source — its component, Markdown, frontmatter, headings — lives in
// `sources.ts`, and the split is deliberate: this module is small enough to sit in the
// deployed Worker, that one drags every archived version in with it. Keep globs out.

export type ContentSectionId = string

export type ContentMetadata = {
	href: string
	slug: string
	title: string
	description?: string
	sourceType: "svx" | "svelte"
}

export type ContentTocHeading = {
	id: string
	text: string
	level: number
}

export type ContentModule = {
	default: Component
	metadata?: Record<string, unknown>
}

// The latest version mounts at the site root (no prefix); each archived version
// mounts at `/${slug}`. Content lives under `content/${id}/` for module lookups —
// archived versions are committed snapshots of the docs at that release.
const latestSectionId = contentSections[0].id

const versionSections: ContentSectionConfig[] = versions.archived.map((v) => ({
	id: v.slug,
	label: `v${v.version}`,
	navigation: v.nav as ContentItem[],
}))

const allSections = [...contentSections, ...versionSections]

function basePathFor(id: string): string {
	return id === latestSectionId ? "" : `/${id}`
}

const contentSectionsById = Object.fromEntries(
	allSections.map((section) => [section.id, section])
) as Record<ContentSectionId, ContentSectionConfig>

const contentManifests = Object.fromEntries(
	allSections.map((section) => [section.id, flattenNavigationToManifest(section.navigation)])
) as Record<ContentSectionId, ContentItem[]>

export function getContentSectionConfig(sectionId: ContentSectionId) {
	return contentSectionsById[sectionId]
}

export function getContentSectionUiConfig(sectionId: ContentSectionId): SectionUiConfig {
	return mergeSectionUiConfig(contentSectionsById[sectionId].ui)
}

// Section links are the top-level content sections only — archived versions are
// switched via the sidebar version dropdown, not this section picker.
const rootSectionOrder: ContentSectionId[] = contentSections.map((section) => section.id)

export function getContentSectionLinks(order: ContentSectionId[] = rootSectionOrder) {
	return order.map((sectionId): ContentSectionLink => {
		const section = contentSectionsById[sectionId]
		return {
			label: section.label,
			href: basePathFor(section.id),
			icon: section.icon,
			description: section.description,
		}
	})
}

export function getContentSectionManifest(sectionId: ContentSectionId) {
	return contentManifests[sectionId]
}

export function getContentSectionSlug(sectionId: ContentSectionId, pathname: string) {
	return pathToSlug(basePathFor(sectionId), pathname)
}

export function getContentSectionItemBySlug(sectionId: ContentSectionId, slug: string) {
	return getItemBySlug(contentManifests[sectionId], slug)
}

export function getContentSectionAdjacentItems(sectionId: ContentSectionId, slug: string) {
	return getAdjacentItems(contentManifests[sectionId], slug)
}

export function getContentSectionHref(sectionId: ContentSectionId, slug: string) {
	return getHref(basePathFor(sectionId), slug)
}

export function getContentSectionRawHref(sectionId: ContentSectionId, slug: string) {
	const prefix = basePathFor(sectionId)
	const normalizedSlug = slug || "index"
	return `${prefix}/raw/${normalizedSlug}`
}

export function getContentSectionBasePath(sectionId: ContentSectionId) {
	return basePathFor(sectionId)
}

export function getContentSectionByPathname(pathname: string) {
	const normalized = normalizePath(pathname)
	// Prefer the most specific base path so `/v0.5.0/x` resolves to the archived
	// section, not the root section (whose base path `""` matches everything).
	const section = Object.values(contentSectionsById)
		.slice()
		.sort((a, b) => basePathFor(b.id).length - basePathFor(a.id).length)
		.find((s) => {
			const bp = basePathFor(s.id)
			return normalized === bp || normalized.startsWith(`${bp}/`)
		})
	return section ?? null
}

/** Resolve a full pathname to its section id + section-relative slug. */
export function resolveSection(pathname: string): { sectionId: ContentSectionId; slug: string } {
	const section = getContentSectionByPathname(pathname) ?? contentSectionsById[latestSectionId]
	return { sectionId: section.id, slug: pathToSlug(basePathFor(section.id), pathname) }
}

/** Every routable page across all sections, as catch-all slug params. */
export function getAllContentEntries(): { slug: string }[] {
	return allSections.flatMap((section) =>
		contentManifests[section.id].map((item) => {
			const href = getHref(basePathFor(section.id), item.slug)
			return { slug: href === "/" ? "" : href.replace(/^\//, "") }
		})
	)
}

function normalizePath(path: string) {
	if (path === "/") return path
	return path.replace(/\/+$/, "")
}

function pathToSlug(basePath: string, pathname: string) {
	const normalized = normalizePath(pathname)
	if (normalized === basePath || normalized === "") return ""
	return normalized.replace(new RegExp(`^${basePath}/`), "")
}
