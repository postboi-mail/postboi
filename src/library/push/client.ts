/**
 * Browser-side Web Push helpers.
 *
 * The registration half of push — the bit the server can't do, because a subscription only
 * exists once the browser has made one. Deliberately small: the `PushManager` API isn't
 * hard, it's just fiddly in ways everyone gets slightly wrong (the key has to be raw bytes,
 * `userVisibleOnly` is mandatory in Chrome, and permission has to be requested from a user
 * gesture or it's auto-denied).
 *
 * Framework-agnostic and safe to import anywhere — `postboi/push` is the same import in
 * Svelte, React, Vue or no framework at all, and it touches no browser API until called.
 */
import { from_base64url } from "./crypto.js"
import { vapid_public_key } from "../register.js"

/** What `subscribe` hands back — post this to your server and store it. */
export interface PushSubscriptionJSON {
	endpoint: string
	keys: { p256dh: string; auth: string }
	expirationTime?: number | null
}

/** Options for {@link subscribe}. */
export interface SubscribeOptions {
	/**
	 * Your VAPID **public** key, base64url. Must match the private key the server signs
	 * with. Optional once `bunx postboi sync` has baked it from `VAPID_PUBLIC_KEY` —
	 * then `subscribe()` needs no options at all.
	 */
	key?: string
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
		| "missing_key"
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

/** Is Web Push available in this browser at all? Reached as `subscribe.supported()`. */
function supported(): boolean {
	return (
		typeof window !== "undefined" &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	)
}

/** The current notification permission, without prompting. Reached as `subscribe.permission()`. */
function permission(): NotificationPermission | "unsupported" {
	return supported() ? Notification.permission : "unsupported"
}

/**
 * The subscription this browser already has, or null. Reached as `subscribe.current()`.
 *
 * Permission alone doesn't answer "is this browser subscribed?" — granted-but-unsubscribed
 * is exactly what a browser looks like after someone turned notifications off again, and
 * it's the state every toggle in every settings page has to render. Without this, callers
 * reach past the helper into `navigator.serviceWorker.getRegistration()`, which is the
 * fiddly `PushManager` API this module exists to cover.
 *
 * Never prompts and never registers a worker: it reports, it doesn't arrange.
 */
async function current(): Promise<PushSubscriptionJSON | null> {
	const subscription = await existing()
	return subscription ? subscription_json(subscription) : null
}

/** This browser's live subscription object, if it has one — the lookup `current()
 * reports on and `unsubscribe()` acts on, so the two can't disagree about where a
 * subscription is found. */
async function existing(): Promise<PushSubscription | null> {
	if (!supported()) return null
	const registration = await navigator.serviceWorker.getRegistration()
	return (await registration?.pushManager.getSubscription()) ?? null
}

/**
 * Why a subscribe failed, or null if the error didn't come from here. Reached as
 * `subscribe.reason(error)` — the same shape as `push.expired(error)`, spread over the
 * several walls this call can hit rather than the one. The return is a union, so a
 * mistyped comparison is a type error instead of a branch that never runs.
 */
function reason(error: unknown): PushSubscribeError["reason"] | null {
	return error instanceof PushSubscribeError ? error.reason : null
}

/** Does an existing subscription's server key match the one we're subscribing with? */
function same_key(existing: ArrayBuffer | null, key: string): boolean {
	if (!existing) return false
	const a = new Uint8Array(existing)
	const b = vapid_key_to_bytes(key)
	return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * A live `PushSubscription` as the JSON you store — the shape `subscribe()` hands back.
 *
 * Exported so the service-worker helper re-files a rotated subscription in exactly the
 * shape the page filed the first one, rather than a second reading of `toJSON()` that
 * agrees until one of them is edited.
 */
export function subscription_json(subscription: PushSubscription): PushSubscriptionJSON {
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
 * `subscribe.supported()`, `subscribe.permission()` and `subscribe.current()` answer the
 * three questions a UI asks before it can render the button, none of which prompt.
 * `subscribe.reason(error)` answers the one it asks afterwards.
 *
 * @example
 * ```ts
 * import { subscribe } from "postboi/push"
 *
 * async function enable() {
 * 	const subscription = await subscribe({ key: VAPID_PUBLIC_KEY })
 * 	await fetch("/api/push/register", {
 * 		method: "POST",
 * 		headers: { "Content-Type": "application/json" },
 * 		body: JSON.stringify(subscription),
 * 	})
 * }
 * ```
 */
async function subscribe_now(options: SubscribeOptions = {}): Promise<PushSubscriptionJSON> {
	if (!supported()) {
		throw new PushSubscribeError("unsupported", "This browser does not support Web Push.")
	}

	// Explicit key, else the one `bunx postboi sync` baked from VAPID_PUBLIC_KEY.
	const key = options.key ?? vapid_public_key
	if (!key) {
		throw new PushSubscribeError(
			"missing_key",
			"No VAPID public key. Pass { key }, or run `bunx postboi sync` with VAPID_PUBLIC_KEY in your env to bake it in."
		)
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

	// Reuse an existing subscription only if it was created under *this* VAPID key. After
	// a key rotation the old subscription still exists but the server can no longer sign
	// for it — every send would be rejected with a VAPID mismatch — so it has to be
	// dropped and remade rather than handed back as if valid.
	const existing = await registration.pushManager.getSubscription()
	if (existing) {
		if (same_key(existing.options?.applicationServerKey ?? null, key)) {
			return subscription_json(existing)
		}
		await existing.unsubscribe()
	}

	try {
		const subscription = await registration.pushManager.subscribe({
			// Required by Chrome, and refusing anything else is the honest default: a push
			// the user never sees is exactly what the permission was granted to prevent.
			userVisibleOnly: true,
			applicationServerKey: vapid_key_to_bytes(key) as BufferSource,
		})
		return subscription_json(subscription)
	} catch (cause) {
		throw new PushSubscribeError(
			"failed",
			`Could not subscribe: ${cause instanceof Error ? cause.message : String(cause)}`
		)
	}
}

export const subscribe = Object.assign(subscribe_now, { supported, permission, current, reason })

/**
 * Unsubscribe this browser, returning the subscription that was removed so you can delete
 * your stored copy. Returns null when there was nothing subscribed.
 */
export async function unsubscribe(): Promise<PushSubscriptionJSON | null> {
	const subscription = await existing()
	if (!subscription) return null
	const json = subscription_json(subscription)
	await subscription.unsubscribe()
	return json
}

export {
	subscription,
	type PushSubscriptionStore,
	type PushReason,
	type PushState,
	type SubscriptionOptions,
} from "./controller.js"
