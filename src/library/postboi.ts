// Pull the generated-types placeholder into the compile graph: its `.d.ts` is what
// `bunx postboi sync` overwrites in node_modules to narrow `from` (a no-op at runtime).
import "./register.js"
// Re-export the core so `import { PostboiError, SkipSendError, ... } from "postboi"` keeps working
// from the package root.
export * from "./index.js"
// The zero-config `mail()`/`cancel()` and provider dispatch are general (not Postboi-specific)
// but belong on the package root, so re-export them here.
export { mail, cancel } from "./mail.js"
// The zero-config `sms()` — same shape as `mail()`, on the SMS channel.
export { sms } from "./sms/send.js"
// The chat channel's per-platform functions. There's deliberately no generic `chat()`
// export: you always know which platform you're posting to, so the platform is the name.
// The channel-generic resolver still exists internally as `send()`'s chat leg.
export { slack, discord, teams, telegram } from "./chat/send.js"
// The zero-config `push()` — Web Push and FCM.
export { push } from "./push/send.js"
// The zero-config `whatsapp()` — Twilio or Meta's Cloud API.
export { whatsapp } from "./whatsapp/send.js"
// The channel base classes, so the documented `PushProvider.is_expired()` works and third
// parties can implement their own providers on any channel — the root already exports
// `Transport` for exactly that, and a base you can't import is an invitation you can't take.
export { SmsProvider } from "./sms/provider.js"
export { ChatProvider } from "./chat/provider.js"
export { PushProvider } from "./push/provider.js"
export { WhatsappProvider } from "./whatsapp/provider.js"
// The multi-channel fan-out. Runs in your process — only transport is ever ours.
export {
	send,
	type FanOutOptions,
	type Recipients,
	type SendResult,
	type ChannelResult,
} from "./send.js"

// The Postboi provider itself lives in its own leaf module — `mail()`'s registry loads it
// with a dynamic import, and a module that is both statically imported (this root, via
// `postboi/kit`) and dynamically imported gets merged into the consumer's entry chunk by
// rollup/rolldown, which then re-exports it from that entry. SvelteKit rejects the extra
// export on route entries ("Invalid export"). Keep the dynamic target a leaf.
export { default } from "./postboi_provider.js"
export type {
	PostboiOptions,
	SendParams,
	MessageDetails,
	ListSummary,
	ListRecipient,
	RecipientStatus,
	ListDetails,
	NewListRecipient,
	ListRecipientInput,
	MembershipStatus,
	Contact,
	Membership,
	ContactDetails,
	ContactInput,
	Suppression,
	BroadcastOptions,
	BroadcastResponse,
	NotificationScheduleInput,
	NotificationSchedule,
	NotificationOptions,
	NotificationDetails,
	ConfirmationSettings,
	ListConfirmationInput,
	ListChanges,
} from "./postboi_provider.js"
