/**
 * Wiring a project's service worker for Web Push.
 *
 * `postboi/push` covers the page and `postboi/push/sw` covers the worker, but between them
 * sits the part nobody enjoys: finding the worker file, or deciding where one goes, and
 * knowing whether it can `import` at all. Of the frameworks postboi ships examples for,
 * only SvelteKit builds a service worker — Next, Nuxt, Astro and Remix serve `public/sw.js`
 * verbatim, where an import statement is a syntax error at load. So there are two shapes of
 * the same handlers, and this module picks the right one.
 *
 * Text edits and generated files only, and only shapes we're sure about — the same contract
 * `add_vite_plugin` works to. Anything ambiguous comes back as `"conflict"` and the caller
 * prints a manual hint rather than guessing at somebody's worker.
 */
import { has_dependency, type PackageJson } from "./project.js"

/** Can this worker file `import`, or is it served to the browser exactly as written? */
export type WorkerKind = "bundled" | "raw"

/** A service worker file: where it lives, what URL it's served at, and whether it bundles. */
export interface WorkerTarget {
	/** Project-relative path. */
	path: string
	/**
	 * The URL the browser registers. `subscribe()` defaults to `/sw.js`, so anything else
	 * has to be passed as `service_worker` — the single most common reason a wired-up push
	 * setup answers `no_service_worker`.
	 */
	url: string
	kind: WorkerKind
}

/**
 * Where a worker might already be, most specific first.
 *
 * Order matters: a project with both `src/service-worker.ts` and a leftover `static/sw.js`
 * means the bundled one, because that's the one its framework builds.
 */
const CANDIDATES: ReadonlyArray<WorkerTarget> = [
	{ path: "src/service-worker.ts", url: "/service-worker.js", kind: "bundled" },
	{ path: "src/service-worker.js", url: "/service-worker.js", kind: "bundled" },
	{ path: "src/sw.ts", url: "/sw.js", kind: "bundled" },
	{ path: "src/sw.js", url: "/sw.js", kind: "bundled" },
	{ path: "static/sw.js", url: "/sw.js", kind: "raw" },
	{ path: "static/service-worker.js", url: "/service-worker.js", kind: "raw" },
	{ path: "public/sw.js", url: "/sw.js", kind: "raw" },
	{ path: "public/service-worker.js", url: "/service-worker.js", kind: "raw" },
]

/** The worker this project already has, if any. */
export function find_worker(exists: (path: string) => boolean): WorkerTarget | undefined {
	return CANDIDATES.find((candidate) => exists(candidate.path))
}

/**
 * Where a worker should go when there isn't one.
 *
 * SvelteKit is the only framework here that builds `src/service-worker`, so it's the only
 * one that gets the real import — everywhere else the file is copied to the output
 * untouched and the handlers have to be written out. Guessing wrong costs an unbundled
 * `import` statement, which fails at worker startup with nothing pointing at the cause, so
 * the default when nothing is recognised is the safe one.
 */
export function suggest_worker(
	files: ReadonlyArray<string>,
	pkg: PackageJson | undefined,
	exists: (path: string) => boolean
): WorkerTarget {
	const sveltekit =
		has_dependency(pkg, "@sveltejs/kit") ||
		files.some((f) => /^svelte\.config\.(js|ts|mjs|mts)$/.test(f))
	if (sveltekit) {
		// `svelte-kit sync` writes one or the other, so this is a reliable read of which
		// language the project is in.
		return {
			path: exists("tsconfig.json") ? "src/service-worker.ts" : "src/service-worker.js",
			url: "/service-worker.js",
			kind: "bundled",
		}
	}
	// Everything else: a served-as-is file, in whichever static directory the project has.
	// `static/` is SvelteKit's name for it, so it's checked second — a non-Kit project with
	// a `static/` directory is using it for the same purpose.
	if (exists("public")) return { path: "public/sw.js", url: "/sw.js", kind: "raw" }
	if (exists("static")) return { path: "static/sw.js", url: "/sw.js", kind: "raw" }
	return { path: "public/sw.js", url: "/sw.js", kind: "raw" }
}

/** What the caller needs to write, or why it shouldn't. */
export type WireResult =
	/** The file already routes push through postboi. */
	| "present"
	/**
	 * The worker already handles `push` itself. Two handlers means two notifications for
	 * one send, so this is never a safe append — the caller prints a hint instead.
	 */
	| "conflict"
	| { source: string; action: "created" | "updated" }

export interface WireOptions {
	/** Endpoint a rotated subscription is POSTed to. */
	register: string
	/**
	 * VAPID public key, for the generated worker only — a raw file can't read the one
	 * `bunx postboi sync` bakes into the package. Omitted, a rotation is only re-filed on
	 * the browsers that hand over the replacement themselves.
	 */
	key?: string
}

/** Is postboi's push already wired into this source? Both shapes name the module. */
const WIRED = "postboi/push/sw"

