import { PushProvider, type PreparedPush, type PushProviderOptions } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"

/** Options for the Expo provider constructor. */
type Options = PushProviderOptions & {
	/**
	 * An Expo access token, only needed once **Enhanced Security for Push Notifications**
	 * is switched on for the project in the Expo dashboard. Off (the default for every
	 * project), the push service takes any request carrying a valid token for the
	 * project — so this is the one push provider that can run on no credential at all.
	 */
	access_token?: string
}

type SendResponse = { id: string }

/** What one push receipt says. Same shape as a failed send, so `push.expired()` reads it. */
export type PushReceipt = { ok: true } | { ok: false; error: PostboiError }

/** The Expo push service's shape for one ticket or receipt. */
type Outcome = {
	status?: "ok" | "error"
	id?: string
	message?: string
	details?: { error?: string }
}

const SEND_URL = "https://exp.host/--/api/v2/push/send"
const RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"

/** Expo's documented ceiling for what it forwards to Apple and Google. */
const MAX_PAYLOAD_BYTES = 4096

/** Expo's documented ceiling for one receipts request. */
const MAX_RECEIPTS = 1000

/**
 * The two spellings of an Expo push token, and the one wall between them and an FCM or
 * APNs token: those belong to `postboi/fcm` and `postboi/apns`, and Expo rejects them
 * with a generic "not a valid Expo push token" that doesn't say which provider wanted it.
 */
const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[^\]]+\]$/

/** The ticket and receipt errors that mean "this device is gone, delete your copy". */
const DEAD_TOKEN = "DeviceNotRegistered"

/** A request-level refusal — the whole request, not one notification in it. */
type RequestError = { code?: string; message?: string }

/**
 * Expo's push service — https://docs.expo.dev/push-notifications/sending-notifications/
 *
 * The route to an Expo or React Native app that doesn't want Firebase or an Apple key on
 * the server: the app registers with `subscribe()` from `postboi/push/expo`, hands back an
 * `ExponentPushToken[…]`, and Expo forwards to FCM and APNs with the credentials it holds
 * for the project. One provider for both platforms, and no credential here at all unless
 * the project has enhanced security switched on.
 *
 * Two things to know. A 200 is a **ticket**, not a delivery: Expo has accepted the message
 * and will pass it on, and the real outcome — including the `DeviceNotRegistered` that
 * `push.expired()` watches for — often only shows up in the **receipt** Expo keeps for a
 * day afterwards, which {@link receipts} fetches. And the ticket can still say the device
 * is gone, when Expo already knows, so both are read for it.
 *
 * @example
 * ```ts
 * import Expo from "postboi/expo"
 *
 * const notify = new Expo()
 * const { id } = await notify.send({ to: token, title: "Order shipped", message: "On its way" })
 *
 * // Later — a day at most — ask what became of it.
 * const [receipt] = Object.values(await notify.receipts([id]))
 * if (!receipt.ok && Expo.is_expired(receipt.error)) forget_token(token)
 * ```
 */
export default class Expo extends PushProvider<SendResponse> {
	protected readonly provider = "expo"
	#access_token: string | undefined

	constructor({ access_token, ...options }: Options = {}) {
		super(options)
		// The registry hands an empty string through for the optional field; that's no
		// token, not a token that happens to be empty.
		this.#access_token = access_token || undefined
	}

	#headers(): Record<string, string> {
		return {
			Accept: "application/json",
			"Content-Type": "application/json",
			...(this.#access_token ? { Authorization: `Bearer ${this.#access_token}` } : {}),
		}
	}

