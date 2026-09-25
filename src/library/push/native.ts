/**
 * Push registration for Expo and React Native apps — `postboi/push/expo`.
 *
 * The phone's twin of `postboi/push`: the same `subscribe()` / `unsubscribe()` /
 * `subscription()` surface, over `expo-notifications` instead of `PushManager`. Same
 * reasons for the same walls, and the same state machine underneath, so a settings
 * screen shared between the web app and the phone app reads the same either side.
 *
 * What it hands back is an Expo push token by default — the `ExponentPushToken[…]` that
 * `postboi/expo` sends to, with Expo holding the FCM and APNs credentials — or, with
 * `native: true`, the raw device token for `postboi/fcm` and `postboi/apns`. Either way
 * the registration says which provider it belongs to, because a token from one is
 * meaningless to the others.
 *
 * One thing the browser has that a phone doesn't: a memory of being subscribed. The
 * `PushManager` holds the subscription, so `current()` can simply ask it. The OS holds
 * only *permission* — granted by default on Android 12 and below, and left granted after
 * someone turns push off inside the app — so "is this device registered?" has to be
 * remembered here, and that's what `storage` is for. The registration itself is what's
 * kept, so `current()` answers without a network round-trip.
 *
 * `expo-notifications` and `expo-constants` are optional peers: this module is only ever
 * imported inside an Expo app, where both already are.
 */
import * as Notifications from "expo-notifications"
import Constants from "expo-constants"
import { useState, useSyncExternalStore } from "react"
import { machine, type Filing, type MachineState } from "./controller.js"

/** What `subscribe` hands back — POST it to your server and store it. */
export interface PushRegistration {
	/** The token to store and send to: `ExponentPushToken[…]`, or the raw device token with `native: true`. */
	token: string
	/** Which server provider it belongs to — `postboi/expo`, `postboi/fcm` or `postboi/apns`. */
	provider: "expo" | "fcm" | "apns"
	/** Which kind of phone. */
	platform: "ios" | "android"
}

/**
 * Where this device's registration is remembered between launches — the shape of
 * `@react-native-async-storage/async-storage`, which any key-value store adapts to in
 * three lines. Without one it's remembered for this launch only, so a toggle comes up
 * off after a restart until the next `subscribe()`.
 */
export interface PushStorage {
	getItem(key: string): Promise<string | null> | string | null
	setItem(key: string, value: string): Promise<void> | void
	removeItem(key: string): Promise<void> | void
}

/** Options for {@link subscribe}. */
export interface SubscribeOptions {
	/**
	 * Register the raw FCM or APNs device token instead of an Expo push token, for a
	 * server that sends through `postboi/fcm` and `postboi/apns` itself. Default false:
	 * an Expo token, for `postboi/expo`.
	 */
	native?: boolean
	/**
	 * The EAS project id an Expo push token is minted for. Read from `app.json`
	 * (`extra.eas.projectId`, which `eas init` writes) when not passed.
	 */
	project_id?: string
	/** Where the registration is remembered across launches. See {@link PushStorage}. */
	storage?: PushStorage
}

/** Thrown when a registration can't be made, with `reason` saying which wall was hit. */
export class PushSubscribeError extends Error {
	readonly reason:
		| "unsupported"
		| "permission_denied"
		| "permission_dismissed"
		| "missing_project"
		| "failed"

	constructor(reason: PushSubscribeError["reason"], message: string) {
		super(message)
		this.name = "PushSubscribeError"
		this.reason = reason
	}
}

/** The storage key the registration is kept under. */
const KEY = "postboi:push"

/** The memory when no storage was given: this launch only. */
const memory = new Map<string, string>()
const memory_storage: PushStorage = {
	getItem: (key) => memory.get(key) ?? null,
	setItem: (key, value) => void memory.set(key, value),
	removeItem: (key) => void memory.delete(key),
}

function storage_of(options: SubscribeOptions): PushStorage {
	return options.storage ?? memory_storage
}

