/**
 * The subscribe-page state machine, written once. Every settings page that offers a
 * push toggle re-implements the same dance — `current()` on mount, busy/error state,
 * subscribe-then-register, the user-gesture rule — so it lives here instead.
 *
 * Framework-neutral on purpose: it owns the logic and publishes changes through the
 * store contract, and each ecosystem's wrapper owns the reactivity. `usePush`
 * (`postboi/react`), `use_push` (`postboi/vue`) and the reactive `subscription`
 * (`postboi/svelte`) are all a few lines around this file.
 *
 * Platform-neutral too: the machine only knows a {@link PushDriver} — is push here at
 * all, what's registered, subscribe, unsubscribe — and the browser (`client.ts`) and an
 * Expo app (`native.ts`) each supply their own. The choreography above is identical on a
 * phone, which is why it isn't written twice.
 */
import { subscribe, unsubscribe } from "./client.js"
import type { PushSubscriptionJSON } from "./client.js"
import { follow, unfollow, type DoorOptions } from "./door.js"
import { forget, remember } from "./memory.js"

/** The browser driver's own reasons — the walls `subscribe()` can hit. */
type BrowserReason = NonNullable<ReturnType<typeof subscribe.reason>>

/** Why an enable failed: `subscribe.reason`'s union, plus the register call failing. */
export type PushReason = BrowserReason | "register_failed"

/**
 * The machine's state, over whichever reasons its driver can produce — plus the one the
 * machine adds itself, the register call failing.
 */
export interface MachineState<TReason extends string> {
	/** Push exists on this device. Always false during SSR. */
	supported: boolean
	/** This device holds a registration. */
	on: boolean
	/** An enable or disable is in flight. */
	busy: boolean
	/** Why the last enable failed, or null. Dismissed permission prompts stay null. */
	reason: TReason | "register_failed" | null
}

/** The browser's state: Web Push's reasons over the shared machine. */
export type PushState = MachineState<BrowserReason>

/**
 * What a platform supplies to drive the machine. Every method is the platform's own
 * helper — `subscribe.current()`, `unsubscribe()` — so the machine can never disagree
 * with the plain calls about what's registered.
 */
export interface PushDriver<TRegistration, TReason extends string> {
	/** Is push available here at all? Synchronous, and never prompts. */
	supported(): boolean
	/** The registration this device already holds, or null. Never prompts. */
	current(): Promise<TRegistration | null>
	/** Prompt if needed and register. Throws something `reason` understands. */
	subscribe(): Promise<TRegistration>
	/** Drop the registration, handing back what was removed (null if nothing was). */
	unsubscribe(): Promise<TRegistration | null>
	/** Why a subscribe failed, or null if the error wasn't the driver's. */
	reason(error: unknown): TReason | null
	/** The JSON a `DELETE` to `unregister` carries — enough for the server to find the row. */
	identify(registration: TRegistration): Record<string, unknown>
	/**
	 * Hear about the platform replacing the registration underneath the app, while it
	 * runs. Returns the detach. Optional: the browser has no page-side event for it (the
	 * service worker hears `pushsubscriptionchange` instead); a phone does.
	 */
	rotations?(listener: (registration: TRegistration) => void): () => void
}

/** Where to file a registration: a URL, or a function for anything beyond a POST. */
export type Filing<TRegistration> = string | ((registration: TRegistration) => Promise<unknown>)

export interface SubscriptionOptions extends DoorOptions {
	/**
	 * VAPID public key — the same one the server signs with. Optional once
	 * `bunx postboi sync` has baked it; subscribe() resolves the default.
	 */
	key?: string
	/**
	 * Managed push: follow this public list, filed with Postboi straight from the page on
	 * the publishable key, with no server code at all. The list has to be public (its
	 * page in the dashboard, or `push_public` over the API) — anything tied to a person goes
	 * through your server with `register` instead.
	 */
	list?: string
	/**
	 * Where to file the subscription the browser mints: a URL it's POSTed to as JSON,
	 * or a function for anything beyond that. Without it the subscription is only held
	 * by the browser — the server can't push to what it never learned about.
	 */
	register?: Filing<PushSubscriptionJSON>
	/**
	 * How to unfile it on disable: a URL sent `DELETE` with `{ endpoint }` as JSON, or
	 * a function receiving the removed subscription.
	 */
	unregister?: Filing<PushSubscriptionJSON>
	/** Path to the service worker, when it isn't served at a conventional one —
	 * `subscribe()` finds `/sw.js` and SvelteKit's `/service-worker.js` on its own. */
	sw?: string
}

