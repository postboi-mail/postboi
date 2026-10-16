/**
 * Regression tests for the findings of the first multi-channel code review — one per
 * confirmed bug, so none of them can come back quietly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { configure, reset_config } from "./config.js"
import { Transport, type RequestSpec } from "./transport.js"
import type { Hooks, PreparedMessage } from "./index.js"
import { SmsProvider, ChatProvider, PushProvider } from "./postboi.js"
import SmsWorks from "./sms/smsworks.js"
import Twilio from "./sms/twilio.js"
import Telegram from "./chat/telegram.js"
import Discord from "./chat/discord.js"
import WebPush from "./push/webpush.js"
import FCM from "./push/fcm.js"
import { to_e164 } from "./sms/phone.js"
import { chat } from "./chat/send.js"
import type { Channel } from "./errors.js"

const respond = ({ ok = true, status = 200, body = "" as unknown, url = "" } = {}) =>
	({
		ok,
		status,
		url,
		headers: new Headers(),
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	}) as unknown as Response

beforeEach(() => {
	reset_config()
	vi.unstubAllGlobals()
	delete process.env.NODE_ENV
})
afterEach(() => reset_config())

const OK_RESPONSE = { ok: true, status: 200, headers: new Headers(), text: async () => "{}" }

/**
 * `options` in a config section is a flat bag keyed by `arg`, and `arg` names collide by
 * design — `api_key` across 15 email providers, `webhook_url` across Slack/Discord/Teams,
 * `private_key` across Web Push/FCM/APNs. So whenever something other than the config file
 * picks the provider, the bag would hand the wrong vendor's credential to the new one.
 * Reported for two paths; there are four, and each gets a test that fails loudly if the
 * scoping is lost, asserting on *zero network calls* rather than on the error alone —
 * the failure that matters is the secret leaving the process.
 */
