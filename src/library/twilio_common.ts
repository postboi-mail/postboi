/**
 * The Twilio plumbing shared by the SMS and WhatsApp providers: auth header, Message
 * endpoint, and the success/error payload shapes. One copy on purpose — a change to
 * Twilio's error shape fixed only on the SMS side would leave WhatsApp surfacing raw
 * provider payloads.
 *
 * Internal: not part of the public surface.
 */
import type { ProviderError } from "./errors.js"

/** The `{ sid, status }` both Twilio providers resolve with. */
export type TwilioSendResponse = { sid: string; status: string }

/** Basic-auth `Authorization` header value for the account. */
export function twilio_auth(account_sid: string, auth_token: string): string {
	return `Basic ${Buffer.from(`${account_sid}:${auth_token}`).toString("base64")}`
}

/** The Message resource endpoint — pass `id` for a single message's resource. */
export function twilio_messages_url(account_sid: string, id?: string): string {
	const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account_sid)}`
	return id ? `${base}/Messages/${encodeURIComponent(id)}.json` : `${base}/Messages.json`
}

/** Read Twilio's success payload. */
export function twilio_parse_response(data: unknown): TwilioSendResponse {
	const d = data as Record<string, unknown> | null
	return { sid: (d?.sid as string) ?? "", status: (d?.status as string) ?? "queued" }
}

/**
 * Recognise Twilio's error payload — `{ code, message, more_info, status }`; a success
 * carries `sid`. Returns undefined to fall back to HTTP status handling.
 */
export function twilio_parse_error(data: unknown): ProviderError | undefined {
	if (data === null || typeof data !== "object") return undefined
	const e = data as Record<string, unknown>
	if (typeof e.message === "string" && !("sid" in e)) {
		return { message: e.message, code: e.code as string | number | undefined }
	}
	return undefined
}
