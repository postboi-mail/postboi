"use server"

import { mail } from "postboi"

// The form carries `_subject` and `_reply_to` (mirrored from the email) as hidden fields,
// so the whole submission is just handed to postboi as the body.
export async function submit(_prev: unknown, body: FormData) {
	await mail({ body })
	return { ok: true }
}