/** POST a registration to the server, or DELETE its identity from it. */
export async function file<TRegistration>(
	target: Filing<TRegistration>,
	registration: TRegistration,
	method: "POST" | "DELETE",
	identify: (registration: TRegistration) => unknown
): Promise<void> {
	if (typeof target === "function") {
		await target(registration)
		return
	}
	const response = await fetch(target, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(method === "POST" ? registration : identify(registration)),
	})
	if (!response.ok) throw new Error(`${method} ${target} answered ${response.status}`)
}

/**
 * The machine itself, over any driver. `subscription()` below is it with the browser
 * driver; `postboi/push/expo` builds it with the phone's.
 */
export function machine<TRegistration, TReason extends string>(
	driver: PushDriver<TRegistration, TReason>,
	options: { register?: Filing<TRegistration>; unregister?: Filing<TRegistration> } = {}
) {
	let state: MachineState<TReason> = { supported: false, on: false, busy: false, reason: null }
	const listeners = new Set<(state: MachineState<TReason>) => void>()
	let first_read: Promise<void> | null = null
	// Bumped whenever an enable or disable settles `on` for real, so a refresh() that
	// started before the change can't land its stale snapshot on top afterwards.
	let generation = 0
	let detach_rotations: (() => void) | null = null

	function set(patch: Partial<MachineState<TReason>>) {
		state = { ...state, ...patch }
		for (const listener of listeners) listener(state)
	}

	/** Re-read reality: is push supported here, and is this device registered? */
	async function refresh(): Promise<void> {
		if (!driver.supported()) return
		const seen = generation
		const on = Boolean(await driver.current())
		// An enable/disable that landed while we were reading owns `on` now — the answer
		// we got predates it.
		set(seen === generation ? { supported: true, on } : { supported: true })
	}

	/** The initial read, started at most once — by the first listener or first toggle. */
	function first_refresh(): Promise<void> {
		first_read ??= refresh()
		return first_read
	}

	/**
	 * A registration the platform swapped underneath a running app is re-filed where the
	 * first one went — the page-side twin of what the service worker does on
	 * `pushsubscriptionchange`. Only while something is listening: a detached machine
	 * shouldn't keep a native listener alive on its behalf.
	 */
	function watch_rotations() {
		if (!driver.rotations || !options.register || detach_rotations) return
		// Same rule as refresh(): no platform API is touched where push isn't supported —
		// a missing native module throws from the listener call itself.
		if (!driver.supported()) return
		const register = options.register
		detach_rotations = driver.rotations((registration) => {
			// A rotation can land while the first read is still in flight; wait for it,
			// so "not on yet" isn't mistaken for "not on".
			void first_refresh().then(() => {
				if (!state.on) return
				return file(register, registration, "POST", driver.identify).catch(() => {})
			})
		})
	}

	/** Prompt if needed, subscribe, and file the registration with the server. */
	async function enable(): Promise<void> {
		if (state.busy) return
		set({ busy: true, reason: null })
		try {
			const registration = await driver.subscribe()
			if (options.register) {
				try {
					await file(options.register, registration, "POST", driver.identify)
				} catch {
					// The server never learned the address, so the device shouldn't keep a
					// registration nothing will ever push to. The rollback failing too must
					// not eat the real story — the register call is what broke.
					await driver.unsubscribe().catch(() => {})
					generation += 1
					set({ busy: false, on: false, reason: "register_failed" })
					return
				}
			}
			generation += 1
			set({ busy: false, on: true })
		} catch (error) {
			// A dismissed prompt is a shrug, not an error — reason stays null for it.
			set({ busy: false, reason: driver.reason(error) })
		}
	}

	/** Unsubscribe this device and, when configured, unfile it from the server. */
	async function disable(): Promise<void> {
		if (state.busy) return
		set({ busy: true })
		try {
			const removed = await driver.unsubscribe()
			if (removed && options.unregister) {
				await file(options.unregister, removed, "DELETE", driver.identify).catch(() => {})
			}
			generation += 1
			set({ busy: false, on: false })
		} catch {
			// The unsubscribe itself failed, so the device still holds the registration.
			// `on` stays as it was; what matters is releasing `busy` — stuck true would
			// disable the toggle until a full reload.
			set({ busy: false })
		}
	}

	/**
	 * Flip it: subscribe if this device isn't, unsubscribe if it is. What a switch in a
	 * settings page actually wants, and safe to hand straight to a click handler —
	 * `onclick={push.toggle}` rather than a ternary that has to read the state itself.
	 * A click that beats the initial read waits for it, so an already-subscribed device
	 * gets the unsubscribe the user asked for, not a duplicate registration.
	 */
	async function toggle(): Promise<void> {
		if (state.busy) return
		await first_refresh()
		return state.on ? disable() : enable()
	}

	return {
		// The state's fields, readable straight off the machine — `push.on` from a click
		// handler or vanilla JS. Live values, but not reactive: a framework template
		// should read them through its wrapper (or the store contract below) instead.
		/** Push exists on this device. Always false during SSR. */
		get supported() {
			return state.supported
		},
		/** This device holds a registration. */
		get on() {
			return state.on
		},
		/** An enable or disable is in flight. */
		get busy() {
			return state.busy
		},
		/** Why the last enable failed, or null. Dismissed permission prompts stay null. */
		get reason() {
			return state.reason
		},
		/** Svelte store contract: called with the state now and on every change. */
		subscribe(listener: (state: MachineState<TReason>) => void): () => void {
			listeners.add(listener)
			listener(state)
			// The first listener ever gets the initial read; the first listener after a
			// quiet spell (the screen unmounted, so rotations went unheard) gets a fresh one.
			void (listeners.size === 1 && first_read ? refresh() : first_refresh())
			watch_rotations()
			return () => {
				listeners.delete(listener)
				if (listeners.size === 0 && detach_rotations) {
					detach_rotations()
					detach_rotations = null
				}
			}
		},
		/** The current state — for `useSyncExternalStore` and friends. */
		now: () => state,
		refresh,
		enable,
		disable,
		toggle,
	}
}

