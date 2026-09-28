/**
 * The one place the extension talks to tempboi: `/v1/inboxes`, the same API the CLI and
 * `postboi/inbox` speak. Only `fetch`, so the popup and the worker share it. The token is
 * the whole access rule and rides in the Authorization header, never in a URL.
 */

/** Failure talking to tempboi. `code` is the server's (`not_found`, `rate_limited`, …). */
export class TempboiError extends Error {
	constructor(message, { status = 0, code = "network" } = {}) {
		super(message)
		this.name = "TempboiError"
		this.status = status
		this.code = code
	}

	/** The inbox is gone: expired, deleted, or the token no longer opens it. */
	get gone() {
		return this.status === 404 || this.status === 401
	}
}

async function call(url, { token, method = "GET", body, signal } = {}) {
	let response
	try {
		response = await fetch(url, {
			method,
			signal,
			headers: {
				accept: "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			cache: "no-store",
		})
	} catch (error) {
		if (error?.name === "AbortError") throw error
		throw new TempboiError("Couldn't reach tempboi. Check your connection.")
	}
	if (response.status === 204) return undefined
	const answer = await response.json().catch(() => undefined)
	if (!response.ok)
		throw new TempboiError(answer?.message ?? `tempboi answered ${response.status}.`, {
			status: response.status,
			code: answer?.code ?? "http_error",
		})
	return answer
}

function inbox_url(server, address) {
	return `${server}/v1/inboxes/${encodeURIComponent(address)}`
}

/** Make an inbox. The answer carries the token, and it is the only time it is said. */
export function create_inbox(server, { name, ttl } = {}) {
	const body = {}
	if (name) body.name = name
	if (ttl) body.ttl = ttl
	return call(`${server}/v1/inboxes`, { method: "POST", body })
}

/** Which inbox a token opens: how a page's inbox is brought into the extension. */
export function claim_inbox(server, token) {
	return call(`${server}/v1/inboxes`, { token })
}

export function get_inbox(server, inbox) {
	return call(inbox_url(server, inbox.address), { token: inbox.token })
}

/** Messages after `after`, oldest first. `wait` makes it a long poll of up to 25 seconds. */
export function list_messages(server, inbox, { after = 0, wait = 0, signal } = {}) {
	const query = new URLSearchParams({ after: String(after) })
	if (wait) query.set("wait", String(wait))
	return call(`${inbox_url(server, inbox.address)}/messages?${query}`, {
		token: inbox.token,
		signal,
	})
}

/** One message whole: the html and headers a listing leaves out. */
export function read_message(server, inbox, id) {
	return call(`${inbox_url(server, inbox.address)}/messages/${encodeURIComponent(id)}`, {
		token: inbox.token,
	})
}

/** Live `ttl` seconds from now, within the inbox's whole-life cap. */
export function extend_inbox(server, inbox, ttl) {
	return call(inbox_url(server, inbox.address), {
		method: "PATCH",
		token: inbox.token,
		body: { ttl },
	})
}

/**
 * Have the inbox's arrivals pushed to this browser. `url` is the inbox's `push.url`; the
 * body is the subscription as `toJSON()` gives it. A browser follows one inbox, so this
 * moves it off whichever it followed before.
 */
export function follow_inbox(url, inbox, subscription) {
	return call(url, { method: "POST", token: inbox.token, body: subscription })
}

/** Gone now rather than at expiry. */
export function delete_inbox(server, inbox) {
	return call(inbox_url(server, inbox.address), { method: "DELETE", token: inbox.token })
}

/**
 * A file the API names by URL (an attachment, the raw `.eml`), as a Blob. It is fetched
 * with the token in a header so the key never appears in a download's URL or history.
 */
export async function fetch_file(inbox, url) {
	let response
	try {
		response = await fetch(url, {
			headers: { authorization: `Bearer ${inbox.token}` },
			cache: "no-store",
		})
	} catch {
		throw new TempboiError("Couldn't reach tempboi. Check your connection.")
	}
	if (!response.ok)
		throw new TempboiError(`That file couldn't be fetched (${response.status}).`, {
			status: response.status,
		})
	return response.blob()
}
