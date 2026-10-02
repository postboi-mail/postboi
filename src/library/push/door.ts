/**
 * Managed push's browser door: where a page or a service worker files a subscription with
 * Postboi directly, on the account's publishable key (`pk_…`) rather than an API key.
 *
 * Two things go through it and nothing else, which the API enforces: following a public
 * list, and re-filing a subscription the browser rotated (proved by presenting the endpoint
 * it replaced). Binding a browser to a person needs your server, because only it knows who
 * is signed in — that is `push.handler`.
 *
 * The key and the API are baked by `bunx postboi sync` when `POSTBOI_PUSH_PROVIDER=postboi`,
 * so neither needs passing; both can be, for a build that ran without a token.
 */
import { captcha_key, managed_push } from "../register.js"
import type { PushSubscriptionJSON } from "./client.js"
import { remember } from "./memory.js"

/** Overrides for what `bunx postboi sync` bakes. */
export interface DoorOptions {
	/** The account's publishable key, `pk_…`. Baked by sync. */
	publishable_key?: string
	/** The Postboi API origin. Baked by sync; `https://postboi.app` otherwise. */
	api?: string
}

/** Where the door is, or null when this build isn't set up for managed push. */
export function door(options: DoorOptions = {}): { url: string; key: string } | null {
	const key = options.publishable_key ?? captcha_key
	const api = options.api ?? managed_push?.api
	if (!key || (!api && !options.publishable_key)) return null
	return { url: `${(api ?? "https://postboi.app").replace(/\/$/, "")}/v1/push/browser`, key }
}

/** The door, or an error that says what's missing — for the calls that can't go without it. */
function required(options: DoorOptions): { url: string; key: string } {
	const found = door(options)
	if (!found) {
		throw new Error(
			"Managed push isn't baked into this build. Run `bunx postboi sync` with POSTBOI_PUSH_PROVIDER=postboi and POSTBOI_TOKEN set, or pass { publishable_key }."
		)
	}
	return found
}

async function call(
	method: "POST" | "DELETE",
	where: { url: string; key: string },
	body: Record<string, unknown>
): Promise<void> {
	const response = await fetch(where.url, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: where.key, ...body }),
	})
	if (!response.ok) throw new Error(`${method} ${where.url} answered ${response.status}`)
}

/**
 * Follow a public list: file this browser's subscription with Postboi under `list`. Throws
 * when the list isn't public, which the toggle reads as `register_failed` and undoes.
 */
export async function follow(
	subscription: PushSubscriptionJSON,
	list: string,
	options: DoorOptions = {}
): Promise<void> {
	await call("POST", required(options), { ...subscription, list })
}

/** Stop following a public list. */
export async function unfollow(
	subscription: PushSubscriptionJSON,
	list: string,
	options: DoorOptions = {}
): Promise<void> {
	await call("DELETE", required(options), { endpoint: subscription.endpoint, list })
}

/**
 * Re-file a rotated subscription, from the service worker. The replacement inherits the
 * old row's person and lists on Postboi's side; `list` is the fallback for when there is
 * no old row to inherit from (none presented, or its tombstone already purged), so a public
 * list's follower isn't lost with it. A list its owner has since closed is dropped by the
 * door rather than refusing the rotation.
 */
export async function rotate(
	subscription: PushSubscriptionJSON,
	old_endpoint: string | undefined,
	list: string | undefined,
	options: DoorOptions = {}
): Promise<void> {
	await call("POST", required(options), {
		...subscription,
		...(old_endpoint && { old_endpoint }),
		...(list && { list }),
	})
	await remember({ endpoint: subscription.endpoint, ...(list && { list }) })
}
