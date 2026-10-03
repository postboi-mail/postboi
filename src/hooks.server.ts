import type { Handle } from "@sveltejs/kit/hooks"

/**
 * The docs moved to docs.postboi.app; docs.postboi.email forwards the links already loose in
 * the world — READMEs, old release notes, search results.
 *
 * The rule that does the actual work is a zone Redirect Rule on postboi.email, not this hook
 * and not `_redirects`. Both in-repo options fail for their own reason: a prerendered page is
 * served straight off the assets binding without the worker running at all, so this hook only
 * ever sees requests that missed the asset lookup — on a fully prerendered docs site, 404s and
 * little else — and Workers Static Assets rejects an absolute URL in `_redirects`, which is
 * what a host-scoped rule needs. A host redirect is an edge concern; it belongs in front of
 * the worker rather than inside it. This stays as the backstop for anything rendered on demand
 * later.
 *
 * GET-only, matching the app's own redirect: a 301 turns a POST into a GET and drops its
 * body. Nothing here takes a POST today, but a docs site grows a search or feedback endpoint
 * eventually, and the guard costs one comparison.
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (event.request.method === "GET" && event.url.hostname === "docs.postboi.email") {
		const to = new URL(event.url)
		to.protocol = "https:"
		to.hostname = "docs.postboi.app"
		return new Response(null, { status: 301, headers: { location: to.href } })
	}

	return resolve(event)
}
