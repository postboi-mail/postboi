/**
 * Project-wide configuration. Set it once and every send — `mail()`, `postboi/kit`, or any
 * provider instance — picks it up, so the 99% case is just calling `mail()`.
 *
 * Drop a `postboi.config.ts` at your project root:
 *
 * ```ts
 * import { config } from "postboi"
 *
 * export default config({
 * 	hooks: {
 * 		on: {
 * 			error: (ctx) => Sentry.captureException(ctx.error),
 * 		},
 * 	},
 * })
 * ```
 *
 * It's auto-loaded on the first `mail()` (Node/Bun). In runtimes without filesystem access
 * (edge/Workers), call {@link configure} explicitly at startup instead.
 */
import type { Defaults, Hooks } from "./index.js"
import type { CaptchaOptions } from "./captcha.js"
import type {
	ChatProviderKey,
	ProviderKey,
	PushProviderKey,
	SmsProviderKey,
	WhatsappProviderKey,
} from "./registry.js"
import type { SmsDefaults } from "./sms/types.js"
import type { ChatDefaults } from "./chat/types.js"
import type { PushDefaults } from "./push/types.js"
import type { WhatsappDefaults } from "./whatsapp/types.js"

/** Everything you can configure globally via `postboi.config.ts` or {@link configure}. */
export interface PostboiConfig {
	/**
	 * Provider key (`resend`, `mailgun`, …) for the zero-config `mail()`. `POSTBOI_PROVIDER` wins.
	 * `"postboi"` is the Postboi provider (usually unnecessary to set — a `POSTBOI_TOKEN` in the
	 * environment already routes `mail()` there). `"mock"` is a credential-free no-op that
	 * records instead of sending, handy as a safe local default you override with
	 * `POSTBOI_PROVIDER` in production.
	 */
	provider?: ProviderKey | "postboi" | "mock"
	/** Default fields applied to every send. Merged under `POSTBOI_*` env vars, which win. */
	default?: Defaults
	/**
	 * Non-secret provider constructor options for the zero-config `mail()`, keyed by the
	 * provider's option name (e.g. `{ domain: "mg.example.com", region: "us-east-1" }`). Lets
	 * you commit non-secret config and keep only the API key in the environment. The matching
	 * provider env var (e.g. `MAILGUN_DOMAIN`) still wins. Keep secrets out of here — in env.
	 */
	options?: Record<string, string>
	/** Per-request timeout in milliseconds. */
	timeout?: number
	/** Retries on network / 429 / 5xx errors. */
	retries?: number
	/** Base retry backoff in milliseconds (doubles each attempt). */
	retry_delay?: number
	/** Derive a plain-text body from the HTML body when `text` is omitted. On by default. */
	auto_text?: boolean
	/**
	 * Lifecycle hooks run around every send, on every channel (the main reason to use a
	 * config file). `ctx.channel` says which channel fired it; narrow on that before
	 * reading channel-specific fields like `message.subject`.
	 */
	hooks?: Hooks
	/**
	 * SMS channel settings for the zero-config `sms()`. `POSTBOI_SMS_*` env vars win over
	 * anything here, the same way they do for email.
	 */
	sms?: {
		/** Provider key (`twilio`, `smsworks`, …). `POSTBOI_SMS_PROVIDER` wins. */
		provider?: SmsProviderKey | "mock"
		/** Default fields applied to every text — sender, recipients, country. */
		default?: SmsDefaults
		/**
		 * Non-secret SMS provider constructor options, keyed by the provider's option name.
		 * Keep secrets in the environment.
		 */
		options?: Record<string, string>
	}
	/**
	 * Chat channel settings for the platform functions (`slack()`, `discord()`, `teams()`,
	 * `telegram()`) and `send()`'s chat leg. `POSTBOI_CHAT_*` env vars win over anything here.
	 */
	chat?: {
		/** Provider key (`slack`, `discord`, `teams`, `telegram`). */
		provider?: ChatProviderKey | "mock"
		/** Default destination and display name. */
		default?: ChatDefaults
		/** Non-secret constructor options. Webhook URLs are secrets — keep them in env. */
		options?: Record<string, string>
	}
	/**
	 * WhatsApp channel settings for the zero-config `whatsapp()` — Twilio or Meta's Cloud
	 * API. `POSTBOI_WHATSAPP_*` env vars win over anything here.
	 */
	whatsapp?: {
		/** Provider key (`twilio`, `meta`). */
		provider?: WhatsappProviderKey | "mock"
		/** Default sender, recipient, country and template language. */
		default?: WhatsappDefaults
		/** Non-secret constructor options. Access tokens are secrets — keep them in env. */
		options?: Record<string, string>
	}
	/** Push channel settings for the zero-config `push()` — Web Push and FCM. */
	push?: {
		/** Provider key (`webpush`, `fcm`). */
		provider?: PushProviderKey | "mock"
		/** Default icon and TTL. Deliberately no default target — push targets are per-device. */
		default?: PushDefaults
		/** Non-secret constructor options. Private keys are secrets — keep them in env. */
		options?: Record<string, string>
	}
	/** Spam-protection settings applied to every FormData send (honeypot + Turnstile). */
	captcha?: CaptchaOptions
	/** Development-only behaviour. Ignored outside `NODE_ENV=development`. */
	dev?: {
		/**
		 * Capture mail in the local dev inbox whenever one is running, instead of sending it.
		 * On by default — set false if you want local sends to reach the real provider.
		 */
		inbox?: boolean
		/**
		 * Capture texts in development instead of sending them. **On by default, and
		 * stricter than `inbox`** — mail is only intercepted when an inbox is running, but
		 * texts are always intercepted in development, because a stray one costs money and
		 * reaches a real handset with no way to recall it. Set false (or
		 * `POSTBOI_SMS_DEV=send`) when you genuinely need to test real delivery.
		 */
		sms?: boolean
		/**
		 * Capture WhatsApp messages in development instead of sending them. On by default,
		 * for the same reason as SMS — real money, real handset, no recall. Set false (or
		 * `POSTBOI_WHATSAPP_DEV=send`) to test real delivery.
		 */
		whatsapp?: boolean
	}
}

