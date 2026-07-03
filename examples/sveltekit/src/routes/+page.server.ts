import Resend from "postboi/resend"
import { action } from "postboi/kit"
import { RESEND_API_KEY, EMAIL_FROM, EMAIL_TO } from "$env/static/private"

// Build a provider instance once. `default.from` is applied to every send.
const mail = new Resend({ api_key: RESEND_API_KEY, default: { from: EMAIL_FROM } })

// `action()` reads the submitted FormData, sends it, and returns `{ success: true }`
// — or `fail(status, { error })` on failure. `fields` are merged into every send, so
// the notification always lands in your inbox.
export const actions = {
	default: action(mail, { status: 422, fields: { to: EMAIL_TO } }),
}
