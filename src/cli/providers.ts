// The provider registry is shared with the library so the CLI and the zero-config `send()`
// can never drift. The CLI keeps the prompt-only extras (default fields, usage snippet).
export {
	PROVIDERS,
	find_provider,
	type ProviderMeta,
	type ProviderField,
} from "../library/registry.js"
import type { ProviderMeta } from "../library/registry.js"

/** Alias kept for the CLI's existing call sites. */
export type CliProvider = ProviderMeta

/**
 * Optional default fields. Stored as `POSTBOI_*` env vars so they're shared between an
 * explicit provider (`default: {...}`) and the zero-config `send()` (which reads them).
 */
export const DEFAULT_FIELDS: Array<{ arg: string; env: string; label: string }> = [
	{ arg: "from", env: "POSTBOI_FROM", label: "Default from" },
	{ arg: "to", env: "POSTBOI_TO", label: "Default to" },
	{ arg: "reply_to", env: "POSTBOI_REPLY_TO", label: "Default reply-to" },
	{ arg: "cc", env: "POSTBOI_CC", label: "Default cc" },
	{ arg: "bcc", env: "POSTBOI_BCC", label: "Default bcc" },
]

/** Build the example `new Provider({...})` snippet, optionally with a `default` block. */
export function usage_snippet(
	provider: ProviderMeta,
	defaults: Array<{ arg: string; env: string }> = []
): string {
	const lines = provider.fields.map((f) => `\t${f.arg}: process.env.${f.env},`)
	if (defaults.length > 0) {
		lines.push("\tdefault: {")
		for (const d of defaults) lines.push(`\t\t${d.arg}: process.env.${d.env},`)
		lines.push("\t},")
	}
	return [
		`import ${provider.class} from "${provider.import}"`,
		"",
		`const mail = new ${provider.class}({`,
		...lines,
		`})`,
	].join("\n")
}
