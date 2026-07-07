import { ensure_env_loaded, read_env } from "./env.js"

/**
 * Invisible spam protection for FormData bodies. Two independent layers, both checked in
 * `prepare_send` before anything is rendered or sent:
 *
 * - **Honeypot** (zero config, always on): a hidden `🍯` field humans never see. Present and
 *   empty → human; filled → bot, and the send is skipped.
 * - **Cloudflare Turnstile** (one env var): when a secret key is configured, the
 *   `cf-turnstile-response` token the widget injects into the form is verified server-side
 *   before every FormData send.
 *
 * This module is deliberately standalone (no import of index.ts) so it can't create an
 * import cycle — ProviderBase maps the returned verdict onto the error classes.
 */

/** The default honeypot field name. Sweet, self-documenting, and no bot expects it. */
export const HONEYPOT_FIELD = "🍯"

/** The hidden input the Turnstile widget injects into its form. */
export const TURNSTILE_FIELD = "cf-turnstile-response"

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/** Spam-protection settings, configurable globally, per provider instance, or per send. */
export type CaptchaOptions = {
	/**
	 * Honeypot field name checked in FormData bodies. Defaults to `"🍯"` — add a visually
	 * hidden input with that name to your form and any submission that fills it is treated
	 * as spam (skipped, never sent). Pass a string to use a different field name, or `false`
	 * to disable the check.
	 */
	honeypot?: string | false
	/**
	 * Cloudflare Turnstile verification. Defaults to auto: enforced whenever a secret key is
	 * available (the `TURNSTILE_SECRET_KEY` env var). Pass `{ secret_key }` to provide the
	 * secret explicitly (required on runtimes without ambient env vars, e.g. Cloudflare
	 * Workers), `true` to require verification (erroring if no secret is configured), or
	 * `false` to disable it for a send even when a secret is set.
	 */
	turnstile?: { secret_key?: string } | boolean
}

/**
 * The outcome of {@link check_captcha}: pass, or a code + message for the caller to throw.
 * On a `managed` pass, `token` carries the (stripped) Turnstile token so the caller can
 * forward it to Postboi Cloud for server-side verification.
 */
export type CaptchaVerdict =
	| { ok: true; token?: string; managed?: boolean }
	| { ok: false; code: "spam" | "captcha_failed" | "captcha_misconfigured"; message: string }

/** The subset of the Turnstile siteverify response we act on. */
type SiteverifyResponse = { success?: boolean; "error-codes"?: Array<string> }

/**
 * Run the spam checks over a FormData body. Always strips the honeypot and Turnstile fields
 * from `form` (they are plumbing, never email content), then verdicts:
 *
 * - honeypot filled → `spam`
 * - Turnstile enforced but the token is missing/invalid/unverifiable → `captcha_failed`
 *   (verification fails closed — an unreachable verifier must not wave submissions through)
 * - a token arrived but no secret is configured → `captcha_misconfigured`
 *
 * With `managed` (the Postboi Cloud provider) and no local secret, nothing is verified
 * here: the token is returned on the verdict instead, to ride along with the send for
 * server-side verification against the account's managed widget.
 */
export async function check_captcha(
	form: FormData,
	options: CaptchaOptions = {},
	managed = false
): Promise<CaptchaVerdict> {
	if (options.honeypot !== false) {
		const name = options.honeypot ?? HONEYPOT_FIELD
		const value = form.get(name)
		form.delete(name)
		if (typeof value === "string" && value.trim() !== "") {
			return {
				ok: false,
				code: "spam",
				message: "Submission flagged as spam: the honeypot field was filled.",
			}
		}
	}

	const raw_token = form.get(TURNSTILE_FIELD)
	form.delete(TURNSTILE_FIELD)
	const token = typeof raw_token === "string" && raw_token ? raw_token : undefined

	if (options.turnstile === false) return { ok: true }

	// Make `.env` values visible in dev (SvelteKit etc. don't put them on process.env).
	await ensure_env_loaded()
	const explicit = typeof options.turnstile === "object" ? options.turnstile.secret_key : undefined
	const secret = explicit ?? read_env("TURNSTILE_SECRET_KEY")

	// Managed captcha: no local secret needed — a BYO secret (above) still wins when set.
	if (!secret && managed) return { ok: true, token, managed: true }

	// No secret, no token, not forced on — Turnstile isn't in play for this send.
	if (!secret && !token && options.turnstile !== true) return { ok: true }

	if (!secret) {
		return {
			ok: false,
			code: "captcha_misconfigured",
			message:
				"Turnstile verification is expected but no secret key is configured — set TURNSTILE_SECRET_KEY, pass captcha: { turnstile: { secret_key } }, or send via Postboi Cloud for managed captcha.",
		}
	}
	if (!token) {
		return {
			ok: false,
			code: "captcha_failed",
			message:
				"Captcha verification failed: the form was submitted without a Turnstile token (cf-turnstile-response).",
		}
	}

	try {
		const response = await fetch(TURNSTILE_VERIFY_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret, response: token }),
		})
		const data = (await response.json()) as SiteverifyResponse
		if (data.success === true) return { ok: true }
		const codes = data["error-codes"] ?? []
		return {
			ok: false,
			code: "captcha_failed",
			message: `Captcha verification failed${codes.length > 0 ? ` (${codes.join(", ")})` : ""}.`,
		}
	} catch (error) {
		return {
			ok: false,
			code: "captcha_failed",
			message: `Captcha verification could not be completed: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}
