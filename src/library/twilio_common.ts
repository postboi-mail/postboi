/**
 * The Twilio plumbing shared by the SMS and WhatsApp providers: auth header, Message
 * endpoint, and the success/error payload shapes. One copy on purpose — a change to
 * Twilio's error shape fixed only on the SMS side would leave WhatsApp surfacing raw
 * provider payloads.
 *
 * Internal: not part of the public surface.
 */
import type { ProviderError, RejectionReason } from "./errors.js"

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
 * Twilio's error codes, by what they say about the refusal — from its error dictionary,
 * https://www.twilio.com/docs/api/errors. A code that isn't here is left to the HTTP status,
 * which makes most of them `request`: a refusal nobody else would answer differently.
 */
const REASONS: Record<number, RejectionReason> = {
	20003: "auth", // Permission denied
	20429: "rate_limited", // Too many requests
	21211: "recipient", // Invalid 'To' phone number
	21614: "recipient", // 'To' is not a valid mobile number
	21610: "compliance", // The recipient replied STOP
	21212: "sender", // Invalid 'From' phone number
	21606: "sender", // The 'From' number is not a valid, SMS-capable number for this account
	21612: "sender", // The 'To' number is not reachable from this 'From' number
	21659: "sender", // The 'From' is not a Twilio number or verified caller ID
	21660: "sender", // Mismatch between the 'From' number and the account
	21703: "sender", // The Messaging Service has no phone numbers to send from
	21408: "account", // Permission to send to this region is not enabled
	21608: "account", // A trial account can only send to verified numbers
}

/**
 * Recognise Twilio's error payload — `{ code, message, more_info, status }`; a success
 * carries `sid`. Returns undefined to fall back to HTTP status handling.
 */
export function twilio_parse_error(data: unknown): ProviderError | undefined {
	if (data === null || typeof data !== "object") return undefined
	const e = data as Record<string, unknown>
	if (typeof e.message === "string" && !("sid" in e)) {
		const code = e.code as string | number | undefined
		return { message: e.message, code, reason: REASONS[Number(code)] }
	}
	return undefined
}
