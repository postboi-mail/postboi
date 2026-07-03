import { mail } from "postboi/kit"

// The whole backend. `mail` reads the submitted FormData, sends it via the provider
// configured in postboi.config.ts, and returns `{ success: true }` — or
// `fail(400, { error })` on failure.
export const actions = { default: mail }
