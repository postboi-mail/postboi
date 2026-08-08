import { describe, it, expect } from "vitest"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as {
	exports: Record<string, string | { types?: string; default: string }>
}

/** Map an exports target like "./dist/resend.js" or "./dist/resend.d.ts" to "src/library/resend.ts". */
const to_source = (target: string) =>
	target
		.replace("./dist/", "src/library/")
		// Svelte component types (Captcha.svelte.d.ts) are generated from the .svelte source.
		.replace(/\.svelte\.d\.ts$/, ".svelte")
		.replace(/\.d\.ts$/, ".ts")
		.replace(/\.js$/, ".ts")

describe("package exports", () => {
	const entries = Object.entries(pkg.exports).map(
		([name, target]) => [name, typeof target === "string" ? { default: target } : target] as const
	)

	it("points every entry at an existing source module and matching types", () => {
		for (const [name, target] of entries) {
			expect(existsSync(root + to_source(target.default)), `${name} default`).toBe(true)
			if (target.types)
				expect(existsSync(root + to_source(target.types)), `${name} types`).toBe(true)
		}
	})

	it("exports every provider module in src/library", () => {
		const internal = new Set([
			"index.ts",
			"utils.ts",
			"registry.ts",
			"config.ts",
			"env.ts",
			"workers_env.ts", // Cloudflare binding reader, used by env.ts
			"mail.ts",
			"encoding.ts", // shared base64/base64url codecs, used by webhooks, push and FCM
			"twilio_common.ts", // Twilio plumbing shared by the SMS and WhatsApp providers
			"channels.ts", // shared zero-config resolution, used by each channel send.ts
			"send.ts", // the multi-channel fan-out, re-exported from the root
			"mock_recorder.ts", // shared mock capture machinery, used by each channel mock
			"channel_inbox.ts", // channel captures → dev inbox bridge, used by the dev interceptions
			"captcha.ts", // spam protection, reached via the root export
			"aws.ts", // SigV4 signing, used by ses.ts (and SNS later)
			"errors.ts", // normalized errors, re-exported from the root
			"transport.ts", // channel-agnostic provider base, re-exported from the root
			"register.ts", // generated-types placeholder, reached via the root export
			"inbox.ts", // dev inbox discovery, reached via mail.ts (and patched by postboi/vite)
			"inbox_server.ts", // dev inbox HTTP surface, mounted by postboi/vite and the CLI
			"inbox_ui.ts", // the dev inbox document, served by inbox_server.ts
			"inbox_sounds.ts", // the dev inbox's audio, served by inbox_server.ts
			"inbox_theme.ts", // vendored XP.css, inlined into the dev inbox document
			"inbox_art.ts", // the dev inbox's sign-on artwork, served by inbox_server.ts
			"inbox_desktop.ts", // the dev inbox's wallpaper, clip and Start button, served by inbox_server.ts
		])
		// Channel providers live in subdirectories (`sms/`), so scan those too — otherwise a
		// new provider could ship with no exports entry and nothing would notice.
		const channel_internal = new Set([
			"sms/types.ts", // pure types, re-exported from the root
			"sms/provider.ts", // the SMS base class, reached via each provider
			"sms/phone.ts", // E.164 + segment helpers, used by sms/provider.ts
			"sms/send.ts", // the zero-config sms(), re-exported from the root
			"chat/types.ts", // pure types, re-exported from the root
			"chat/provider.ts", // the chat base class, reached via each provider
			"chat/send.ts", // the platform functions (slack() and friends), re-exported from the root
			"push/types.ts", // pure types, re-exported from the root
			"push/provider.ts", // the push base class, reached via each provider
			"push/crypto.ts", // VAPID + aes128gcm, used by push/webpush.ts
			"push/send.ts", // the zero-config push(), re-exported from the root
			"whatsapp/types.ts", // pure types, re-exported from the root
			"whatsapp/provider.ts", // the WhatsApp base class, reached via each provider
			"whatsapp/send.ts", // the zero-config whatsapp(), re-exported from the root
		])
		const providers = [
			...readdirSync(`${root}src/library`).filter(
				(f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !internal.has(f)
			),
			...["sms", "chat", "push", "whatsapp"].flatMap((dir) =>
				readdirSync(`${root}src/library/${dir}`)
					.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
					.map((f) => `${dir}/${f}`)
					.filter((f) => !channel_internal.has(f))
			),
		]
		const exported = new Set(
			entries.map(([, t]) => to_source(t.default).replace("src/library/", ""))
		)

		for (const file of providers) {
			expect(exported.has(file), `${file} should have a package.json exports entry`).toBe(true)
		}
	})
})