describe("a config file's options never reach another provider", () => {
	const spy = () => {
		const f = vi.fn().mockResolvedValue(OK_RESPONSE)
		vi.stubGlobal("fetch", f)
		return f
	}

	// Owned rather than assumed: these tests are about which credential reaches which
	// provider, so an ambient DISCORD_WEBHOOK_URL on the machine running them would
	// silently change the answer. (The polluted-environment CI run found exactly that.)
	const CONTROLLED = [
		"NODE_ENV",
		"POSTBOI_PROVIDER",
		"POSTBOI_CHAT_PROVIDER",
		"POSTBOI_PUSH_PROVIDER",
		"POSTBOI_SMS_PROVIDER",
		"SMSWORKS_API_KEY",
		"PURESMS_API_KEY",
		"RESEND_API_KEY",
		"SLACK_WEBHOOK_URL",
		"DISCORD_WEBHOOK_URL",
		"TEAMS_WEBHOOK_URL",
		"TELEGRAM_BOT_TOKEN",
	]

	beforeEach(() => {
		reset_config()
		vi.unstubAllGlobals()
		for (const k of CONTROLLED) delete process.env[k]
		process.env.NODE_ENV = "production"
	})
	afterEach(() => {
		reset_config()
		vi.unstubAllGlobals()
		for (const k of CONTROLLED) delete process.env[k]
	})

	it("mail: a Mailgun key does not go out to Resend", async () => {
		const { mail } = await import("./mail.js")
		configure({
			provider: "mailgun",
			options: { api_key: "key-MAILGUN-SECRET", domain: "mg.example.com" },
			default: { from: "c@d.com" },
		})
		process.env.POSTBOI_PROVIDER = "resend"
		const fetch = spy()

		const error = await mail({ to: "a@b.com", subject: "hi", body: "hi" }).catch((e) => e)

		// The bug sent `Authorization: Bearer key-MAILGUN-SECRET` to api.resend.com.
		expect(fetch).not.toHaveBeenCalled()
		expect(error.code).toBe("missing_env")
		// And it says why, or the config plainly showing `options.api_key` reads as a lie.
		expect(error.message).toContain("mailgun")
	})

	it("chat: a Slack webhook URL is not posted to by Discord", async () => {
		const { chat } = await import("./chat/send.js")
		configure({
			chat: {
				provider: "slack",
				options: { webhook_url: "https://hooks.slack.com/services/T0/B0/SLACKSECRET" },
			},
		})
		process.env.POSTBOI_CHAT_PROVIDER = "discord"
		const fetch = spy()

		const error = await chat({ message: "hi" }).catch((e) => e)

		expect(fetch).not.toHaveBeenCalled()
		expect(error.code).toBe("missing_env")
		// Same reasoning as the mail case: the config visibly has a webhook_url, so the
		// error has to say whose it is.
		expect(error.message).toContain("slack")
	})

	it("sms: an SMS Works key is not sent to PureSMS", async () => {
		const { sms } = await import("./sms/send.js")
		configure({
			sms: { provider: "smsworks", options: { api_key: "SMSWORKS-JWT-SECRET" } },
		})
		process.env.POSTBOI_SMS_PROVIDER = "puresms"
		const fetch = spy()

		const error = await sms({ to: "+447788223344", from: "P", message: "hi" }).catch((e) => e)

		// Both take a lone `api_key`, so this is the SMS leak the pin below says is reachable.
		expect(fetch).not.toHaveBeenCalled()
		expect(error.code).toBe("missing_env")
		expect(error.message).toContain("smsworks")
	})

	it("chat: the platform functions are scoped too, not just the generic one", async () => {
		const { discord } = await import("./chat/send.js")
		configure({
			chat: {
				provider: "slack",
				options: { webhook_url: "https://hooks.slack.com/services/T0/B0/SLACKSECRET" },
			},
		})
		const fetch = spy()

		// No env var involved: the config names slack, the caller chose discord.
		const error = await discord({ message: "hi" }).catch((e) => e)

		expect(fetch).not.toHaveBeenCalled()
		expect(error.code).toBe("missing_env")
	})

	it("chat: Discord uses its own webhook even with Slack's sitting in the config", async () => {
		const { chat } = await import("./chat/send.js")
		const SLACK = "https://hooks.slack.com/services/T0/B0/SLACKSECRET"
		configure({ chat: { provider: "slack", options: { webhook_url: SLACK } } })
		process.env.POSTBOI_CHAT_PROVIDER = "discord"
		process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1/DISCORDOWN"
		const fetch = spy()

		await chat({ message: "hi" })

		// The send goes through, which is the point — this is the case where refusing would
		// be wrong. What must not happen is Slack's secret travelling with it.
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(fetch.mock.calls[0][0]).toContain("discord.com")
		expect(JSON.stringify(fetch.mock.calls)).not.toContain("SLACKSECRET")
	})

	it("locks in which channels a scoping slip could even be exploited on", async () => {
		const registry = await import("./registry.js")
		// A leak is only reachable when the *whole* required set of one provider is present
		// in another's option bag. Email is riddled with it — 15 providers whose only
		// required field is `api_key` — and chat has slack/discord/teams on `webhook_url`;
		// both are covered by the sends above. Push shares `private_key` across webpush,
		// fcm and apns but is *not* reachable, because APNs also needs key_id, team_id and
		// topic that an FCM bag never carries. That is a property of today's registry, not
		// a guarantee, so it is pinned: a new provider whose required fields are a subset
		// of a sibling's turns its channel exploitable, and should say so here first.
		const reachable = (
			list: ReadonlyArray<{ key: string; fields: ReadonlyArray<{ arg: string; default?: string }> }>
		) => {
			const required = (p: (typeof list)[number]) =>
				new Set(p.fields.filter((f) => f.default === undefined).map((f) => f.arg))
			const out: string[] = []
			for (const src of list)
				for (const dst of list) {
					if (src.key === dst.key) continue
					const from = required(src)
					const needs = required(dst)
					// A destination needing nothing (Expo) takes nothing from the bag either, so
					// there is no credential to leak — reachable, but not exploitable.
					if (needs.size && [...needs].every((a) => from.has(a)))
						out.push(`${src.key} -> ${dst.key}`)
				}
			return out
		}

		// SMS joined the exploitable set when PureSMS arrived: like The SMS Works it takes a
		// lone `api_key`, so each one's bag satisfies the other. The send above covers it.
		// Telnyx and Vonage each require only an `api_key` too, so all four satisfy each other.
		// Vonage's secret or application is optional to the registry (either will do), which
		// is why it counts; the scoping above is what keeps every one of these pairs closed.
		expect(reachable(registry.SMS_PROVIDERS as never)).toEqual([
			"smsworks -> puresms",
			"smsworks -> telnyx",
			"smsworks -> vonage",
			"puresms -> smsworks",
			"puresms -> telnyx",
			"puresms -> vonage",
			"telnyx -> smsworks",
			"telnyx -> puresms",
			"telnyx -> vonage",
			"vonage -> smsworks",
			"vonage -> puresms",
			"vonage -> telnyx",
		])
		expect(reachable(registry.PUSH_PROVIDERS as never)).toEqual([])
		expect(reachable(registry.WHATSAPP_PROVIDERS as never)).toEqual([])
		// The two that are exploitable, so the numbers moving is visible rather than silent.
		expect(reachable(registry.CHAT_PROVIDERS as never)).toHaveLength(6)
		expect(reachable(registry.PROVIDERS as never).length).toBeGreaterThan(100)
	})

	it("still applies options when the config file names the provider being built", async () => {
		const { mail } = await import("./mail.js")
		configure({
			provider: "resend",
			options: { api_key: "re_CONFIGURED" },
			default: { from: "c@d.com" },
		})
		const fetch = spy()

		await mail({ to: "a@b.com", subject: "hi", body: "hi" })

		expect(fetch.mock.calls[0][0]).toContain("resend.com")
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer re_CONFIGURED")
	})

	it("still applies options a config file leaves unscoped", async () => {
		const { mail } = await import("./mail.js")
		// No `provider` in the config: the options can only have been meant for whatever
		// ends up running, so dropping them here would break a working setup.
		configure({ options: { api_key: "re_UNSCOPED" }, default: { from: "c@d.com" } })
		process.env.POSTBOI_PROVIDER = "resend"
		const fetch = spy()

		await mail({ to: "a@b.com", subject: "hi", body: "hi" })

		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer re_UNSCOPED")
	})

	it("keeps env ahead of a matching config file's options", async () => {
		const { mail } = await import("./mail.js")
		configure({
			provider: "resend",
			options: { api_key: "re_CONFIG" },
			default: { from: "c@d.com" },
		})
		process.env.RESEND_API_KEY = "re_ENV"
		const fetch = spy()

		await mail({ to: "a@b.com", subject: "hi", body: "hi" })

		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer re_ENV")
	})
})