/** Keep only defined entries so a shallow merge never clobbers a value with `undefined`. */
function defined<T extends object>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(obj)) if (value !== undefined) out[key] = value
	return out as Partial<T>
}

/**
 * Deep-merge hook groups so instance overrides don't clobber unrelated global hooks.
 * Structural over the group shape rather than tied to one hooks type, because the global
 * `Hooks` (discriminated across channels) and each channel's `TransportHooks<TPrepared>`
 * are different types that merge identically.
 */
export function merge_hooks<T extends { before?: object; after?: object; on?: object }>(
	base?: T,
	override?: T
): T {
	return {
		before: { ...base?.before, ...defined(override?.before ?? {}) },
		after: { ...base?.after, ...defined(override?.after ?? {}) },
		on: { ...base?.on, ...defined(override?.on ?? {}) },
	} as T
}

/** Merge `override` over `base`, deep-merging the `default`, `hooks` and `captcha` objects. */
function merge(base: PostboiConfig, override: PostboiConfig): PostboiConfig {
	return {
		...base,
		...defined(override),
		default: { ...base.default, ...defined(override.default ?? {}) },
		hooks: merge_hooks(base.hooks, override.hooks),
		captcha: { ...base.captcha, ...defined(override.captcha ?? {}) },
		sms: {
			...base.sms,
			...defined(override.sms ?? {}),
			default: { ...base.sms?.default, ...defined(override.sms?.default ?? {}) },
		},
		chat: {
			...base.chat,
			...defined(override.chat ?? {}),
			default: { ...base.chat?.default, ...defined(override.chat?.default ?? {}) },
		},
		push: {
			...base.push,
			...defined(override.push ?? {}),
			default: { ...base.push?.default, ...defined(override.push?.default ?? {}) },
		},
		whatsapp: {
			...base.whatsapp,
			...defined(override.whatsapp ?? {}),
			default: { ...base.whatsapp?.default, ...defined(override.whatsapp?.default ?? {}) },
		},
	}
}

let explicit: PostboiConfig = {}
let disk: PostboiConfig = {}
let disk_loaded = false
let bundled: (() => Promise<unknown>) | null = null

/**
 * Install a bundler-inlined loader for the project's `postboi.config.*`. Called by the
 * `postboi/vite` plugin, which is how edge runtimes get a config file at all — they have no
 * filesystem to read one from, so the server bundle carries it instead.
 *
 * A lazy loader rather than a static import on purpose: the config file imports `config`
 * from this module, so importing it from here in turn would evaluate it mid-cycle, before
 * the state below exists.
 *
 * @internal
 */