	protected async build_request(message: PreparedPush): Promise<RequestSpec> {
		if (typeof message.to !== "string") {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "invalid_target",
				message:
					"Expo needs an Expo push token, not a Web Push subscription object. A subscription belongs to postboi/webpush.",
			})
		}
		if (!EXPO_TOKEN.test(message.to)) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				code: "invalid_target",
				message: `Expo push tokens look like ExponentPushToken[…]; got ${JSON.stringify(message.to.slice(0, 24))}…. A raw FCM or APNs device token belongs to postboi/fcm or postboi/apns, or drop { native: true } from the app's subscribe() to get an Expo token.`,
			})
		}

		const payload = {
			title: message.title,
			body: message.message,
			// Expo delivers `data` as-is to the app, so the click target rides inside it
			// where the Web Push worker and the FCM provider put it too.
			data: { ...message.data, ...(message.url ? { url: message.url } : {}) },
			ttl: message.ttl,
			// Expo's default is each platform's own ("normal" on Android, "active" on
			// iOS), which is what the caller meant by normal. Only high needs saying.
			...(message.urgency === "high" ? { priority: "high" } : {}),
			// iOS only, and ignored elsewhere: an alert without a sound is one the phone
			// shows silently, which is rarely what a push was sent for.
			sound: "default",
		}

		// The token isn't forwarded to Apple or Google, so it doesn't count toward the limit —
		// and the payload is serialized once, with the token spliced in front of it.
		const json = JSON.stringify(payload)
		this.check_payload(json, MAX_PAYLOAD_BYTES, "Expo accepts")

		return {
			url: SEND_URL,
			headers: this.#headers(),
			body: `{"to":${JSON.stringify(message.to)},${json.slice(1)}`,
		}
	}

	/**
	 * The one ticket a single-message send comes back with. Expo mirrors the request's
	 * shape — one message object gets one ticket object, an array gets an array — and
	 * this sends the former, but both are read so the answer's shape can never hide it.
	 */
	#ticket(data: unknown): Outcome | undefined {
		const tickets = (data as { data?: Outcome | Array<Outcome> } | null)?.data
		if (Array.isArray(tickets)) return tickets[0]
		return tickets && typeof tickets === "object" ? tickets : undefined
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		return { id: this.#ticket(data)?.id ?? "" }
	}

	/** The request-level refusal in a response body, if that's what it carries. */
	#request_error(response: Response, data: unknown): ProviderError | undefined {
		const errors = (data as { errors?: Array<RequestError> } | null)?.errors
		const first = Array.isArray(errors) ? errors[0] : undefined
		if (!first) return undefined
		return {
			message: `Expo rejected the request: ${first.message ?? first.code ?? response.status}`,
			code: first.code,
		}
	}

	protected parse_error(response: Response, data: unknown): ProviderError | undefined {
		// Request-level: the whole batch was refused (rate limit, bad token, wrong project).
		const refused = this.#request_error(response, data)
		if (refused) return refused
		// Ticket-level: the request was fine, this notification wasn't. A 200 with an error
		// ticket is how Expo says so, so the status can't be the answer.
		const ticket = this.#ticket(data)
		if (ticket?.status === "error") return this.#outcome_error(ticket)
		if (response.ok && !ticket) {
			return { message: "Expo returned no ticket, so the response was not from the push service." }
		}
		return undefined
	}

	/** Normalize a failed ticket or receipt: the dead-device case becomes the expiry code. */
	#outcome_error(outcome: Outcome): ProviderError {
		const reason = outcome.details?.error
		if (reason === DEAD_TOKEN) {
			return {
				message: `Expo says the device is no longer registered (${DEAD_TOKEN}). Delete your stored copy. See PushProvider.is_expired().`,
				code: "expired_subscription",
			}
		}
		return {
			message: `Expo could not deliver the notification: ${outcome.message ?? reason ?? "unknown error"}`,
			code: reason,
		}
	}

	/**
	 * What became of earlier sends, by ticket id. Expo keeps a receipt for a day; fetch
	 * them at least once, because that's where `DeviceNotRegistered` usually arrives — the
	 * ticket only says Expo took the message, not that Apple or Google did.
	 *
	 * Missing from the answer means Expo hasn't heard back yet (or the day is up); those
	 * ids are simply absent. Each present receipt is `{ ok: true }` or carries the
	 * {@link PostboiError} the send would have thrown, so `push.expired(receipt.error)`
	 * is the same check as on a send.
	 */
	async receipts(ids: ReadonlyArray<string>): Promise<Record<string, PushReceipt>> {
		const chunks: Array<ReadonlyArray<string>> = []
		for (let start = 0; start < ids.length; start += MAX_RECEIPTS)
			chunks.push(ids.slice(start, start + MAX_RECEIPTS))
		// The chunks are independent and Expo documents no concurrency limit here (its
		// rate guidance is about sends), so a day's worth goes out together.
		const pages = await Promise.all(chunks.map((chunk) => this.#receipts_page(chunk)))
		return Object.assign({}, ...pages)
	}

	/** One receipts request, at most {@link MAX_RECEIPTS} ids. */
	async #receipts_page(ids: ReadonlyArray<string>): Promise<Record<string, PushReceipt>> {
		const response = await this.request({
			url: RECEIPTS_URL,
			headers: this.#headers(),
			body: JSON.stringify({ ids }),
		})
		const data = await this.read_json(response)
		const refused = this.#request_error(response, data)
		if (!response.ok || refused) {
			throw new PostboiError({
				provider: this.provider,
				channel: "push",
				status: response.status,
				code: refused?.code,
				message: refused?.message ?? `Expo receipts request failed with status ${response.status}`,
				raw: data,
			})
		}
		const out: Record<string, PushReceipt> = {}
		const receipts = (data as { data?: Record<string, Outcome> } | null)?.data ?? {}
		for (const [id, receipt] of Object.entries(receipts)) {
			if (receipt?.status !== "error") {
				out[id] = { ok: true }
				continue
			}
			const error = this.#outcome_error(receipt)
			out[id] = {
				ok: false,
				error: new PostboiError({
					provider: this.provider,
					channel: "push",
					message: error.message,
					code: error.code,
					raw: receipt,
				}),
			}
		}
		return out
	}
}