const CHANNELS = ["push", "sms", "chat", "whatsapp"] as const

describe("provider inference reads intent, not ambience", () => {
	it("infers nothing from an empty environment, on every channel", async () => {
		const { infer_channel_provider } = await import("./registry.js")
		// A provider whose every field carries a `default` would count as configured with
		// nothing set, and would then be inferred for everyone on that channel.
		for (const channel of CHANNELS) {
			expect([channel, infer_channel_provider(channel, () => false)]).toEqual([channel, undefined])
		}
	})

	it("infers nothing on a machine carrying only ambient credentials", async () => {
		const registry = await import("./registry.js")
		// Shipped in 0.33.0 without this: SNS needs only AWS_ACCESS_KEY_ID and
		// AWS_SECRET_ACCESS_KEY (its region is defaulted), so any environment that had ever
		// touched AWS made sms() choose SNS and attempt a live send with credentials meant
		// for something else. The empty-environment test above passes happily through that
		// bug; only a populated one catches it.
		//
		// The set is derived rather than listed. It was written by hand for the nine names
		// the first fix covered, and then not updated when the chat webhooks, Mailjet and
		// Twilio's pair were marked — a stale hand-written list inside the work that argues
		// hand-written lists rot. Derived, it states the actual property: a machine carrying
		// only credentials we have judged ambient configures nothing, whatever those are
		// this week.
		const ambient = new Set<string>()
		for (const group of [
			registry.PROVIDERS,
			registry.SMS_PROVIDERS,
			registry.CHAT_PROVIDERS,
			registry.PUSH_PROVIDERS,
			registry.WHATSAPP_PROVIDERS,
		] as ReadonlyArray<ReadonlyArray<{ fields: ReadonlyArray<{ env: string; ambient?: true }> }>>)
			for (const provider of group)
				for (const field of provider.fields) if (field.ambient) ambient.add(field.env)

		expect(ambient.size).toBeGreaterThan(0)
		for (const channel of CHANNELS) {
			expect([
				channel,
				registry.infer_channel_provider(channel, (env) => ambient.has(env)),
			]).toEqual([channel, undefined])
		}
	})

	it("pins the ambient marks themselves", async () => {
		const registry = await import("./registry.js")
		// The list above is derived, and derived lists move for two reasons: a mark changed,
		// or a provider was added. This pins the marks directly so the first is never
		// mistaken for the second.
		//
		// It is also the only net that catches an unmarked name, because no automatic check
		// can. "Is this env var set in the wild for other reasons" is a judgement about the
		// ecosystem, not a property of the code — the polluted CI run can't see it either,
		// since filling *every* credential makes inference ambiguous and hides exactly the
		// single-credential case. So the judgement is made here, in a diff someone reads.
		const marked = new Set<string>()
		for (const group of [
			registry.PROVIDERS,
			registry.SMS_PROVIDERS,
			registry.CHAT_PROVIDERS,
			registry.PUSH_PROVIDERS,
			registry.WHATSAPP_PROVIDERS,
		] as ReadonlyArray<ReadonlyArray<{ fields: ReadonlyArray<{ env: string; ambient?: true }> }>>)
			for (const provider of group)
				for (const field of provider.fields) if (field.ambient) marked.add(field.env)

		expect([...marked].sort()).toEqual([
			// The Alibaba Cloud SDKs' own credential names.
			"ALIBABA_CLOUD_ACCESS_KEY_ID",
			"ALIBABA_CLOUD_ACCESS_KEY_SECRET",
			"ALIBABA_CLOUD_REGION_ID",
			// Any box that has ever touched AWS.
			"AWS_ACCESS_KEY_ID",
			"AWS_REGION",
			"AWS_SECRET_ACCESS_KEY",
			// Wherever wrangler has run.
			"CLOUDFLARE_ACCOUNT_ID",
			"CLOUDFLARE_API_TOKEN",
			"CLOUDFLARE_QUEUE_ID",
			// Any box that has ever touched Azure Communication Services.
			"COMMUNICATION_SERVICES_CONNECTION_STRING",
			// What every CI notification action sets.
			"DISCORD_WEBHOOK_URL",
			// What expo-server-sdk's README reads; optional too, so unmarked it would make
			// Expo "configured" on every machine.
			"EXPO_ACCESS_TOKEN",
			// Mailjet's own SDK default pair.
			"MJ_APIKEY_PRIVATE",
			"MJ_APIKEY_PUBLIC",
			// Somebody else's bounce mailbox.
			"POP3_HOST",
			"POP3_PASS",
			"POP3_PORT",
			"POP3_SECURE",
			"POP3_USER",
			"SLACK_WEBHOOK_URL",
			// Somebody else's mailer.
			"SMTP_HOST",
			"SMTP_PASS",
			"SMTP_PORT",
			"SMTP_SECURE",
			"SMTP_USER",
			"TEAMS_WEBHOOK_URL",
			"TELEGRAM_BOT_TOKEN",
			// Telnyx's and Vonage's API keys: their Voice and Verify users set them too.
			"TELNYX_API_KEY",
			// The Twilio SDK's zero-argument defaults — Voice and Verify set these too.
			"TWILIO_ACCOUNT_SID",
			"TWILIO_AUTH_TOKEN",
			"VONAGE_API_KEY",
		])
	})

	it("pins which providers are inferable at all", async () => {
		const { inferable_channel_providers } = await import("./registry.js")
		// Inference is only as safe as the `ambient` marks are honest, and the cost of a
		// missed mark is a live send on someone else's credentials. So the list is pinned:
		// a new provider joins it deliberately, in a diff someone reads.
		const keys = (channel: (typeof CHANNELS)[number]) =>
			inferable_channel_providers(channel).map((p) => p.key)
		// Expo is absent: its one field is optional, so unmarked it would count as configured
		// on every machine — and EXPO_ACCESS_TOKEN is the name expo-server-sdk users set.
		expect(keys("push")).toEqual(["webpush", "fcm", "apns", "hms"])
		// Twilio is absent from both: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are the
		// Twilio SDK's zero-argument defaults, so anyone using Voice or Verify has them set
		// for reasons unrelated to sending a message. sns is absent for the same reason,
		// and that is the point of the flag. Both lists are belt-and-braces in practice —
		// `infers: false` means neither channel consults them — but a wrong mark here
		// would be invisible until some future policy did.
		expect(keys("whatsapp")).toEqual(["meta"])
		// PureSMS joins it for the same reason: PURESMS_API_KEY is set for nothing else.
		expect(keys("sms")).toEqual(["smsworks", "puresms"])
		// Chat is down to bluesky. SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL, TEAMS_WEBHOOK_URL
		// and TELEGRAM_BOT_TOKEN are what every CI notification action already sets, so a
		// build-notification hook would have made send()'s chat leg post application
		// messages into an ops channel. Bluesky needs a handle *and* an app password, both
		// brand-specific, so it still reads as intent. The definitive path is untouched:
		// a `to` that is a recognisable Slack or Discord webhook URL names its own platform
		// before resolution is reached, and slack()/discord()/teams()/telegram() never
		// resolve at all.
		expect(keys("chat")).toEqual(["bluesky"])
	})
})