/**
 * This browser's push subscription as a state machine — supported, on, busy, why the
 * last attempt failed, and the calls that change it. Safe to construct anywhere,
 * including during SSR: no browser API is touched until something subscribes to the
 * state or calls {@link enable}.
 *
 * Svelte, React and Vue each have a wrapper that makes this reactive in their idiom —
 * reach for this one directly from vanilla JS, or from a framework we don't ship a
 * wrapper for. Call `toggle()`/`enable()` from a click: browsers auto-deny permission
 * prompts that aren't tied to a user gesture, and once denied they never ask again.
 *
 * With managed push, `register` is the route `push.handler` serves, or `list` follows a
 * public list with no route at all.
 *
 * @example
 * ```ts
 * import { subscription } from "postboi/push"
 *
 * const push = subscription({ register: "/push/subscriptions" })
 * push.subscribe((state) => button.replaceChildren(state.on ? "Unsubscribe" : "Subscribe"))
 * button.addEventListener("click", push.toggle)
 * ```
 */
export function subscription(options: SubscriptionOptions = {}) {
	const { list } = options
	const register: Filing<PushSubscriptionJSON> | undefined =
		options.register ?? (list ? (registration) => follow(registration, list, options) : undefined)
	const unregister: Filing<PushSubscriptionJSON> | undefined =
		options.unregister ??
		(list ? (registration) => unfollow(registration, list, options) : undefined)
	const identify = ({ endpoint }: PushSubscriptionJSON) => ({ endpoint })

	// Whatever files it, the endpoint is noted where the service worker can read it: some
	// browsers rotate a subscription without saying which one it replaced, and the old
	// endpoint is the only proof of ownership a rotation carries.
	async function file_and_remember(registration: PushSubscriptionJSON): Promise<void> {
		await file(register!, registration, "POST", identify)
		await remember({ endpoint: registration.endpoint, ...(list && { list }) })
	}
	async function forget_and_unfile(registration: PushSubscriptionJSON): Promise<void> {
		await forget()
		await file(unregister!, registration, "DELETE", identify)
	}

	return machine<PushSubscriptionJSON, BrowserReason>(
		{
			supported: subscribe.supported,
			current: subscribe.current,
			subscribe: () => subscribe({ key: options.key, sw: options.sw }),
			unsubscribe,
			reason: subscribe.reason,
			identify,
		},
		{
			register: register && file_and_remember,
			unregister: unregister && forget_and_unfile,
		}
	)
}

export type PushSubscriptionStore = ReturnType<typeof subscription>
