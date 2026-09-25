/**
 * The zero-config `whatsapp()`, on the shared channel resolution in `channels.ts`.
 *
 * Development interception (shared with SMS, in the resolver) exists for the same reason
 * SMS has it: a WhatsApp template send costs real money and reaches a real handset with no
 * way to recall it. The way back out is explicit — `dev: { whatsapp: false }` or
 * `POSTBOI_WHATSAPP_DEV=send`.
 */
import type { WhatsappDefaults, WhatsappOptions } from "./types.js"
import type { WhatsappTemplate } from "../index.js"
import type { BatchResult } from "../transport.js"
import { WhatsappProvider } from "./provider.js"
import { channel_send, type ChannelResolution } from "../channels.js"
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
	// Same as SMS: billable, reaches a real handset, and shares Twilio's ambient pair.
	infers: false,
	dev_fallback_warning:
		"postboi: no WhatsApp provider configured, so messages are logged to the console instead of sent. Run `bunx postboi init --whatsapp` to send for real.",
	dev_intercept: {
		env_key: "POSTBOI_WHATSAPP_DEV",
		configured: (config) => config.dev?.whatsapp,
		warning:
			"postboi: development mode, so WhatsApp messages are logged, not sent. Set `dev: { whatsapp: false }` in postboi.config or POSTBOI_WHATSAPP_DEV=send to send for real.",
	},
}

/**
 * Send a WhatsApp message without constructing anything. The provider is whichever
 * `POSTBOI_WHATSAPP_PROVIDER` names; its credentials and the `POSTBOI_WHATSAPP_*`
 * defaults are read from the environment on each call. Pass an array to send many.
 *
 * `whatsapp.closed(error)` answers the routine WhatsApp failure — is this the 24-hour
 * customer service window being closed? — which is the signal to send a pre-approved
 * template instead. It hangs off `whatsapp` itself so the send and its routine failure
 * check are one import.
 *
 * @example
 * ```ts
 * import { whatsapp } from "postboi"
 *
 * try {
 * 	await whatsapp({ to, message })
 * } catch (error) {
 * 	if (!whatsapp.closed(error)) throw error
 * 	await whatsapp({ to, template: "re_engage", variables: { name } })
 * }
 * ```
 */
export const whatsapp: WhatsappSend = Object.assign(
	channel_send<WhatsappOptions>(RESOLUTION) as WhatsappSend,
	{ closed: WhatsappProvider.is_outside_window }
)

/**
 * `whatsapp()`'s own shape: {@link ChannelSend} plus the template type parameter, so a
 * literal `template` narrows the `variables` accepted alongside it. The shared factory
 * can't express that — a channel whose options depend on one of its own fields is this
 * channel only — so the signature is declared here and the factory's runtime is reused
 * unchanged.
 */
interface WhatsappSend {
	<T extends WhatsappTemplate>(options: WhatsappOptions<T>): Promise<unknown>
	(
		options: Array<WhatsappOptions>,
		batch?: { concurrency?: number }
	): Promise<Array<BatchResult<unknown>>>
	/** Was this the 24-hour customer service window being closed? */
	closed(error: unknown): boolean
}