describe("hooks narrow on channel (discriminated union)", () => {
	// The documented pattern must *compile* — this test's value is at typecheck time.
	it("the documented narrowing example typechecks and runs", async () => {
		const seen: Array<string> = []
		const hooks: Hooks = {
			before: {
				send: (ctx) => {
					if (ctx.channel === "email") seen.push(`email:${ctx.message.subject}`)
					if (ctx.channel === "sms") seen.push(`sms:${ctx.message.to.join()}`)
					if (ctx.channel === "chat") seen.push(`chat:${ctx.message.to}`)
					if (ctx.channel === "push") seen.push(`push:${ctx.message.message}`)
				},
			},
		}
		configure({ hooks })

		const { default: MockSms } = await import("./sms/mock.js")
		await new MockSms({ default: { country: "GB" } }).send({ to: "07788223344", message: "hi" })
		expect(seen).toEqual(["sms:+447788223344"])
	})

	// A pre-existing email-only hook that replaces the message must keep compiling.
	it("an email replace hook narrows and returns its own shape", async () => {
		const hooks: Hooks = {
			before: {
				send: (ctx) => {
					if (ctx.channel !== "email") return
					const replaced: PreparedMessage = { ...ctx.message, to: "qa@example.com" }
					return replaced
				},
			},
		}
		configure({ hooks })
		const { default: Mock } = await import("./mock.js")
		const mail = new Mock({ default: { from: "f@test.com" } })
		await mail.send({ to: "real@test.com", body: "hi" })
		expect(mail.last?.to).toEqual([{ address: "qa@example.com" }])
	})
})

