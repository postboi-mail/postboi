/**
 * `postboi/kit` as SvelteKit sees it. Vite resolves the package's `svelte` condition to this
 * module, which hands `$app/server` to the rest of the kit and then re-exports it.
 *
 * Everything else resolves `postboi/kit` to kit_base.ts, which never imports `$app/server`.
 * That's what lets `bun test` (or plain Node) import `action` without mocking a module only
 * SvelteKit can provide. There `remote()` says it needs SvelteKit, and nothing else changes.
 */
import { form, getRequestEvent } from "$app/server"
import { sveltekit } from "./mail.js"

sveltekit.form = form
sveltekit.request = getRequestEvent

export * from "./kit_base.js"
