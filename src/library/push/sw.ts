/**
 * The service worker half of Web Push — the three handlers every app writes by hand.
 *
 * `postboi/push` covers the page: permission, registration, subscribe, the toggle. None of
 * it can reach inside the worker, and that's where the rest of push actually happens —
 * `push` (show the notification), `notificationclick` (open the thing), and
 * `pushsubscriptionchange`, which fires *only* here and is the one everybody skips.
 *
 * Subscriptions rotate. Browsers replace them on their own schedule, and when that happens
 * the address you stored is dead and the browser's replacement is one nobody has told you
 * about. Without a `pushsubscriptionchange` handler the gap closes on its own — the next
 * send 410s and `push.expired()` deletes the row — but only *after* one notification has
 * silently gone nowhere. This handler re-subscribes and re-files, so nothing is missed.
 *
 * Import it into a service worker your bundler builds (SvelteKit's `src/service-worker.ts`,
 * a Vite/webpack SW entry). A hand-written `static/sw.js` is served verbatim and can't
 * import anything — bundle it, or keep hand-rolling.
 *
 * @example
 * ```ts
 * // src/service-worker.ts
 * import { receive } from "postboi/push/sw"
 *
 * receive({ register: "/push/subscriptions" })
 * ```
 */
import { from_base64url } from "../encoding.js"
import { vapid_public_key } from "../register.js"
import { subscription_json, type PushSubscriptionJSON } from "./client.js"
import type { PushPayload } from "./types.js"

/**
 * What a rotated subscription is filed as: the new subscription, plus the endpoint it
 * replaced when the browser told us one.
 *
 * `old_endpoint` is the difference between a swap and a leak — without it the server gains
 * a row and keeps the dead one until something tries to send to it. Treat it as "delete
 * this, then store the rest"; it's absent on the browsers that don't hand the old
 * subscription over, and a register endpoint that ignores it still works.
 */
export type RotatedSubscription = PushSubscriptionJSON & { old_endpoint?: string }

/** A notification as `showNotification` takes it — the title, then everything else. */
export type NotificationSpec = { title: string } & NotificationOptions

/** Options for {@link receive}. */
export interface ReceiveOptions {
	/**
	 * VAPID **public** key, base64url, used to re-subscribe after a rotation. Optional once
	 * `bunx postboi sync` has baked it from `VAPID_PUBLIC_KEY` — the same key the page half
	 * resolves, so the two can't drift apart.
	 */
	key?: string
	/**
	 * Where a rotated subscription gets re-filed: the URL it's POSTed to as
	 * {@link RotatedSubscription} JSON, or a function for anything beyond that. Normally the
	 * same endpoint the toggle's `register` posts to.
	 *
	 * Without it a rotation is noticed and then forgotten, which is what not having this
	 * handler at all already does.
	 */
	register?: string | ((subscription: RotatedSubscription) => Promise<unknown>)
	/**
	 * Adjust the notification before it's shown — returns the fields to override, merged
	 * over the defaults. The escape hatch for the two things the payload can't carry: an
	 * app-name fallback when a send had no title, and `tag`/`renotify`/`actions`.
	 *
	 * ```ts
	 * receive({ notification: (payload) => ({ title: payload.title ?? "Acme" }) })
	 * ```
	 */
	notification?: (payload: PushPayload) => Partial<NotificationSpec> | undefined
}

/**
 * The worker globals this file touches, named locally.
 *
 * `ServiceWorkerGlobalScope`, `PushEvent` and friends live in TypeScript's `webworker` lib,
 * which can't be loaded alongside `dom` in one program — and this package is compiled
 * against `dom`, like every app importing it. Declaring the handful of members used here
 * keeps the module compiling in any project, at the cost of these being structural rather
 * than the real thing.
 */
interface ExtendableEventLike {
	waitUntil(promise: Promise<unknown>): void
}
interface PushEventLike extends ExtendableEventLike {
	data: { json(): unknown; text(): string } | null
}
interface NotificationEventLike extends ExtendableEventLike {
	notification: { close(): void; data?: { url?: string } | null }
}
interface SubscriptionChangeEventLike extends ExtendableEventLike {
	oldSubscription?: PushSubscription | null
	newSubscription?: PushSubscription | null
}
interface WindowClientLike {
	url: string
	focus(): Promise<unknown>
}
interface WorkerScope {
	location: { origin: string }
	registration: ServiceWorkerRegistration
	clients: {
		matchAll(options?: {
			type?: string
			includeUncontrolled?: boolean
		}): Promise<readonly WindowClientLike[]>
		openWindow(url: string): Promise<unknown>
	}
	addEventListener(type: "push", handler: (event: PushEventLike) => void): void
	addEventListener(type: "notificationclick", handler: (event: NotificationEventLike) => void): void
	addEventListener(
		type: "pushsubscriptionchange",
		handler: (event: SubscriptionChangeEventLike) => void
	): void
}

