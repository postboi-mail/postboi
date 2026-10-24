import type { RequestHandler } from "./$types"
import { siteConfig } from "#site"

export const prerender = true

// /raw/ pages stay crawlable for AI agents; Google is kept out via X-Robots-Tag in _headers.
const directives = ["User-agent: *", "Allow: /"]

const toUrl = (path: string, origin: string) => new URL(path, origin).href

export const GET: RequestHandler = () => {
	const canonicalOrigin = new URL(siteConfig.url).origin
	// llms.txt is where an agent finds the /raw/ Markdown mirrors; robots.txt is the one file
	// it already knows to fetch, so name it here rather than hoping the convention is guessed.
	const lines = [
		...directives,
		`Sitemap: ${toUrl("/sitemap.xml", canonicalOrigin)}`,
		`# LLM-friendly Markdown: ${toUrl("/llms.txt", canonicalOrigin)}`,
	]
	const body = lines.join("\n")

	return new Response(body, {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "public, max-age=3600",
		},
	})
}