/** The registration remembered for this device, or null. */
async function stored(options: SubscribeOptions): Promise<PushRegistration | null> {
	const raw = await storage_of(options).getItem(KEY)
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as Partial<PushRegistration> | null
		return parsed && typeof parsed.token === "string" && parsed.provider && parsed.platform
			? (parsed as PushRegistration)
			: null
	} catch {
		return null
	}
}

async function remember(
	options: SubscribeOptions,
	registration: PushRegistration | null
): Promise<void> {
	const storage = storage_of(options)
	if (registration) await storage.setItem(KEY, JSON.stringify(registration))
	else await storage.removeItem(KEY)
}

/**
 * Is push available here at all? Reached as `subscribe.supported()`.
 *
 * Not on the web build of an Expo app — that's a browser, and `postboi/push` is its
 * helper — and not in Expo Go on Android, which lost remote push in SDK 53: a
 * development build is the way to test there. Simulators are fine now (iOS since Xcode
 * 14 on macOS 13, Android emulators with Play services), so there's no device check.
 */
function supported(): boolean {
	const platform = Constants.platform
	if (!platform || platform.web) return false
	if (Constants.executionEnvironment === "storeClient" && platform.android) return false
	return Boolean(platform.ios || platform.android)
}

/**
 * Read Expo's permission answer as one word — provisional counts as granted, and a
 * prompt backed out of on Android (which reports `denied` but can ask again) as
 * undetermined, because it can be asked again and "go to Settings" would be wrong.
 */
function read_permission(
	status: Notifications.NotificationPermissionsStatus
): "granted" | "denied" | "undetermined" {
	if (status.granted || status.status === "granted") return "granted"
	const ios = status.ios?.status
	if (
		ios === Notifications.IosAuthorizationStatus.PROVISIONAL ||
		ios === Notifications.IosAuthorizationStatus.EPHEMERAL
	)
		return "granted"
	return status.status === "denied" && !status.canAskAgain ? "denied" : "undetermined"
}

/** The current notification permission, without prompting. Reached as `subscribe.permission()`. */
async function permission(): Promise<"granted" | "denied" | "undetermined" | "unsupported"> {
	if (!supported()) return "unsupported"
	return read_permission(await Notifications.getPermissionsAsync())
}

function platform_of(): "ios" | "android" {
	return Constants.platform?.ios ? "ios" : "android"
}

/** The EAS project an Expo push token is minted for: passed, else what `eas init` wrote. */
function project_id_of(options: SubscribeOptions): string | undefined {
	return (
		options.project_id ??
		Constants.expoConfig?.extra?.eas?.projectId ??
		Constants.easConfig?.projectId
	)
}

/**
 * The device token the last mint fetched. Both platforms fire `addPushTokenListener` for
 * every `getDevicePushTokenAsync`, this module's own included, so this is how the
 * rotation listener tells the echo of its own fetch from a token the OS actually rolled.
 */
let last_device_token: string | null = null

/** Mint the token this app registers with — no prompt, and the same answer every time. */
async function mint(options: SubscribeOptions): Promise<PushRegistration> {
	let expo_project: string | undefined
	if (!options.native) {
		expo_project = project_id_of(options)
		if (!expo_project) {
			throw new PushSubscribeError(
				"missing_project",
				"No EAS project id. An Expo push token is minted for a project. Run `eas init` (it writes extra.eas.projectId to app.json), or pass { project_id }."
			)
		}
	}
	// Fetched here rather than left to getExpoPushTokenAsync, so the token the platform
	// echoes back through the listener is one this module knows it asked for.
	const device = await Notifications.getDevicePushTokenAsync()
	last_device_token = device.data
	const platform = platform_of()
	if (!expo_project) {
		return { token: device.data, provider: platform === "ios" ? "apns" : "fcm", platform }
	}
	const token = await Notifications.getExpoPushTokenAsync({
		projectId: expo_project,
		devicePushToken: device,
	})
	return { token: token.data, provider: "expo", platform }
}