export function set_bundled_config(load: () => Promise<unknown>): void {
	bundled = load
}

/**
 * Register global config imperatively. Useful in runtimes without filesystem access (edge,
 * Cloudflare Workers) where the file auto-load can't run. Calls merge, so it's additive.
 */
export function configure(config: PostboiConfig): void {
	explicit = merge(explicit, config)
}

/**
 * Project config helper for `postboi.config.ts`. Registers them as a side effect (so merely
 * importing the file is enough) and returns them, so it works as a typed `export default`.
 */
export function config(config: PostboiConfig): PostboiConfig {
	configure(config)
	return config
}

/** The current effective config (disk config underneath anything set via {@link configure}). */
/**
 * Did a `postboi.config.*` actually get loaded — from disk or bundled in?
 *
 * Used to sharpen the "no recipient / no sender" errors. A config that silently didn't load
 * is the difference between "you forgot to set a default" and "your defaults exist but never
 * reached the runtime", and those have completely different fixes.
 */
export function config_loaded(): boolean {
	// `explicit` counts: configure() is the documented way to supply config where a file
	// can't be auto-loaded, so someone who called it has configured postboi.
	return bundled !== null || Object.keys(disk).length > 0 || Object.keys(explicit).length > 0
}

export function get_config(): PostboiConfig {
	return merge(disk, explicit)
}

/** Reset all registered config, including any bundled loader. Intended for tests. */
export function reset_config(): void {
	explicit = {}
	disk = {}
	disk_loaded = false
	bundled = null
}

/**
 * Ensure the config file has been read (once), then return the effective config. Called on
 * the `mail()` path. Best-effort — any failure falls back to whatever was set via
 * {@link configure}. Reads the bundled copy where a bundler inlined one (see
 * {@link set_bundled_config}), otherwise the file on disk, which needs Node/Bun.
 */
export async function load_config(): Promise<PostboiConfig> {
	if (!disk_loaded) {
		disk_loaded = true
		disk = bundled ? await read_bundled(bundled) : await read_disk()
	}
	return get_config()
}

/** Pull the config out of a bundled module. Its `config()` call also registers it directly. */
async function read_bundled(load: () => Promise<unknown>): Promise<PostboiConfig> {
	try {
		const mod = (await load()) as { default?: PostboiConfig; config?: PostboiConfig }
		const config = mod.default ?? mod.config
		return config && typeof config === "object" ? config : {}
	} catch (error) {
		// Bundled means it built — failing here is a real misconfiguration, so be loud rather
		// than let defaults/hooks/provider silently vanish.
		console.warn("postboi: the bundled postboi.config failed to load:", error)
		return {}
	}
}

const CONFIG_FILES = [
	"postboi.config.ts",
	"postboi.config.mts",
	"postboi.config.js",
	"postboi.config.mjs",
]

/** Find and import a `postboi.config.*` file, walking up from the cwd. */
async function read_disk(): Promise<PostboiConfig> {
	if (typeof process === "undefined" || !process.versions?.node) return {}
	try {
		const { existsSync } = await import("node:fs")
		const path = await import("node:path")
		const { pathToFileURL } = await import("node:url")

		let dir = process.cwd()
		for (;;) {
			const file = CONFIG_FILES.map((f) => path.join(dir, f)).find((f) => existsSync(f))
			if (file) {
				try {
					const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
						default?: PostboiConfig
						config?: PostboiConfig
					}
					const config = mod.default ?? mod.config
					return config && typeof config === "object" ? config : {}
				} catch (error) {
					// A found config that fails to import is a misconfiguration, not a missing file —
					// be loud so defaults/hooks/provider don't silently vanish.
					const hint = file.endsWith("ts")
						? " (this Node can't import TypeScript config — use Node 23.6+ or rename to postboi.config.js)"
						: ""
					console.warn(
						`postboi: found ${path.basename(file)} but couldn't import it${hint}:`,
						error
					)
					return {}
				}
			}
			const parent = path.dirname(dir)
			if (parent === dir) return {}
			dir = parent
		}
	} catch {
		// No fs, unreadable file, or a `.ts` file on a runtime that can't strip types — fall back.
		return {}
	}
}
