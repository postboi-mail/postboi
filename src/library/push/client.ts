/**
 * Browser-side Web Push helpers.
 *
 * The registration half of push — the bit the server can't do, because a subscription only
 * exists once the browser has made one. Deliberately small: the `PushManager` API isn't
 * hard, it's just fiddly in ways everyone gets slightly wrong (the key has to be raw bytes,
 * `userVisibleOnly` is mandatory in Chrome, and permission has to be requested from a user
 * gesture or it's auto-denied).
 *
 * Framework-agnostic and safe to import anywhere — it touches no browser API until called.
 * Import from `postboi/push-client` directly (Svelte and everything else), or via the
 * `postboi/react` / `postboi/vue` adapters which re-export it.
 */
import { from_base64url } from "./crypto.js"

/** What `subscribe_push` hands back — post this to your server and store it. */
export interface PushSubscriptionJSON {
	endpoint: string
	keys: { p256dh: string; auth: string }
	expirationTime?: number | null
}

/** Options for {@link subscribe_push}. */
export interface SubscribeOptions {
	/** Your VAPID **public** key, base64url. Must match the private key the server signs with. */
	key: string
	/**
	 * Path to your service worker. Defaults to `/sw.js`. Ignored when one is already
	 * registered for the scope.
	 */
	service_worker?: string
}

/** Thrown when a subscription can't be created, with `reason` saying which wall was hit. */
export class PushSubscribeError extends Error {
	readonly reason:
		| "unsupported"
		| "permission_denied"
		| "permission_dismissed"
		| "no_service_worker"
		| "failed"

	constructor(reason: PushSubscribeError["reason"], message: string) {
		super(message)
		this.name = "PushSubscribeError"
		this.reason = reason
	}
}

/**
 * Convert a base64url VAPID key into the `Uint8Array` `pushManager.subscribe` requires.
 * Delegates to the same decoder the server-side crypto uses, so the two sides can never
 * disagree about how a key string decodes.
 */
export function vapid_key_to_bytes(key: string): Uint8Array {
	return from_base64url(key)
}

/** Is Web Push available in this browser at all? */
export function push_supported(): boolean {
	return (
		typeof window !== "undefined" &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	)
}

/** The current notification permission, without prompting. */
export function push_permission(): NotificationPermission | "unsupported" {
	return push_supported() ? Notification.permission : "unsupported"
}

function to_json(subscription: PushSubscription): PushSubscriptionJSON {
	const json = subscription.toJSON() as {
		endpoint?: string
		expirationTime?: number | null
		keys?: { p256dh?: string; auth?: string }
	}
	if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
		throw new PushSubscribeError("failed", "The browser returned an incomplete subscription.")
	}
	return {
		endpoint: json.endpoint,
		expirationTime: json.expirationTime ?? null,
		keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
	}
}

/**
 * Request permission if needed, register the service worker, and subscribe.
 *
 * Returns a subscription you should POST to your own endpoint and store — it *is* the
 * address, and there's no way to recover it later. Reuses an existing subscription when
 * there is one, so calling this on every page load is safe.
 *
 * **Call it from a click or similar.** Browsers auto-deny a permission prompt that isn't
 * tied to a user gesture, and once denied you cannot ask again.
 *
 * @example
 * ```ts
 * import { subscribe_push } from "postboi/react"
 *
 * async function enable() {
 * 	const subscription = await subscribe_push({ key: VAPID_PUBLIC_KEY })
 * 	await fetch("/api/push/register", {
 * 		method: "POST",
 * 		headers: { "Content-Type": "application/json" },
 * 		body: JSON.stringify(subscription),
 * 	})
 * }
 * ```
 */
export async function subscribe_push(options: SubscribeOptions): Promise<PushSubscriptionJSON> {
	if (!push_supported()) {
		throw new PushSubscribeError("unsupported", "This browser does not support Web Push.")
	}

	if (Notification.permission !== "granted") {
		const permission = await Notification.requestPermission()
		if (permission === "denied") {
			throw new PushSubscribeError(
				"permission_denied",
				"Notification permission was denied. The browser will not ask again — the user has to change it in site settings."
			)
		}
		if (permission !== "granted") {
			throw new PushSubscribeError(
				"permission_dismissed",
				"The permission prompt was dismissed without an answer. You can ask again later."
			)
		}
	}

	let registration: ServiceWorkerRegistration
	try {
		registration =
			(await navigator.serviceWorker.getRegistration()) ??
			(await navigator.serviceWorker.register(options.service_worker ?? "/sw.js"))
		// `ready` rather than the registration itself: a worker that is installing has no
		// active pushManager yet, and subscribing against it fails intermittently.
		registration = await navigator.serviceWorker.ready
	} catch (cause) {
		throw new PushSubscribeError(
			"no_service_worker",
			`Could not register a service worker at ${options.service_worker ?? "/sw.js"}: ${
				cause instanceof Error ? cause.message : String(cause)
			}`
		)
	}

	const existing = await registration.pushManager.getSubscription()
	if (existing) return to_json(existing)

	try {
		const subscription = await registration.pushManager.subscribe({
			// Required by Chrome, and refusing anything else is the honest default: a push
			// the user never sees is exactly what the permission was granted to prevent.
			userVisibleOnly: true,
			applicationServerKey: vapid_key_to_bytes(options.key) as BufferSource,
		})
		return to_json(subscription)
	} catch (cause) {
		throw new PushSubscribeError(
			"failed",
			`Could not subscribe: ${cause instanceof Error ? cause.message : String(cause)}`
		)
	}
}

/**
 * Unsubscribe this browser, returning the subscription that was removed so you can delete
 * your stored copy. Returns null when there was nothing subscribed.
 */
export async function unsubscribe_push(): Promise<PushSubscriptionJSON | null> {
	if (!push_supported()) return null
	const registration = await navigator.serviceWorker.getRegistration()
	const subscription = await registration?.pushManager.getSubscription()
	if (!subscription) return null
	const json = to_json(subscription)
	await subscription.unsubscribe()
	return json
}