/** Read the JSON postboi's Web Push provider sends, without ever throwing.
 *
 * A push handler that throws shows nothing, and a browser that sees pushes arrive with no
 * notification revokes the permission — so a payload from something that isn't postboi
 * degrades to a body rather than costing the subscriber. */
function read(data: PushEventLike["data"]): PushPayload {
	if (!data) return {}
	try {
		return (data.json() as PushPayload | null) ?? {}
	} catch {
		return { body: data.text() }
	}
}

/** File a rotated subscription with the server. POST only — a rotation replaces, it
 * never deletes. */
async function file(
	target: NonNullable<ReceiveOptions["register"]>,
	subscription: RotatedSubscription
): Promise<void> {
	if (typeof target === "function") {
		await target(subscription)
		return
	}
	const response = await fetch(target, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(subscription),
	})
	if (!response.ok) throw new Error(`POST ${target} answered ${response.status}`)
}

/**
 * Register the `push`, `notificationclick` and `pushsubscriptionchange` handlers.
 *
 * Call it once, at the top level of your service worker. It only adds listeners: no fetch
 * handler, no caching, no claiming clients — a worker that intercepts requests is a
 * different feature and yours may already be one.
 *
 * @example
 * ```ts
 * // src/service-worker.ts
 * import { receive } from "postboi/push/sw"
 *
 * receive({
 * 	register: "/push/subscriptions",
 * 	notification: (payload) => ({ title: payload.title ?? "Acme" }),
 * })
 * ```
 */
export function receive(options: ReceiveOptions = {}): void {
	const scope = globalThis as unknown as WorkerScope

	scope.addEventListener("push", (event) => {
		const payload = read(event.data)
		// An empty title still shows — `userVisibleOnly` means every push owes the user a
		// notification, and the browser withdraws the permission from workers that skip one.
		// `notification` is where an app-name fallback goes.
		const { title, ...rest } = {
			title: payload.title ?? "",
			body: payload.body ?? "",
			icon: payload.icon,
			data: { ...payload.data, url: payload.url },
			...options.notification?.(payload),
		} satisfies NotificationSpec
		event.waitUntil(scope.registration.showNotification(title, rest))
	})

	scope.addEventListener("notificationclick", (event) => {
		event.notification.close()
		const url = event.notification.data?.url
		// No `url` means the send didn't ask for navigation. Guessing one (the origin, the
		// last page) is how a notification click throws away what someone was doing.
		if (url) event.waitUntil(focus_or_open(scope, url))
	})

	scope.addEventListener("pushsubscriptionchange", (event) => {
		event.waitUntil(rotate(scope, event, options))
	})
}

/** Focus the tab already showing this URL, or open one. Without the lookup every click
 * opens a duplicate, which is the single most-reported thing wrong with hand-rolled
 * workers. */
async function focus_or_open(scope: WorkerScope, url: string): Promise<void> {
	const target = new URL(url, scope.location.origin).href
	const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true })
	// ponytail: exact URL match only. A looser rule (same origin → focus and navigate) would
	// pull people off the page they were on, which is worse than a second tab.
	const showing = windows.find((client) => client.url === target)
	await (showing ? showing.focus() : scope.clients.openWindow(target))
}

/**
 * Re-subscribe after the browser rotated this subscription, and tell the server.
 *
 * Firefox hands over the replacement it already made; Chrome hands over nothing and expects
 * a fresh `subscribe()` — so take the one we're given and mint one otherwise. Re-subscribing
 * with the same key returns the existing subscription rather than failing, which covers the
 * browsers that do both.
 */
async function rotate(
	scope: WorkerScope,
	event: SubscriptionChangeEventLike,
	options: ReceiveOptions
): Promise<void> {
	if (!options.register) return

	let subscription = event.newSubscription ?? null
	if (!subscription) {
		const key = options.key ?? vapid_public_key
		if (!key) {
			// The one failure worth a word in the console: everything still looks fine here,
			// and the symptom is a subscriber who quietly stops receiving, months later.
			console.warn(
				"postboi: a push subscription rotated but there is no VAPID public key to re-subscribe with. Pass { key } to receive(), or run `bunx postboi sync` with VAPID_PUBLIC_KEY set."
			)
			return
		}
		subscription = await scope.registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: from_base64url(key) as BufferSource,
		})
	}

	const old_endpoint = event.oldSubscription?.endpoint
	await file(options.register, {
		...subscription_json(subscription),
		...(old_endpoint && { old_endpoint }),
	})
}
