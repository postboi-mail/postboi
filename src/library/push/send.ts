/**
 * The zero-config `push()`, on the shared channel resolution in `channels.ts`.
 */
import type { BatchResult } from "../transport.js"
import type { PushDefaults, PushOptions } from "./types.js"
import { PushProvider } from "./provider.js"
import { resolve_channel_provider, type ChannelResolution } from "../channels.js"
import { read_env } from "../env.js"

type PushConstructor = new (options: Record<string, unknown>) => PushProvider<unknown>

/** Lazy loaders keyed by `POSTBOI_PUSH_PROVIDER`. */
const LOADERS: ChannelResolution<PushProvider<unknown>>["loaders"] = {
	webpush: () => import("./webpush.js").then((m) => m.default as unknown as PushConstructor),
	fcm: () => import("./fcm.js").then((m) => m.default as unknown as PushConstructor),
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
	dev_fallback_warning:
		"postboi: no push provider configured — logging notifications to the console instead of sending. Run `bunx postboi init --push` to send for real.",
}

/**
 * Send a push notification without constructing anything.
 *
 * @example
 * ```ts
 * import { push } from "postboi"
 *
 * await push({ to: subscription, title: "Order shipped", message: "On its way" })
 * ```
 */
export function push(options: PushOptions): Promise<unknown>
export function push(
	options: Array<PushOptions>,
	batch?: { concurrency?: number }
): Promise<Array<BatchResult<unknown>>>
export async function push(
	options: PushOptions | Array<PushOptions>,
	batch: { concurrency?: number } = {}
): Promise<unknown> {
	const provider = await resolve_channel_provider(RESOLUTION)
	if (Array.isArray(options)) return provider.send(options, batch)
	return provider.send(options)
}

/**
 * Did the push service say this target is dead? Expiring subscriptions are the normal
 * steady state of push, and the right response is to delete your stored copy — not to
 * retry, and not to alert. Hangs off `push` itself so the send and its routine failure
 * check are one import.
 *
 * @example
 * ```ts
 * await push({ to: subscription, message: "hi" }).catch((error) => {
 * 	if (push.expired(error)) forget_subscription()
 * 	else throw error
 * })
 * ```
 */
push.expired = PushProvider.is_expired