/**
 * The registration this device holds, or null. Reached as `subscribe.current()`.
 *
 * What was remembered at the last `subscribe()`, provided the OS still grants
 * permission — revoked in Settings, the device is unreachable whatever was remembered.
 * Never prompts, and never touches the network: the registration is kept, not re-minted.
 */
async function current(options: SubscribeOptions = {}): Promise<PushRegistration | null> {
	if (!supported()) return null
	const registration = await stored(options)
	if (!registration) return null
	return read_permission(await Notifications.getPermissionsAsync()) === "granted"
		? registration
		: null
}

/** Why a subscribe failed, or null if the error didn't come from here. Reached as `subscribe.reason(error)`. */
function reason(error: unknown): PushSubscribeError["reason"] | null {
	return error instanceof PushSubscribeError ? error.reason : null
}

/**
 * Request permission if needed and register, handing back the token to POST to your
 * server, and remembering it so `current()` can answer. Call it when the user says yes —
 * or on every launch, in an app that always pushes and has no switch to respect.
 *
 * On Android the `default` notification channel is created first, at full importance:
 * without one, Android 13+ shows no permission prompt at all, and it's the channel Expo
 * delivers to when a send names none.
 *
 * `subscribe.supported()`, `subscribe.permission()` and `subscribe.current()` answer the
 * three questions a settings screen asks before it can render the switch; none prompt.
 * `subscribe.reason(error)` answers the one it asks afterwards.
 *
 * @example
 * ```ts
 * import { subscribe } from "postboi/push/expo"
 *
 * const registration = await subscribe({ storage: AsyncStorage })
 * await fetch("https://example.com/api/push/register", {
 * 	method: "POST",
 * 	headers: { "Content-Type": "application/json" },
 * 	body: JSON.stringify(registration), // { token, provider: "expo", platform }
 * })
 * ```
 */
async function subscribe_now(options: SubscribeOptions = {}): Promise<PushRegistration> {
	if (!supported()) {
		throw new PushSubscribeError(
			"unsupported",
			Constants.platform?.web
				? "This is the web build. Use subscribe() from postboi/push there."
				: "Push isn't available here. Expo Go on Android has no remote push since SDK 53; use a development build."
		)
	}

	// Before the prompt, on purpose — see above. Idempotent, and a no-op on iOS.
	await Notifications.setNotificationChannelAsync("default", {
		name: "Default",
		importance: Notifications.AndroidImportance.MAX,
	}).catch(() => {})

	let status = read_permission(await Notifications.getPermissionsAsync())
	if (status !== "granted") {
		status = read_permission(await Notifications.requestPermissionsAsync())
		if (status === "denied") {
			throw new PushSubscribeError(
				"permission_denied",
				"Notification permission was denied. The OS will not ask again, so the user has to change it in Settings."
			)
		}
		if (status !== "granted") {
			throw new PushSubscribeError(
				"permission_dismissed",
				"The permission prompt was dismissed without an answer. You can ask again later."
			)
		}
	}

	let registration: PushRegistration
	try {
		registration = await mint(options)
	} catch (cause) {
		if (cause instanceof PushSubscribeError) throw cause
		throw new PushSubscribeError(
			"failed",
			`Could not get a push token: ${cause instanceof Error ? cause.message : String(cause)}`
		)
	}
	await remember(options, registration)
	return registration
}

export const subscribe = Object.assign(subscribe_now, { supported, permission, current, reason })

/**
 * Unregister this device, returning the registration that was removed so you can delete
 * your stored copy. Returns null when there was nothing registered. Forgets the
 * registration, so `current()` says null until the next `subscribe()` — and does so
 * whatever the network is doing, or an off that didn't stick would be back on next launch
 * with the server still holding the token.
 */
export async function unsubscribe(
	options: SubscribeOptions = {}
): Promise<PushRegistration | null> {
	const registration = await stored(options)
	if (!registration) return null
	await Notifications.unregisterForNotificationsAsync().catch(() => {})
	await remember(options, null)
	return registration
}