describe("third-party Transport subclasses get global config hooks", () => {
	class CustomChannel extends Transport<{ ok: true }, { note: string }> {
		protected readonly provider = "custom"
		protected readonly channel = "chat" as Channel
		async post(note: string) {
			return this.with_hooks(
				async () => ({ note }),
				async () => ({ ok: true }) as const
			)
		}
		protected build_request(): RequestSpec {
			throw new Error("unused")
		}
		protected parse_response(): { ok: true } {
			return { ok: true }
		}
	}

	it("runs before.send from postboi.config without any subclass ritual", async () => {
		const seen: Array<string> = []
		configure({
			hooks: { before: { send: (ctx) => void seen.push(ctx.provider) } },
		})
		await new CustomChannel().post("hello")
		expect(seen).toEqual(["custom"])
	})
})

describe("channel base classes are importable from the package root", () => {
	it("exports SmsProvider, ChatProvider and PushProvider", () => {
		expect(SmsProvider).toBeTypeOf("function")
		expect(ChatProvider).toBeTypeOf("function")
		expect(PushProvider).toBeTypeOf("function")
		// The documented 410 check rides the export.
		expect(PushProvider.is_expired(new Error("nope"))).toBe(false)
	})
})

describe("smsworks scheduling", () => {
	it("posts a scheduled single send to /message/schedule, not /message/send", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { messageid: "m1" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new SmsWorks({ api_key: "k", default: { from: "P", country: "GB" } })
		await text.send({ to: "07788223344", message: "hi", scheduled_at: { days: 1 } })
		expect(fetch.mock.calls[0][0]).toBe("https://api.thesmsworks.co.uk/v1/message/schedule")
		expect(JSON.parse(fetch.mock.calls[0][1].body as string).schedule).toBeTruthy()
	})

	it("posts a scheduled multi send to /batch/schedule", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { batchid: "b1" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new SmsWorks({ api_key: "k", default: { from: "P", country: "GB" } })
		await text.send({
			to: ["07788223344", "07700900123"],
			message: "hi",
			scheduled_at: { days: 1 },
		})
		expect(fetch.mock.calls[0][0]).toBe("https://api.thesmsworks.co.uk/v1/batch/schedule")
	})
})