/** Does this worker already handle `push` on its own? */
function handles_push(source: string): boolean {
	return /addEventListener\s*\(\s*["'`]push["'`]/.test(source) || /\bonpush\s*=/.test(source)
}

/**
 * Wire push into a worker: the import for a bundled one, the handlers written out for a
 * raw one, and a whole file when there isn't one yet.
 *
 * `source` is the existing file's contents, or undefined to create it.
 */
export function wire_worker(
	target: WorkerTarget,
	source: string | undefined,
	options: WireOptions
): WireResult {
	const block = target.kind === "bundled" ? import_block(options) : handler_block(options)

	if (source === undefined) return { source: `${header()}\n${block}`, action: "created" }
	if (source.includes(WIRED)) return "present"
	if (handles_push(source)) return "conflict"

	// Appended rather than merged. A worker that already exists is doing something, and the
	// end of the file is the one place a listener can be added without landing inside it.
	const separator = source.endsWith("\n") ? "\n" : "\n\n"
	return { source: `${source}${separator}${block}`, action: "updated" }
}

/** The comment a generated file opens with. Existing files keep their own. */
function header(): string {
	return `// Service worker, created by \`bunx postboi init --push\`.
// Receive-only: no fetch handler and no caching — a worker that intercepts requests is a
// different feature, and this one only exists to deliver notifications.
`
}

/** The bundled shape: one import and one call. */
function import_block(options: WireOptions): string {
	return `import { receive } from "postboi/push/sw"

// Shows the notification, opens the right tab on click, and re-subscribes when the browser
// rotates this subscription — the last of which only fires inside a worker, which is why
// it can't live on the page with the rest of postboi/push.
receive({ register: ${JSON.stringify(options.register)} })
`
}

/**
 * The raw shape: the same three handlers written out, because this file is served exactly
 * as it appears and an `import` would fail at worker startup.
 *
 * Generated rather than imported, so it's the user's code from here — but it is checked
 * against `receive()` in `service_worker.test.ts`, which drives both through one fake
 * worker and compares what came out. A change to one that isn't made to the other fails
 * that test.
 */
function handler_block(options: WireOptions): string {
	const key = options.key
	return `// These are the same handlers \`receive()\` from postboi/push/sw registers, written out
// because this file is served exactly as written and can't import. Yours to edit.

const POSTBOI_REGISTER = ${JSON.stringify(options.register)}
${
	key
		? `// The VAPID public key the page subscribes with, needed to re-subscribe after a rotation.\nconst POSTBOI_VAPID_KEY = ${JSON.stringify(key)}`
		: `// No VAPID public key was available when this was written. Without one, a rotation can\n// only be re-filed on browsers that hand over the replacement themselves — paste the\n// public half of your pair here to cover the rest.\nconst POSTBOI_VAPID_KEY = ""`
}

self.addEventListener("push", (event) => {
	let payload = {}
	try {
		payload = (event.data && event.data.json()) || {}
	} catch {
		// Something that isn't postboi sent this. Showing its text beats showing nothing:
		// a push handler that throws shows nothing at all, and a browser that sees pushes
		// arrive with no notification takes the permission away.
		payload = { body: event.data ? event.data.text() : "" }
	}
	// Every push owes the user a notification — that's what \`userVisibleOnly\` promised.
	// Put your app's name in place of the "" below to give untitled sends a title.
	event.waitUntil(
		self.registration.showNotification(payload.title ?? "", {
			body: payload.body ?? "",
			icon: payload.icon,
			data: { ...payload.data, url: payload.url },
		})
	)
})

self.addEventListener("notificationclick", (event) => {
	event.notification.close()
	const url = event.notification.data && event.notification.data.url
	if (!url) return
	event.waitUntil(
		(async () => {
			// Focus the tab already showing it rather than opening a second one.
			const target = new URL(url, self.location.origin).href
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
			const showing = windows.find((client) => client.url === target)
			await (showing ? showing.focus() : self.clients.openWindow(target))
		})()
	)
})

// Subscriptions expire, and browsers replace them on their own schedule. This event fires
// nowhere but here — without it, the address on the server is dead and the next
// notification silently goes nowhere before the 410 cleans it up.
self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil(
		(async () => {
			let subscription = event.newSubscription ?? null
			if (!subscription) {
				// Firefox hands over the replacement it made; Chrome expects a fresh subscribe.
				if (!POSTBOI_VAPID_KEY) return
				const base64 = POSTBOI_VAPID_KEY.replace(/-/g, "+").replace(/_/g, "/")
				const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
				subscription = await self.registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
				})
			}
			const json = subscription.toJSON()
			// \`old_endpoint\` is what makes this a swap rather than a leak: delete that row,
			// then store the rest. It's absent on browsers that don't say what was replaced.
			await fetch(POSTBOI_REGISTER, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					endpoint: json.endpoint,
					expirationTime: json.expirationTime ?? null,
					keys: json.keys,
					...(event.oldSubscription && { old_endpoint: event.oldSubscription.endpoint }),
				}),
			})
		})()
	)
})
`
}

/**
 * The line the page needs, once the worker is in place. `subscribe()` looks for `/sw.js`,
 * so a worker served anywhere else has to say where it is.
 */
export function page_snippet(target: WorkerTarget, register: string): string {
	const path = target.url === "/sw.js" ? "" : `, service_worker: ${JSON.stringify(target.url)}`
	return `subscription({ register: ${JSON.stringify(register)}${path} })`
}
