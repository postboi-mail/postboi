/**
 * The zero-config remote mail form (SvelteKit remote functions, experimental).
 *
 * This file is a `.remote.ts` module — SvelteKit turns its exports into remote
 * functions in the consuming app. Enable `kit.experimental.remoteFunctions` in the
 * app's config, then the whole contact form is one import and a spread:
 *
 * ```svelte
 * <script>
 * 	import { mail } from "postboi/remote"
 * 	import Captcha from "postboi/svelte"
 * </script>
 *
 * <form {...mail}>
 * 	<Captcha />
 * 	<input {...mail.fields.contact.name.as("text")} required />
 * 	<input {...mail.fields.contact.email.as("email")} required />
 * 	<textarea {...mail.fields.details.message.as("text")}></textarea>
 * 	<button disabled={!!mail.pending}>Send</button>
 * </form>
 *
 * {#if mail.result?.success}<p>Thanks — we'll be in touch!</p>{/if}
 * ```
 *
 * No `+page.server.ts`, no action, no endpoint. It sends via whichever provider
 * `POSTBOI_PROVIDER` names (set by `bunx postboi init`), with progressive enhancement
 * and spam protection intact. Field nesting (`contact.name`) renders in the email
 * exactly like the classic `contact→name` grouping. For a custom provider or forced
 * fields, build your own with `remote(...)` from `postboi/kit`.
 */
import { remote } from "./kit.js"

export const mail = remote()
