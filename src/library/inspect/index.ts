/**
 * Static analysis for email HTML — the `postboi/inspect` module.
 *
 * {@link analyze} takes an email (raw HTML at minimum; text, subject and
 * headers when you have them) and returns a report: what will degrade in
 * which clients, what Gmail will clip, what a screen reader loses, what a
 * spam filter notices. It is synchronous, makes no network requests and adds
 * no dependencies, so it runs the same in a test, a Worker or the CLI.
 *
 * ```ts
 * import { analyze } from "postboi/inspect"
 * import Mock from "postboi/mock"
 *
 * const mail = new Mock()
 * await mail.send({ to: "ada@example.com", subject: "Hi", body: template })
 * const report = analyze({ html: mail.last?.html, text: mail.last?.text })
 * report.status // "pass" | "info" | "warning" | "error"
 * ```
 *
 * {@link check_links} is the async opt-in: it actually fetches the links the
 * report found, which is worth doing in a test suite and not in a Worker.
 */

import { pooled_map } from "../utils.js"
import { tokenize } from "./html.js"
import type { Tokenized } from "./html.js"
import { GMAIL_CLIP_BYTES, run_checks } from "./checks.js"
import { compat_findings } from "./compat.js"
import type {
	AnalyzeInput,
	Finding,
	ImageInfo,
	LinkCheck,
	LinkInfo,
	Report,
	Severity,
} from "./types.js"

export { hosted_test } from "./hosted.js"
export type {
	HostedTest,
	HostedTestOptions,
	HostedPreview,
	ScreenshotSummary,
	TestingPreview,
	TestingRun,
} from "./hosted.js"
export { GMAIL_CLIP_BYTES, MESSAGE_SIZE_LIMIT } from "./checks.js"
export { COMPAT_CLIENTS, COMPAT_FEATURES } from "./caniemail_data.js"
export type { Support, CompatClient, CompatFeature } from "./caniemail_data.js"
export type { TagToken, Tokenized } from "./html.js"
export type {
	AnalyzeInput,
	ClientImpact,
	Finding,
	ImageInfo,
	LinkCheck,
	LinkInfo,
	Report,
	Severity,
} from "./types.js"

function link_scheme(url: string): LinkInfo["scheme"] {
	const lower = url.trim().toLowerCase()
	if (lower.startsWith("https://")) return "https"
	if (lower.startsWith("http://")) return "http"
	if (lower.startsWith("mailto:")) return "mailto"
	if (lower.startsWith("tel:")) return "tel"
	return "other"
}

function extract_links(html: string, tokens: Tokenized): Array<LinkInfo> {
	const links: Array<LinkInfo> = []
	for (let i = 0; i < tokens.tags.length; i++) {
		const tag = tokens.tags[i]
		if (tag.closing || tag.name !== "a" || !tag.attrs.href?.trim()) continue

		const close = tokens.tags.find(
			(candidate, j) => j > i && candidate.closing && candidate.name === "a"
		)
		const text = close
			? html
					.slice(tag.position, close.position)
					.replace(/<[^>]*>/g, " ")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 120)
			: undefined

		links.push({
			url: tag.attrs.href.trim(),
			text: text || undefined,
			scheme: link_scheme(tag.attrs.href),
		})
	}
	return links
}

function extract_images(tokens: Tokenized): Array<ImageInfo> {
	return tokens.tags
		.filter((tag) => !tag.closing && tag.name === "img")
		.map((tag) => ({
			src: tag.attrs.src ?? "",
			alt: tag.attrs.alt,
			width: tag.attrs.width,
			height: tag.attrs.height,
		}))
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/**
 * Analyze one email. Synchronous, zero-network: safe to call anywhere.
 *
 * Pass what you have — checks that need a missing input stay silent rather
 * than guessing. Findings come back worst-first.
 */
export function analyze(input: AnalyzeInput): Report {
	const html = input.html ?? ""
	const tokens = tokenize(html)
	const links = extract_links(html, tokens)
	const images = extract_images(tokens)
	const html_bytes = new TextEncoder().encode(html).length

	// Header names are normalised here, once, so the checks can rely on lowercase
	// and a caller handing over canonically-cased headers isn't silently misread.
	const headers = input.headers
		? Object.fromEntries(
				Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value])
			)
		: undefined

	const findings = [
		...run_checks({ input: { ...input, headers }, tokens, links, images, html_bytes }),
		...compat_findings(tokens, images),
	].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

	const worst = findings[0]?.severity
	return {
		findings,
		status: worst ?? "pass",
		size: {
			html_bytes,
			gmail_clip: html_bytes > GMAIL_CLIP_BYTES,
			message_bytes: input.size_bytes,
		},
		links,
		images,
	}
}

export interface CheckLinksOptions {
	/** How many requests run at once. Defaults to 4. */
	concurrency?: number
	/** Per-request timeout in milliseconds. Defaults to 10 seconds. */
	timeout_ms?: number
	/** The fetch to use — inject a stub in tests. Defaults to the platform's. */
	fetch?: typeof globalThis.fetch
}

/**
 * Fetch every http(s) link and report which ones answer. The async opt-in
 * companion to {@link analyze} — run it where outbound requests are cheap (a
 * test suite, the CLI), not on every render.
 */
export async function check_links(
	links: Array<LinkInfo | string>,
	options: CheckLinksOptions = {}
): Promise<Array<LinkCheck>> {
	const { concurrency = 4, timeout_ms = 10_000, fetch = globalThis.fetch } = options
	const urls = links
		.map((link) => (typeof link === "string" ? link : link.url))
		.filter((url) => /^https?:\/\//i.test(url))

	return pooled_map([...new Set(urls)], concurrency, async (url) => {
		try {
			const response = await fetch(url, {
				redirect: "follow",
				signal: AbortSignal.timeout(timeout_ms),
			})
			return { url, ok: response.ok, status: response.status }
		} catch (error) {
			return { url, ok: false, error: error instanceof Error ? error.message : String(error) }
		}
	})
}

/** One finding, rendered as a line of terminal-friendly text. */
export function format_finding(finding: Finding): string {
	const badge = { error: "✗", warning: "!", info: "·" }[finding.severity]
	return `${badge} ${finding.message}`
}
