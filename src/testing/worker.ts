/**
 * A fake service worker, for the two implementations of postboi's push handlers.
 *
 * There are two on purpose — `receive()` from `postboi/push/sw` for workers a bundler
 * builds, and the copy `bunx postboi init --push` writes out for the frameworks that serve
 * their worker verbatim. Two implementations of one behaviour is exactly the arrangement
 * that drifts, so both are driven through this and their recordings compared.
 *
 * No service-worker runtime and no vitest: the handlers are only ever felt through
 * `showNotification`, the `clients` list and the register call, and an object that records
 * those three proves the same thing a browser would. Vitest-free so the same fake can be
 * handed to `receive()` as globals *and* to generated source as its `self`.
 */

/** The origin the fake worker is served from — relative notification URLs resolve against it. */
export const ORIGIN = "https://app.example"

export interface FakeWindow {
	url: string
	focused: boolean
}

export interface FakeWorker {
	/** The worker globals: stub these onto `globalThis`, or pass as `self`. */
	scope: Record<string, unknown>
	/** The `fetch` the register call goes through. */
	fetch: (url: string, init: { method?: string; body: string }) => Promise<{ ok: boolean }>
	/** Dispatch an event and await whatever the handler passed to `waitUntil`. */
	fire: (type: string, event: Record<string, unknown>) => Promise<void>
	/** `[title, options]` for every notification shown. */
	shown: Array<[string, unknown]>
	/** URLs `openWindow` was called with. */
	opened: Array<string>
	/** URLs of the already-open tabs that were focused instead. */
	focused: Array<string>
	/** `[url, body]` for every register call. */
	posted: Array<[string, unknown]>
	/** The options every `pushManager.subscribe` was called with. */
	subscribed: Array<unknown>
	/** Everything the handlers did, in one object — what a parity check compares. */
	record: () => {
		shown: Array<[string, unknown]>
		opened: Array<string>
		focused: Array<string>
		posted: Array<[string, unknown]>
	}
}

export function fake_worker({
	windows = [] as ReadonlyArray<string>,
	subscription = null as unknown,
}: { windows?: ReadonlyArray<string>; subscription?: unknown } = {}): FakeWorker {
	const handlers: Record<string, (event: unknown) => void> = {}
	const shown: Array<[string, unknown]> = []
	const opened: Array<string> = []
	const focused: Array<string> = []
	const posted: Array<[string, unknown]> = []
	const subscribed: Array<unknown> = []

	const scope = {
		addEventListener(type: string, handler: (event: unknown) => void) {
			handlers[type] = handler
		},
		location: { origin: ORIGIN },
		registration: {
			async showNotification(title: string, options: unknown) {
				shown.push([title, options])
			},
			pushManager: {
				async subscribe(options: unknown) {
					subscribed.push(options)
					return subscription
				},
			},
		},
		clients: {
			async matchAll() {
				return windows.map((url) => ({
					url,
					async focus() {
						focused.push(url)
					},
				}))
			},
			async openWindow(url: string) {
				opened.push(url)
			},
		},
	}

	const fetch = async (url: string, init: { method?: string; body: string }) => {
		posted.push([url, JSON.parse(init.body)])
		return { ok: true }
	}

	async function fire(type: string, event: Record<string, unknown>): Promise<void> {
		let waited: Promise<unknown> = Promise.resolve()
		handlers[type]?.({ ...event, waitUntil: (promise: Promise<unknown>) => (waited = promise) })
		await waited
	}

	return {
		scope,
		fetch,
		fire,
		shown,
		opened,
		focused,
		posted,
		subscribed,
		record: () => ({ shown, opened, focused, posted }),
	}
}

/** A base64url VAPID public key that decodes — a real P-256 point. */
export const VAPID_KEY =
	"BMOvqNa2X4FY7RtGBfHn0Lpg1II-PafsAq1IdktdxwU3y9sKm2YyP_r9kt-B11odlAj62DeC3v5qYUFTbMrLiA4"

/** The stored shape of a subscription, and a fake that hands it back. */
export const STORED = {
	endpoint: "https://push.example/new",
	expirationTime: null,
	keys: { p256dh: "a-public-key", auth: "an-auth-secret" },
}

export const fake_subscription = () => ({ endpoint: STORED.endpoint, toJSON: () => STORED })