/** Options for {@link subscription}: how to register, plus everything `subscribe` takes. */
export interface SubscriptionOptions extends SubscribeOptions {
	/**
	 * Where to file the registration: an absolute URL it's POSTed to as JSON — a phone
	 * has no origin for a relative one — or a function for anything beyond that.
	 * Without it the token is only held by the phone, and the server can't push to what
	 * it never learned about.
	 */
	register?: Filing<PushRegistration>
	/**
	 * How to unfile it on disable: a URL sent `DELETE` with `{ token }` as JSON, or a
	 * function receiving the removed registration.
	 */
	unregister?: Filing<PushRegistration>
}

/** The toggle's state on a phone. */
export type PushState = MachineState<PushSubscribeError["reason"]>

/** Why an enable failed: `subscribe.reason`'s union, plus the register call failing. */
export type PushReason = NonNullable<PushState["reason"]>

/**
 * A relative URL is fine in a browser and a `TypeError` from React Native's `fetch`,
 * which the machine would report as a bare `register_failed`. Say so up front instead.
 */
function absolute(name: string, target: Filing<PushRegistration> | undefined): void {
	if (typeof target === "string" && !/^https?:\/\//i.test(target)) {
		throw new Error(
			`\`${name}\` must be an absolute URL on a phone. There is no origin to resolve ${JSON.stringify(target)} against.`
		)
	}
}

/**
 * This device's push registration as a state machine — the same one `postboi/push`
 * builds for the browser, so `on`, `busy`, `reason`, `toggle()` and the rest mean the
 * same thing on both. Re-files the token when the OS rotates it underneath a running
 * app, while something is listening.
 *
 * @example
 * ```ts
 * import { subscription } from "postboi/push/expo"
 * import AsyncStorage from "@react-native-async-storage/async-storage"
 *
 * const push = subscription({
 * 	register: "https://example.com/push/registrations",
 * 	storage: AsyncStorage,
 * })
 * push.subscribe((state) => render(state.on))
 * ```
 */
export function subscription(options: SubscriptionOptions = {}) {
	absolute("register", options.register)
	absolute("unregister", options.unregister)
	return machine<PushRegistration, PushSubscribeError["reason"]>(
		{
			supported,
			current: () => current(options),
			subscribe: () => subscribe_now(options),
			unsubscribe: () => unsubscribe(options),
			reason,
			identify: ({ token }) => ({ token }),
			rotations(listener) {
				let handle: { remove(): void }
				try {
					handle = Notifications.addPushTokenListener((token) => {
						// Both platforms fire this for every getDevicePushTokenAsync, this
						// module's own included — and minting is one of those, so a listener
						// that re-minted on its own echo would never stop. Only a token that
						// isn't the one last fetched is a rotation; then the registration is
						// minted afresh (an Expo token wrapping it has changed too), remembered
						// in place of the old one, and handed on to be re-filed.
						if (token.data === last_device_token) return
						last_device_token = token.data
						stored(options)
							.then((existing) => (existing ? mint(options) : null))
							.then(async (registration) => {
								if (!registration) return
								await remember(options, registration)
								listener(registration)
							})
							.catch(() => {})
					})
				} catch {
					// No native module to listen to — nothing rotates here either.
					return () => {}
				}
				return () => handle.remove()
			},
		},
		options
	)
}

export type PushSubscriptionStore = ReturnType<typeof subscription>

/**
 * The toggle as a React hook — the phone's `usePush`, with the same shape as the one in
 * `postboi/react`. Call `toggle` from a press.
 *
 * @example
 * ```tsx
 * const push = usePush({ register: "https://example.com/push/registrations", storage: AsyncStorage })
 *
 * <Switch value={push.on} disabled={push.busy || !push.supported} onValueChange={push.toggle} />
 * ```
 */
export function usePush(
	options: SubscriptionOptions = {}
): PushState & Pick<PushSubscriptionStore, "enable" | "disable" | "toggle"> {
	const [controller] = useState(() => subscription(options))
	const state = useSyncExternalStore(controller.subscribe, controller.now, controller.now)
	return {
		...state,
		enable: controller.enable,
		disable: controller.disable,
		toggle: controller.toggle,
	}
}