describe("twilio with a messaging service", () => {
	it("sends with no from at all — the service supplies the sender pool", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ body: { sid: "SM1", status: "queued" } }))
		vi.stubGlobal("fetch", fetch)
		const text = new Twilio({
			account_sid: "AC1",
			auth_token: "t",
			messaging_service_sid: "MG123",
		})
		await text.send({ to: "+447788223344", message: "hi" })
		const body = new URLSearchParams(fetch.mock.calls[0][1].body as string)
		expect(body.get("MessagingServiceSid")).toBe("MG123")
		expect(body.get("From")).toBeNull()
	})

	it("still requires a sender without one", async () => {
		vi.stubGlobal("fetch", vi.fn())
		const text = new Twilio({ account_sid: "AC1", auth_token: "t" })
		await expect(text.send({ to: "+447788223344", message: "hi" })).rejects.toMatchObject({
			code: "no_sender",
		})
	})
})

describe("telegram", () => {
	it("reads a default chat id committed to postboi.config", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
		configure({ chat: { provider: "telegram", default: { to: "987654321" } } })
		const fetch = vi
			.fn()
			.mockResolvedValue(respond({ body: { ok: true, result: { message_id: 7 } } }))
		vi.stubGlobal("fetch", fetch)

		await chat({ message: "Deploy finished" })
		expect(JSON.parse(fetch.mock.calls[0][1].body as string).chat_id).toBe("987654321")
		delete process.env.TELEGRAM_BOT_TOKEN
	})

	it("escapes the body under a title instead of feeding it to Markdown", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(respond({ body: { ok: true, result: { message_id: 7 } } }))
		vi.stubGlobal("fetch", fetch)
		const bot = new Telegram({ bot_token: "t" })
		await bot.send({
			to: "1",
			title: "Deploy <ok>",
			message: "migrated table user_accounts & friends",
		})

		const body = JSON.parse(fetch.mock.calls[0][1].body as string)
		expect(body.parse_mode).toBe("HTML")
		expect(body.text).toBe("<b>Deploy &lt;ok&gt;</b>\nmigrated table user_accounts &amp; friends")
	})
})

