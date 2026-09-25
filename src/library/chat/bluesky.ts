import { ChatProvider, type ChatProviderOptions, type PreparedChat } from "./provider.js"
import type { RequestSpec } from "../transport.js"
import { PostboiError, type ProviderError } from "../errors.js"

/** Options for the Bluesky provider constructor. */
type Options = ChatProviderOptions & {
	/** Your handle or DID, e.g. `you.bsky.social`. */
	identifier: string
	/** An app password from Settings → App Passwords. Never your account password. */
	app_password: string
	/** The PDS to talk to. Defaults to `https://bsky.social`. */
	service?: string
}

type Session = { did: string; jwt: string }

type SendResponse = { uri: string; cid: string }

/** A post is 300 graphemes, not characters — one emoji family is one. */
const LIMIT = 300

/**
 * Bluesky, over the AT Protocol — https://docs.bsky.app/docs/api/com-atproto-repo-create-record
 *
 * The odd one out among the chat providers: the destination isn't a webhook or a chat id,
 * it's **your own repo**, so `to` is decorative here — the post always lands on the feed
 * belonging to the credentials. Posting is public, which is the thing to know before
 * putting it behind a generic `chat()` or a `send()` fallback chain.
 *
 * Auth is a session, not a bearer key: `createSession` trades an app password for a JWT
 * that lasts a couple of hours, and its rate limit (300 a day) is low enough that one
 * session per send would be the ceiling — so the session is cached and re-minted only
 * when the server says it expired.
 *
 * @example
 * ```ts
 * import Bluesky from "postboi/bluesky"
 *
 * const chat = new Bluesky({
 * 	identifier: "you.bsky.social",
 * 	app_password: process.env.BLUESKY_APP_PASSWORD,
 * })
 * await chat.send({ message: "Deploy finished" })
 * ```
 */
export default class Bluesky extends ChatProvider<SendResponse> {
	protected readonly provider = "bluesky"
	#identifier: string
	#app_password: string
	#service: string
	#session?: Promise<Session>

	constructor({ identifier, app_password, service, ...options }: Options) {
		// The identifier is the destination, the same way the webhook URL is for Slack: a
		// generic POSTBOI_CHAT_TO (a Telegram chat id, say) must not look like somewhere
		// this provider could post.
		super({ ...options, default: { ...options.default, to: identifier } })
		this.#identifier = identifier
		this.#app_password = app_password
		this.#service = (service ?? "https://bsky.social").replace(/\/$/, "")
	}

	protected async build_request(message: PreparedChat): Promise<RequestSpec> {
		const session = await this.#authenticate()
		// No formatting exists in a post record — rich text is facets over plain text — so a
		// title is just the first line.
		const text = message.title ? `${message.title}\n\n${message.message}` : message.message
		const length = count_graphemes(text)
		if (length > LIMIT) {
			throw new PostboiError({
				provider: this.provider,
				channel: "chat",
				code: "too_long",
				message: `A Bluesky post is ${LIMIT} graphemes at most, and this one is ${length}.`,
			})
		}

		const facets = link_facets(text)
		return {
			url: `${this.#service}/xrpc/com.atproto.repo.createRecord`,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${session.jwt}`,
			},
			body: JSON.stringify({
				repo: session.did,
				collection: "app.bsky.feed.post",
				record: {
					$type: "app.bsky.feed.post",
					text,
					createdAt: new Date().toISOString(),
					...(facets.length ? { facets } : {}),
				},
			}),
		}
	}

	// A cached session outlives its JWT after a couple of hours, and a long-running server
	// would then fail every post. One retry on the server's own expiry signal is the whole
	// refresh story — cheaper than tracking `refreshJwt` and its own expiry.
	protected override async deliver(message: PreparedChat): Promise<SendResponse> {
		try {
			return await super.deliver(message)
		} catch (error) {
			if (!(error instanceof PostboiError) || error.code !== "ExpiredToken") throw error
			this.#session = undefined
			return super.deliver(message)
		}
	}

	protected parse_response(_response: Response, data: unknown): SendResponse {
		const record = (data ?? {}) as { uri?: string; cid?: string }
		return { uri: record.uri ?? "", cid: record.cid ?? "" }
	}

	protected parse_error(_response: Response, data: unknown): ProviderError | undefined {
		if (data === null || typeof data !== "object") return undefined
		// XRPC errors are { error: "ExpiredToken", message?: "…" } — the name is the code,
		// which is what `deliver` matches on to re-authenticate.
		const e = data as { error?: unknown; message?: unknown }
		if (typeof e.error !== "string") return undefined
		return { message: typeof e.message === "string" ? e.message : e.error, code: e.error }
	}

	/** The cached session, minted on first use. A failed login is never cached. */
	#authenticate(): Promise<Session> {
		this.#session ??= this.#create_session().catch((error) => {
			this.#session = undefined
			throw error
		})
		return this.#session
	}

	async #create_session(): Promise<Session> {
		const data = await this.call(
			{
				url: `${this.#service}/xrpc/com.atproto.server.createSession`,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ identifier: this.#identifier, password: this.#app_password }),
			},
			"login"
		)

		const session = (data ?? {}) as { did?: string; accessJwt?: string }
		if (!session.did || !session.accessJwt) {
			throw new PostboiError({
				provider: this.provider,
				channel: "chat",
				code: "no_session",
				message: "Bluesky returned no session. Check the handle and app password.",
				raw: data,
			})
		}
		return { did: session.did, jwt: session.accessJwt }
	}
}

/** Count graphemes, the unit Bluesky measures a post in. */
function count_graphemes(text: string): number {
	return [...new Intl.Segmenter().segment(text)].length
}

/**
 * Bluesky does not linkify anything itself: a URL in the text is dead unless the record
 * carries a facet pointing at it, in **UTF-8 byte** offsets rather than string indices.
 *
 * ponytail: links only. Mentions would need a handle→DID lookup per name, and hashtags
 * are worth it the day someone asks.
 */
function link_facets(text: string): Array<Record<string, unknown>> {
	const encoder = new TextEncoder()
	const facets: Array<Record<string, unknown>> = []
	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		// Trailing punctuation reads as sentence, not URL — "see https://x.com." shouldn't
		// link the full stop.
		const uri = match[0].replace(/[.,;:!?)\]]+$/, "")
		const start = encoder.encode(text.slice(0, match.index)).length
		facets.push({
			index: { byteStart: start, byteEnd: start + encoder.encode(uri).length },
			features: [{ $type: "app.bsky.richtext.facet#link", uri }],
		})
	}
	return facets
}
