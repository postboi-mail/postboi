/**
 * The server half of managed push that isn't a send: `push.subscriptions` (the rows
 * Postboi holds) and `push.handler` (those rows behind a route, so the whole of a signed-in
 * app's setup is one line naming the signed-in user).
 *
 * Both load the Postboi push provider lazily, so `push()` with Web Push or FCM never pulls
 * it in.
 */
import type { WebPushSubscription } from "./types.js"
import type { FileOptions, ManagedSubscription } from "./postboi.js"
import { ensure_env_loaded } from "../env.js"

async function managed() {
	await ensure_env_loaded()
	const { default: PostboiPush } = await import("./postboi.js")
	return new PostboiPush()
}

/**
 * The subscriptions Postboi holds for this account, on `POSTBOI_TOKEN`. Most apps never
 * call these: `push.handler` is them behind a route. They are here for frameworks whose
 * handlers aren't `Request`-shaped (Express), and for scripts.
 *
 * @example
 * ```ts
 * import { push } from "postboi"
 *
 * // An Express route, which push.handler can't wrap
 * app.post("/push", async (req, res) => {
 * 	await push.subscriptions.add(req.body, { user: req.user.id })
 * 	res.sendStatus(201)
 * })
 * ```
 */
export const subscriptions = {
	/** File a browser under a person and/or lists. Filing it again re-points it. */
	async add(subscription: WebPushSubscription, options: FileOptions = {}) {
		return (await managed()).subscriptions.add(subscription, options)
	},
	/** Forget a browser by its endpoint; with `user`, only when it is that person's. */
	async remove(endpoint: string, options: { user?: string | number } = {}) {
		return (await managed()).subscriptions.remove(endpoint, options)
	},
	/** A page of live browsers, one person's or one list's. */
	async list(
		options: { user?: string | number; list?: string; cursor?: string; limit?: number } = {}
	): Promise<{ subscriptions: Array<ManagedSubscription>; cursor: string | null }> {
		return (await managed()).subscriptions.list(options)
	},
	/** Move an existing table across, up to 1000 rows a call. Import the key pair first. */
	async import(rows: Array<{ subscription: WebPushSubscription } & FileOptions>) {
		return (await managed()).subscriptions.import(rows)
	},
}

/** Who the request is from, as the app knows them: an id, or nothing when signed out. */
export type Who<TEvent> = (
	event: TEvent
) => string | number | null | undefined | Promise<string | number | null | undefined>

/**
 * The `Request` inside whatever a framework hands a route handler: the argument itself
 * (Next route handlers, Workers, Bun), its `.request` (SvelteKit, Astro, Remix), or Hono's
 * `c.req.raw`.
 */
function request_of(event: unknown): Request {
	if (event instanceof Request) return event
	const candidate = event as { request?: unknown; req?: { raw?: unknown } } | null
	if (candidate?.request instanceof Request) return candidate.request
	if (candidate?.req?.raw instanceof Request) return candidate.req.raw
	throw new TypeError(
		"push.handler couldn't find a Request in what the route was called with. Use push.subscriptions.add and .remove from this framework's handler instead."
	)
}

function answer(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	})
}

/** What a failed call to Postboi becomes: its status and message, never a stack trace. */
function failed(error: unknown): Response {
	const status = (error as { status?: number }).status
	const message = error instanceof Error ? error.message : "Push registration failed."
	return answer(status && status >= 400 && status < 600 ? status : 502, { message })
}

/**
 * `POST` and `DELETE` route handlers for the page's push toggle, filing the browser under
 * whoever `who` says is signed in.
 *
 * `POST` takes the subscription the page sends and files it under `who`'s answer; `DELETE`
 * takes `{ endpoint }` and unfiles it, only if it is that same person's. When `who` answers
 * `null` or `undefined` the request is a 401, which the toggle treats as `register_failed`
 * and rolls the browser's subscription back — a signed-out visitor is never left subscribed
 * to something nothing can push to.
 *
 * Binding a browser to a person has to happen on your server: only your backend knows who
 * is signed in. A page subscribing to a public list needs no route at all
 * (`subscription({ list })`).
 *
 * @example
 * ```ts
 * // src/routes/push/+server.ts
 * import { push } from "postboi"
 *
 * export const { POST, DELETE } = push.handler((event) => event.locals.user?.id)
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each framework's event is its own
export function handler<TEvent = any>(who: Who<TEvent>) {
	async function identify(event: TEvent): Promise<string | Response> {
		const user = await who(event)
		if (user === null || user === undefined || user === "") {
			return answer(401, { message: "Sign in to turn on notifications." })
		}
		return String(user)
	}

	return {
		async POST(event: TEvent): Promise<Response> {
			const user = await identify(event)
			if (user instanceof Response) return user
			const body = (await request_of(event)
				.json()
				.catch(() => undefined)) as WebPushSubscription | undefined
			if (!body?.endpoint) {
				return answer(400, { message: "Send the subscription subscribe() returned." })
			}
			try {
				await subscriptions.add(body, { user })
			} catch (error) {
				return failed(error)
			}
			return answer(201, { ok: true })
		},

		async DELETE(event: TEvent): Promise<Response> {
			const user = await identify(event)
			if (user instanceof Response) return user
			const body = (await request_of(event)
				.json()
				.catch(() => undefined)) as { endpoint?: unknown } | undefined
			if (typeof body?.endpoint !== "string" || !body.endpoint) {
				return answer(400, { message: "Send the endpoint to remove." })
			}
			try {
				await subscriptions.remove(body.endpoint, { user })
			} catch (error) {
				// Already gone is what the person asked for.
				if ((error as { status?: number }).status !== 404) return failed(error)
			}
			return answer(200, { ok: true })
		},
	}
}
