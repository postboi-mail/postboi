/**
 * The zero-config `push()`, on the shared channel resolution in `channels.ts`.
 */
import type { PushDefaults, PushOptions } from "./types.js"
import { PushProvider } from "./provider.js"
import { channel_send, type ChannelResolution } from "../channels.js"
import { read_env } from "../env.js"

type PushConstructor = new (options: Record<string, unknown>) => PushProvider<unknown>

/** Lazy loaders keyed by `POSTBOI_PUSH_PROVIDER`. */
const LOADERS: ChannelResolution<PushProvider<unknown>>["loaders"] = {
	webpush: () => import("./webpush.js").then((m) => m.default as unknown as PushConstructor),
	fcm: () => import("./fcm.js").then((m) => m.default as unknown as PushConstructor),
	apns: () => import("./apns.js").then((m) => m.default as unknown as PushConstructor),
	hms: () => import("./hms.js").then((m) => m.default as unknown as PushConstructor),
	expo: () => import("./expo.js").then((m) => m.default as unknown as PushConstructor),
	mock: () => import("./mock.js").then((m) => m.default as unknown as PushConstructor),
}

/** Read the push defaults from the environment. */
export function push_env_defaults(): PushDefaults {
	const out: PushDefaults = {}
	const icon = read_env("POSTBOI_PUSH_ICON")
	if (icon !== undefined) out.icon = icon
	// Deliberately no POSTBOI_PUSH_TO: a push target is per-device, so a single one in the
	// environment would be a footgun rather than a convenience.
	return out
}

const RESOLUTION: ChannelResolution<PushProvider<unknown>> = {
	channel: "push",
	env_key: "POSTBOI_PUSH_PROVIDER",
	loaders: LOADERS,
	env_defaults: push_env_defaults as () => Record<string, unknown>,
	section: (config) => config.push,
	init_flag: "--push",
	// A VAPID trio is minted for exactly this and nothing else, and a wrong guess costs
	// nothing — this is the case inference exists for.
	infers: true,
	dev_fallback_warning:
		"postboi: no push provider configured, so notifications are logged to the console instead of sent. Run `bunx postboi init --push` to send for real.",
}

/**
 * Send a push notification without constructing anything.
 *
 * `push.expired(error)` answers the routine push failure — did the service say this
 * target is dead? Expiring subscriptions are the normal steady state of push, and the
 * right response is to delete your stored copy — not to retry, and not to alert. It
 * hangs off `push` itself so the send and its routine failure check are one import.
 *
 * @example
 * ```ts
 * import { push } from "postboi"
 *
 * await push({ to: subscription, message: "hi" }).catch((error) => {
 * 	if (push.expired(error)) forget_subscription()
 * 	else throw error
 * })
 * ```
 */
export const push = Object.assign(channel_send<PushOptions>(RESOLUTION), {
	expired: PushProvider.is_expired,
})
