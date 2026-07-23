// Pull the generated-types placeholder into the compile graph: its `.d.ts` is what
// `bunx postboi sync` overwrites in node_modules to narrow `from` (a no-op at runtime).
import "./register.js"
// Re-export the core so `import { PostboiError, SkipSendError, ... } from "postboi"` keeps working
// from the package root.
export * from "./index.js"
// The zero-config `mail()`/`cancel()` and provider dispatch are general (not Postboi-specific)
// but belong on the package root, so re-export them here.
export { mail, cancel } from "./mail.js"

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
