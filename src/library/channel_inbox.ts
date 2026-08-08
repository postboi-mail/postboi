/**
 * The bridge between the channel mocks and the local dev inbox: normalise a capture into
 * the inbox's mail-ish shape and hand it over. Wired in by the dev-interception paths
 * (`sms()`, `whatsapp()`) and the unconfigured-in-development fallback (`slack()` and
 * friends, `push()`), never by a mock a test constructed itself.
 *
 * Internal: not part of the public surface.
 */
import { resolve_inbox, type ChannelCapture } from "./inbox.js"
import type { Channel } from "./errors.js"
import type { SentSms } from "./sms/mock.js"
import type { SentWhatsapp } from "./whatsapp/mock.js"
import type { SentChat } from "./chat/mock.js"
import type { SentPush } from "./push/mock.js"

type NonEmail = Exclude<Channel, "email">

const CHANNEL_NOUN: Record<NonEmail, string> = {
	sms: "texts",
	whatsapp: "WhatsApp messages",
	chat: "chat messages",
	push: "notifications",
}

const announced = new Set<NonEmail>()

/**
 * Per-channel capture → inbox-shape normalisers. A map checked with `satisfies` so adding
 * a channel without teaching the inbox about it is a compile error, not a capture quietly
 * rendered as a push notification with the wrong fields.
 */
const NORMALISERS = {
	sms(captured: unknown): ChannelCapture {
		const sms = captured as SentSms
		return {
			channel: "sms",
			to: sms.to.map((address) => ({ address })),
			from: sms.from ? { address: sms.from } : undefined,
			text: sms.message,
			meta: [
				[
					"Segments",
					`${sms.segments.count} × ${sms.segments.encoding} (${sms.segments.units} units)`,
				],
			],
			scheduled_at: sms.scheduled_at,
		}
	},
	whatsapp(captured: unknown): ChannelCapture {
		const wa = captured as SentWhatsapp
		const meta: Array<[string, string]> = []
		if (wa.template) meta.push(["Template", wa.template], ["Language", wa.language])
		if (wa.variables) meta.push(["Variables", JSON.stringify(wa.variables)])
		return {
			channel: "whatsapp",
			to: [{ address: wa.to }],
			from: wa.from ? { address: wa.from } : undefined,
			subject: wa.template ? `Template: ${wa.template}` : undefined,
			text: wa.message,
			meta,
		}
	},
	chat(captured: unknown): ChannelCapture {
		const chat = captured as SentChat
		return {
			channel: "chat",
			to: [{ address: chat.to }],
			subject: chat.title,
			text: chat.message,
			meta: chat.username ? [["Posts as", chat.username]] : [],
		}
	},
	push(captured: unknown): ChannelCapture {
		const push = captured as SentPush
		const meta: Array<[string, string]> = []
		if (push.url) meta.push(["Opens", push.url])
		if (push.data) meta.push(["Data", JSON.stringify(push.data)])
		return {
			channel: "push",
			to: [{ address: push.to }],
			subject: push.title,
			text: push.message,
			meta,
		}
	},
} satisfies Record<NonEmail, (captured: unknown) => ChannelCapture>

/**
 * A {@link MockRecorderOptions.sink} for one channel: deliver each capture to a running
 * dev inbox, announcing where to read it the first time one is taken. Resolves false
 * when no inbox is listening, which sends the mock back to the console.
 */
export function inbox_sink(channel: Channel): (captured: unknown) => Promise<boolean> {
	// The resolver never routes email here, but `Channel` keeps the call sites honest.
	const chan = channel as NonEmail
	return async function deliver(captured: unknown): Promise<boolean> {
		const inbox = await resolve_inbox()
		if (!inbox) return false
		const taken = await inbox.capture(NORMALISERS[chan](captured))
		if (taken && !announced.has(chan)) {
			announced.add(chan)
			console.log(
				`postboi: capturing ${CHANNEL_NOUN[chan]} in the dev inbox — read them at ${inbox.url}`
			)
		}
		return taken
	}
}
