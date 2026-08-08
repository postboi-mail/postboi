/**
 * The zero-config `whatsapp()`, on the shared channel resolution in `channels.ts`.
 *
 * Development interception (shared with SMS, in the resolver) exists for the same reason
 * SMS has it: a WhatsApp template send costs real money and reaches a real handset with no
 * way to recall it. The way back out is explicit — `dev: { whatsapp: false }` or
 * `POSTBOI_WHATSAPP_DEV=send`.
 */
import type { BatchResult } from "../transport.js"
import type { WhatsappDefaults, WhatsappOptions } from "./types.js"
import { WhatsappProvider } from "./provider.js"
import { resolve_channel_provider, type ChannelResolution } from "../channels.js"
import { read_env } from "../env.js"

type WhatsappConstructor = new (options: Record<string, unknown>) => WhatsappProvider<unknown>

/** Lazy loaders keyed by `POSTBOI_WHATSAPP_PROVIDER`. */
const LOADERS: ChannelResolution<WhatsappProvider<unknown>>["loaders"] = {
	twilio: () => import("./twilio.js").then((m) => m.default as unknown as WhatsappConstructor),
	meta: () => import("./meta.js").then((m) => m.default as unknown as WhatsappConstructor),
	mock: () => import("./mock.js").then((m) => m.default as unknown as WhatsappConstructor),
}

/** Read the WhatsApp defaults from the environment. Only defined values are included. */
export function whatsapp_env_defaults(): WhatsappDefaults {
	const out: WhatsappDefaults = {}
	const from = read_env("POSTBOI_WHATSAPP_FROM")
	const to = read_env("POSTBOI_WHATSAPP_TO")
	const country = read_env("POSTBOI_WHATSAPP_COUNTRY")
	const language = read_env("POSTBOI_WHATSAPP_LANGUAGE")
	if (from !== undefined) out.from = from
	if (to !== undefined) out.to = to
	if (country !== undefined) out.country = country
	if (language !== undefined) out.language = language
	return out
}

const RESOLUTION: ChannelResolution<WhatsappProvider<unknown>> = {
	channel: "whatsapp",
	env_key: "POSTBOI_WHATSAPP_PROVIDER",
	loaders: LOADERS,
	env_defaults: whatsapp_env_defaults as () => Record<string, unknown>,
	section: (config) => config.whatsapp,
	init_flag: "--whatsapp",
	dev_fallback_warning:
		"postboi: no WhatsApp provider configured — logging messages to the console instead of sending. Run `bunx postboi init --whatsapp` to send for real.",
	dev_intercept: {
		env_key: "POSTBOI_WHATSAPP_DEV",
		configured: (config) => config.dev?.whatsapp,
		warning:
			"postboi: development — WhatsApp messages are logged, not sent. Set `dev: { whatsapp: false }` in postboi.config or POSTBOI_WHATSAPP_DEV=send to send for real.",
	},
}

/**
 * Send a WhatsApp message without constructing anything. The provider is whichever
 * `POSTBOI_WHATSAPP_PROVIDER` names; its credentials and the `POSTBOI_WHATSAPP_*`
 * defaults are read from the environment on each call. Pass an array to send many.
 *
 * @example
 * ```ts
 * import { whatsapp } from "postboi"
 *
 * await whatsapp({
 * 	to: "+447788223344",
 * 	template: "order_shipped",
 * 	variables: { name: "Ada", tracking: "AB123" },
 * })
 * ```
 */
export function whatsapp(options: WhatsappOptions): Promise<unknown>
export function whatsapp(
	options: Array<WhatsappOptions>,
	batch?: { concurrency?: number }
): Promise<Array<BatchResult<unknown>>>
export async function whatsapp(
	options: WhatsappOptions | Array<WhatsappOptions>,
	batch: { concurrency?: number } = {}
): Promise<unknown> {
	const provider = await resolve_channel_provider(RESOLUTION)
	if (Array.isArray(options)) return provider.send(options, batch)
	return provider.send(options)
}

/**
 * Is this failure the 24-hour customer service window being closed? The routine WhatsApp
 * failure, and the signal to send a pre-approved template instead. Hangs off `whatsapp`
 * itself so the send and its routine failure check are one import.
 *
 * @example
 * ```ts
 * try {
 * 	await whatsapp({ to, message })
 * } catch (error) {
 * 	if (!whatsapp.closed(error)) throw error
 * 	await whatsapp({ to, template: "re_engage", variables: { name } })
 * }
 * ```
 */
whatsapp.closed = WhatsappProvider.is_outside_window
