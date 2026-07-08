import { PostboiError } from "../index.js"
import { WebhookVerificationError } from "./errors.js"
import { timing_safe_equal, svix_verify } from "./crypto.js"
import { parse_user_agent, type EmailClient } from "./ua.js"
import type { VerifyContext } from "./index.js"

/** Parse a JSON body, throwing a normalized `invalid_payload` error on garbage. */
export function parse_json(provider: string, body: string): unknown {
	try {
		return JSON.parse(body)
	} catch {
		throw new PostboiError({
			provider,
			message: `${provider} webhook payload is not valid JSON`,
			code: "invalid_payload",
			raw: body,
		})
	}
}

/**
 * Shared-secret verification for providers without native webhook signing (Postmark,
 * Brevo, Mailjet, SES→SNS, …). The secret travels with the request — a `?token=` query
 * parameter, the `Authorization` header (raw, `Bearer` or basic-auth password), or any
 * extra provider-specific header — and is compared timing-safe.
 */
export function shared_secret_verify(
	provider: string,
	ctx: VerifyContext,
	extra_headers: Array<string> = []
): void {
	if (!ctx.secret) {
		throw new WebhookVerificationError({
			provider,
			message: `No webhook secret configured for ${provider}. Set ${provider.toUpperCase()}_WEBHOOK_SECRET (and put the same token in the provider's webhook URL as ?token=…), or pass { secret }. Use { verify: false } to explicitly skip verification.`,
			code: "missing_secret",
		})
	}

	const candidates: Array<string> = []
	const token = ctx.url.searchParams.get("token")
	if (token) candidates.push(token)

	const authorization = ctx.headers.get("authorization")
	if (authorization) {
		candidates.push(authorization)
		const [scheme, value] = authorization.split(" ")
		if (value && /^bearer$/i.test(scheme)) candidates.push(value)
		if (value && /^basic$/i.test(scheme)) {
			try {
				// Providers that only offer basic auth put the token in the password slot.
				const decoded = atob(value)
				candidates.push(decoded, decoded.slice(decoded.indexOf(":") + 1))
			} catch {
				// not base64 — ignore
			}
		}
	}

	for (const name of extra_headers) {
		const value = ctx.headers.get(name)
		if (value) candidates.push(value)
	}

	if (!candidates.some((candidate) => timing_safe_equal(candidate, ctx.secret!))) {
		throw new WebhookVerificationError({
			provider,
			message: `${provider} webhook token did not match`,
			code: "invalid_signature",
		})
	}
}

/**
 * Svix / standard-webhooks verification shared by Resend (`svix-*` headers) and the
 * Postboi provider (`webhook-*` headers — the same scheme). Throws on any failure.
 */
export async function svix_adapter_verify(
	provider: string,
	ctx: VerifyContext,
	header_prefix: "svix" | "webhook"
): Promise<void> {
	if (!ctx.secret) {
		throw new WebhookVerificationError({
			provider,
			message: `No webhook secret configured for ${provider}. Set ${provider.toUpperCase()}_WEBHOOK_SECRET (the whsec_… signing secret) or pass { secret }.`,
			code: "missing_secret",
		})
	}
	const id = ctx.headers.get(`${header_prefix}-id`)
	const timestamp = ctx.headers.get(`${header_prefix}-timestamp`)
	const signatures = ctx.headers.get(`${header_prefix}-signature`)
	if (!id || !timestamp || !signatures) {
		throw new WebhookVerificationError({
			provider,
			message: `${provider} webhook is missing its ${header_prefix}-* signature headers`,
			code: "invalid_signature",
		})
	}
	const verdict = await svix_verify({
		secret: ctx.secret,
		id,
		timestamp,
		body: ctx.body,
		signatures,
	})
	if (verdict === "stale_timestamp") {
		throw new WebhookVerificationError({
			provider,
			message: `${provider} webhook timestamp is outside the accepted tolerance (replay protection)`,
			code: "stale_timestamp",
		})
	}
	if (verdict !== "ok") {
		throw new WebhookVerificationError({
			provider,
			message: `${provider} webhook signature did not match`,
			code: "invalid_signature",
		})
	}
}

/** Build the `client`/`ip` engagement fields from a raw user-agent and address. */
export function engagement(
	user_agent: string | undefined | null,
	ip: string | undefined | null
): { client?: EmailClient; ip?: string } {
	return {
		client: parse_user_agent(user_agent),
		ip: ip ?? undefined,
	}
}

/** Parse a provider timestamp — unix seconds, unix millis or ISO 8601 — into a Date. */
export function to_date(value: unknown): Date | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value === "number") {
		// Heuristic: values before ~2001-09 in millis are unix seconds.
		return new Date(value < 1e12 ? value * 1000 : value)
	}
	if (typeof value === "string") {
		const numeric = Number(value)
		if (Number.isFinite(numeric) && value.trim() !== "") return to_date(numeric)
		const date = new Date(value)
		return Number.isNaN(date.getTime()) ? undefined : date
	}
	return undefined
}

/** The SNS envelope SES (and Scaleway's SNS-compatible topics) deliver events in. */
export interface SnsEnvelope {
	Type: string
	Message?: string
	SubscribeURL?: string
	TopicArn?: string
}

/** Detect an SNS envelope (SES / Scaleway wrap their events in one). */
export function sns_envelope(payload: unknown): SnsEnvelope | undefined {
	if (payload === null || typeof payload !== "object") return undefined
	const e = payload as Record<string, unknown>
	if (typeof e.Type !== "string") return undefined
	return e as unknown as SnsEnvelope
}

/**
 * The subscribe URL of an SNS `SubscriptionConfirmation`, validated to point at AWS
 * (or the caller's expected host) so a forged payload can't make us GET anywhere.
 */
export function sns_subscribe_url(envelope: SnsEnvelope): string | undefined {
	if (envelope.Type !== "SubscriptionConfirmation" || !envelope.SubscribeURL) return undefined
	const url = new URL(envelope.SubscribeURL)
	if (url.protocol !== "https:" || !url.hostname.endsWith(".amazonaws.com")) return undefined
	return url.href
}
