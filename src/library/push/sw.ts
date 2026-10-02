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
import { door, rotate as rotate_with_postboi, type DoorOptions } from "./door.js"
import { recall, remember } from "./memory.js"
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
export interface ReceiveOptions extends DoorOptions {
	/**
	 * VAPID **public** key, base64url, used to re-subscribe after a rotation — the string
	 * itself, or a function that resolves it, called only when a rotation actually needs
	 * one. The function form is for keys that only exist at runtime (a per-deployment pair
	 * in a Workers secret, handed out by the same endpoint the page subscribes off): a
	 * rotation can wake the worker cold, long after any startup fetch, so the moment the
	 * event fires is the one reliable chance to go and ask.
	 *
	 * ```ts
	 * receive({
	 * 	register: "/push/subscriptions",
	 * 	key: async () => {
	 * 		const res = await fetch("/push/key")
	 * 		return res.ok ? (await res.json()).key : null
	 * 	},
	 * })
	 * ```
	 *
	 * Optional once `bunx postboi sync` has baked it from `VAPID_PUBLIC_KEY` — the same key
	 * the page half resolves, so the two can't drift apart.
	 */
	key?: string | (() => string | null | undefined | Promise<string | null | undefined>)
	/**
	 * Where a rotated subscription gets re-filed: the URL it's POSTed to as
	 * {@link RotatedSubscription} JSON, or a function for anything beyond that. Normally the
	 * same endpoint the toggle's `register` posts to.
	 *
	 * With managed push (`bunx postboi sync` baked it) leave this out: a rotation goes to
	 * Postboi itself, which moves the old row's person and lists onto the new one.
	 * Without either, a rotation is noticed and then forgotten, which is what not having
	 * this handler at all already does.
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
	/**
	 * Take over what a click does. Called after the notification closes, with the
	 * notification's `data` — the payload's `data` plus `url`, or whatever `notification`
	 * overrode it to — and the action button pressed (`""` for the notification body).
	 * Replaces the default entirely: focus the tab already showing `data.url` exactly, or
	 * open one.
	 *
	 * The default is deliberately conservative — a looser rule would pull someone off the
	 * page they were on. When your app knows better (a single-window PWA that navigates its
	 * one open tab, an action button that answers without opening anything), this is where
	 * that lives; `clients` is a worker global, so reach for it directly.
	 *
	 * ```ts
	 * receive({
	 * 	click: async (data) => {
	 * 		const [tab] = await clients.matchAll({ type: "window", includeUncontrolled: true })
	 * 		if (!tab) return void clients.openWindow(data.url ?? "/")
	 * 		await tab.navigate?.(data.url ?? "/")
	 * 		await tab.focus()
	 * 	},
	 * })
	 * ```
	 */
	click?: (data: { url?: string } & Record<string, unknown>, action: string) => unknown
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
	notification: { close(): void; data?: ({ url?: string } & Record<string, unknown>) | null }
	action?: string
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
		// A `click` of your own replaces everything below it — the app knows what its
		// clicks mean; the close above is the one thing every handler owes the user.
		if (options.click) {
			event.waitUntil(
				Promise.resolve(options.click(event.notification.data ?? {}, event.action ?? ""))
			)
			return
		}
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
	// Your own route when you named one; Postboi's door when this build is managed; and
	// nowhere otherwise.
	const managed = !options.register && door(options) !== null
	if (!options.register && !managed) return

	let subscription = event.newSubscription ?? null
	if (!subscription) {
		// A function key resolves here — when the rotation fires — because a worker woken
		// cold by this event has had no earlier moment to fetch a runtime key in.
		const configured = typeof options.key === "function" ? await options.key() : options.key
		const key = configured ?? vapid_public_key
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

	// The browser names the subscription it replaced, or doesn't — then the one the page
	// last filed (memory.ts) stands in, because without it the new subscription can't claim
	// the old one's row and the person it belonged to stops hearing anything.
	const filed = await recall()
	const json = subscription_json(subscription)
	const replaced = event.oldSubscription?.endpoint ?? filed?.endpoint
	const old_endpoint = replaced !== json.endpoint ? replaced : undefined
	if (managed) {
		await rotate_with_postboi(json, old_endpoint, filed?.list, options)
		return
	}
	await file(options.register!, { ...json, ...(old_endpoint && { old_endpoint }) })
	await remember({ endpoint: json.endpoint, ...(filed?.list && { list: filed.list }) })
}