describe("webpush success handling", () => {
	const SUBSCRIPTION = {
		endpoint: "https://push.example.net/send/abc",
		keys: {
			p256dh:
				"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
			auth: "BTBZMqHH6r4Tts7J_aSIgg",
		},
	}

	it("does not throw on a 201 that carries a text body", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(respond({ status: 201, body: "Created", url: SUBSCRIPTION.endpoint }))
		)
		const notify = new WebPush({
			public_key:
				"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
			private_key: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
			subject: "mailto:a@b.c",
		})
		await expect(notify.send({ to: SUBSCRIPTION, message: "hi" })).resolves.toMatchObject({
			ok: true,
		})
	})
})

describe("phone numbers with a printed (0)", () => {
	it("drops the bracketed trunk zero from international form", () => {
		expect(to_e164("+44 (0) 7788 223344")).toBe("+447788223344")
		expect(to_e164("+44 (0)7788 223344")).toBe("+447788223344")
	})

	it("still treats real bracketed digits as digits", () => {
		// "(020) 7946 0958" is area-code formatting, not the (0) convention.
		expect(to_e164("(020) 7946 0958", "GB")).toBe("+442079460958")
	})
})

describe("discord truncation", () => {
	it("counts code points, so emoji content is not needlessly cut", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ status: 204 }))
		vi.stubGlobal("fetch", fetch)
		// 1500 emoji = 3000 UTF-16 units but only 1500 of Discord's 2000 code points.
		await new Discord({ webhook_url: "https://h.test/x" }).send({ message: "😀".repeat(1500) })
		const content = JSON.parse(fetch.mock.calls[0][1].body as string).content
		expect(Array.from(content)).toHaveLength(1500)
	})

	it("never splits a surrogate pair at the cut", async () => {
		const fetch = vi.fn().mockResolvedValue(respond({ status: 204 }))
		vi.stubGlobal("fetch", fetch)
		await new Discord({ webhook_url: "https://h.test/x" }).send({ message: "😀".repeat(2100) })
		const content = JSON.parse(fetch.mock.calls[0][1].body as string).content
		const points = Array.from(content) as Array<string>
		expect(points).toHaveLength(2000)
		expect(points.at(-1)).toBe("…")
		// Every remaining point is a whole emoji or the ellipsis — no lone surrogates.
		expect(content.includes("�")).toBe(false)
		for (const point of points.slice(0, -1)) expect(point).toBe("😀")
	})
})

describe("fcm token cache", () => {
	const KEY_PEM = "" // filled per test — the exchange is mocked before signing matters

	it("concurrent cold sends share one token exchange", async () => {
		let oauth_calls = 0
		const fetch = vi.fn(async (url: string) => {
			if (url.includes("oauth2.googleapis.com")) {
				oauth_calls++
				// Slow enough that both sends are in flight before it resolves.
				await new Promise((r) => setTimeout(r, 20))
				return respond({ body: { access_token: "tok", expires_in: 3600 } })
			}
			return respond({ body: { name: "projects/p/messages/1" } })
		})
		vi.stubGlobal("fetch", fetch)

		// A real PKCS8 sign needs a real key; stub the crypto sign path via a spy instead.
		const import_spy = vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey)
		const sign_spy = vi.spyOn(crypto.subtle, "sign").mockResolvedValue(new ArrayBuffer(8))

		const notify = new FCM({
			project_id: "p",
			client_email: `svc-${Date.now()}@test.iam`,
			private_key: KEY_PEM,
		})
		await Promise.all([
			notify.send({ to: "tok-1", message: "hi" }),
			notify.send({ to: "tok-2", message: "hi" }),
		])

		expect(oauth_calls).toBe(1)
		import_spy.mockRestore()
		sign_spy.mockRestore()
	})
})
