/**
 * The route managed push needs on a signed-in app: one file, one line naming the signed-in
 * user, written where the project's framework serves routes. `push.handler` does the rest.
 *
 * Only frameworks whose route handlers take a `Request` (or carry one) are written for —
 * that is what `push.handler` reads. Anything else gets the two calls it wraps, to drop
 * into a handler of its own.
 */
import { has_dependency, type PackageJson } from "./project.js"

/** A route file to write, and the URL the page's toggle posts to. */
export interface PushRoute {
	path: string
	url: string
	source: string
}

const IMPORT = 'import { push } from "postboi"\n\n'

const EXPLAIN = `// Files the browser's push subscription under whoever is signed in, so
// \`push({ to: { user } })\` reaches every browser that person turned notifications on in.
// A signed-out request answers 401, and the toggle on the page undoes the subscription.
`

/**
 * Where this project's route goes, and what it says. Undefined when the framework isn't
 * one whose handlers carry a `Request`.
 */
export function push_route(
	pkg: PackageJson | undefined,
	exists: (path: string) => boolean
): PushRoute | undefined {
	const ts = exists("tsconfig.json")
	const ext = ts ? "ts" : "js"

	if (has_dependency(pkg, "@sveltejs/kit")) {
		return {
			path: `src/routes/push/+server.${ext}`,
			url: "/push",
			source: `${IMPORT}${EXPLAIN}// Change \`event.locals.user?.id\` to however your app knows who is signed in.
export const { POST, DELETE } = push.handler((event) => event.locals.user?.id)
`,
		}
	}

	if (has_dependency(pkg, "next")) {
		const root = exists("src/app") ? "src/app" : exists("app") ? "app" : undefined
		if (!root) return undefined
		return {
			path: `${root}/push/route.${ext}`,
			url: "/push",
			source: `${IMPORT}${EXPLAIN}// Answer with the signed-in user's id from your auth library's session lookup.
// Until you do, every request is a 401 and nothing is filed.
export const { POST, DELETE } = push.handler(async (request${ts ? ": Request" : ""}) => {
	void request
	return null
})
`,
		}
	}

	if (has_dependency(pkg, "astro")) {
		return {
			path: `src/pages/push.${ext}`,
			url: "/push",
			source: `${IMPORT}${EXPLAIN}// Change \`context.locals.user?.id\` to however your app knows who is signed in.
export const prerender = false
export const { POST, DELETE } = push.handler((context) => context.locals.user?.id)
`,
		}
	}

	return undefined
}

/** The two calls `push.handler` wraps, for a framework it can't. */
export const MANUAL_ROUTE = `import { push } from "postboi"

// POST: the subscription the page sends, filed under the signed-in user
await push.subscriptions.add(subscription, { user: signed_in_user_id })
// DELETE: { endpoint }, only if it's that same person's
await push.subscriptions.remove(endpoint, { user: signed_in_user_id })`
