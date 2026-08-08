/**
 * The zero-config `sms()`, mirroring `mail()`: resolve a provider from the environment,
 * intercept in development, send. Both live in the shared channel machinery in
 * `channels.ts` — interception included, so its semantics can't drift from WhatsApp's.
 */
import type { BatchResult } from "../transport.js"
import type { SmsOptions, SmsDefaults } from "./types.js"
import type { SmsProvider } from "./provider.js"
import { resolve_channel_provider, type ChannelResolution } from "../channels.js"
import { read_env } from "../env.js"

type SmsConstructor = new (options: Record<string, unknown>) => SmsProvider<unknown>

/** Lazy loaders keyed by `POSTBOI_SMS_PROVIDER` — one chunk per provider. */
const LOADERS: ChannelResolution<SmsProvider<unknown>>["loaders"] = {
	smsworks: () => import("./smsworks.js").then((m) => m.default as unknown as SmsConstructor),
	twilio: () => import("./twilio.js").then((m) => m.default as unknown as SmsConstructor),
	sns: () => import("./sns.js").then((m) => m.default as unknown as SmsConstructor),
	// Credential-free no-op, and the development fallback.
	mock: () => import("./mock.js").then((m) => m.default as unknown as SmsConstructor),
}

/** Read the SMS defaults from the environment. Only defined values are included. */
export function sms_env_defaults(): SmsDefaults {
	const out: SmsDefaults = {}
	const from = read_env("POSTBOI_SMS_FROM")
	const to = read_env("POSTBOI_SMS_TO")
	const country = read_env("POSTBOI_SMS_COUNTRY")
	if (from !== undefined) out.from = from
	if (to !== undefined) out.to = to
	if (country !== undefined) out.country = country
	return out
}

const RESOLUTION: ChannelResolution<SmsProvider<unknown>> = {
	channel: "sms",
	env_key: "POSTBOI_SMS_PROVIDER",
	loaders: LOADERS,
	env_defaults: sms_env_defaults as () => Record<string, unknown>,
	section: (config) => config.sms,
	init_flag: "--sms",
	dev_fallback_warning:
		"postboi: no SMS provider configured — logging texts to the console instead of sending. Run `bunx postboi init --sms` to send for real.",
	dev_intercept: {
		env_key: "POSTBOI_SMS_DEV",
		configured: (config) => config.dev?.sms,
		warning:
			"postboi: development — texts are logged, not sent. Set `dev: { sms: false }` in postboi.config or POSTBOI_SMS_DEV=send to send for real.",
	},
}

/**
 * Send a text without constructing anything. The provider is whichever
 * `POSTBOI_SMS_PROVIDER` names; its credentials and the `POSTBOI_SMS_*` defaults are read
 * from the environment on each call. Pass an array to send many.
 *
 * @example
 * ```ts
 * import { sms } from "postboi"
 *
 * await sms({ to: "+447788223344", message: "Your code is 4291" })
 * ```
 */
export function sms(options: SmsOptions): Promise<unknown>
export function sms(
	options: Array<SmsOptions>,
	batch?: { concurrency?: number }
): Promise<Array<BatchResult<unknown>>>
export async function sms(
	options: SmsOptions | Array<SmsOptions>,
	batch: { concurrency?: number } = {}
): Promise<unknown> {
	const provider = await resolve_channel_provider(RESOLUTION)
	if (Array.isArray(options)) return provider.send(options, batch)
	return provider.send(options)
}
