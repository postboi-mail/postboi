/**
 * tempboi.email in memory, as a `fetch`. Speaks the v1 wire contract closely enough for the
 * SDK helper and the CLI to be tested end to end without the network. Long-polls hold for
 * `scale` milliseconds per requested second, so a "25 second" poll takes 25ms in a test.
 */

interface FakeMessage {
	id: string
	seq: number
	to: string
	tag: string | null
	from: string
	from_name: string | null
	subject: string | null
	text: string | null
	html: string | null
	received: string
	code: string | null
	codes: Array<string>
	link: string | null
	links: Array<{ url: string; text: string | null; kind: "verify" | "unsubscribe" | "other" }>
	auth: { spf?: string; dkim?: string; dmarc?: string }
	attachments: Array<{ filename: string | null; type: string; size: number; url: string }>
	size: number
	truncated: boolean
	headers: Array<[string, string]>
	urls: { raw: string }
}

interface FakeInbox {
	address: string
	token: string
	domain: string
	created: string
	expires: string
	messages: Array<FakeMessage>
	seq: number
	listeners: Set<() => void>
}

export interface FakeRequest {
	method: string
	path: string
	query: Record<string, string>
	auth: string | null
	body: unknown
}

export function fake_tempboi(options: { base?: string; scale?: number } = {}) {
	const base = options.base ?? "https://tempboi.test"
	const scale = options.scale ?? 4
	const inboxes = new Map<string, FakeInbox>()
	const requests: Array<FakeRequest> = []
	let counter = 0

	function json(status: number, body: unknown): Response {
		return new Response(status === 204 ? null : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})
	}

	function view(inbox: FakeInbox, token = false) {
		const hash = `#${inbox.token}`
		return {
			address: inbox.address,
			...(token ? { token: inbox.token } : {}),
			domain: inbox.domain,
			created: inbox.created,
			expires: inbox.expires,
			count: inbox.messages.length,
			cursor: inbox.seq,
			urls: {
				web: `${base}/${inbox.address}${hash}`,
				messages: `${base}/v1/inboxes/${inbox.address}/messages`,
				wait: `${base}/v1/inboxes/${inbox.address}/wait`,
			},
		}
	}

	function summary(message: FakeMessage) {
		const { html: _html, headers: _headers, urls: _urls, ...rest } = message
		return rest
	}

	function matching(inbox: FakeInbox, query: Record<string, string>): Array<FakeMessage> {
		const after = Number(query.after ?? 0)
		return inbox.messages.filter(
			(m) =>
				m.seq > after &&
				(query.tag === undefined || m.tag === query.tag) &&
				(query.from === undefined ||
					`${m.from_name ?? ""} ${m.from}`.toLowerCase().includes(query.from.toLowerCase())) &&
				(query.subject === undefined ||
					(m.subject ?? "").toLowerCase().includes(query.subject.toLowerCase()))
		)
	}

	/** Resolve when something arrives or `ms` passes. */
	function hold(inbox: FakeInbox, ms: number, signal?: AbortSignal | null): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer)
				inbox.listeners.delete(done)
				resolve()
			}
			const timer = setTimeout(done, ms)
			inbox.listeners.add(done)
			signal?.addEventListener("abort", done, { once: true })
		})
	}

	const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
		const method = (init.method ?? "GET").toUpperCase()
		const headers = new Headers(init.headers)
		const auth = headers.get("authorization")
		const query = Object.fromEntries(url.searchParams)
		const body = typeof init.body === "string" ? JSON.parse(init.body || "{}") : undefined
		const path = decodeURIComponent(url.pathname)
		requests.push({ method, path, query, auth, body })
		if (init.signal?.aborted) throw init.signal.reason

		if (path === "/v1/inboxes" && method === "POST") {
			const { name, ttl, domain } = (body ?? {}) as { name?: string; ttl?: number; domain?: string }
			if (name !== undefined && !/^[a-z0-9-]{1,32}$/.test(name))
				return json(400, {
					message: "Names are lowercase letters, digits and dashes",
					code: "invalid_name",
				})
			if (ttl !== undefined && (ttl < 60 || ttl > 86_400))
				return json(400, { message: "ttl is between 1m and 24h", code: "invalid_ttl" })
			const host = domain ?? "tempboi.email"
			const suffix = `k${(++counter).toString().padStart(3, "0")}`
			const address = `${name ?? "quiet-otter"}-${suffix}@${host}`
			const now = Date.now()
			const inbox: FakeInbox = {
				address,
				token: `tb_${suffix}`,
				domain: host,
				created: new Date(now).toISOString(),
				expires: new Date(now + (ttl ?? 3600) * 1000).toISOString(),
				messages: [],
				seq: 0,
				listeners: new Set(),
			}
			inboxes.set(address, inbox)
			return json(201, view(inbox, true))
		}

		const match = /^\/v1\/inboxes\/([^/]+)(\/.*)?$/.exec(path)
		if (!match) return json(404, { message: "Not found", code: "not_found" })
		const inbox = inboxes.get(match[1])
		if (!inbox) return json(404, { message: "No such inbox", code: "not_found" })
		const token = auth?.replace(/^Bearer /, "") ?? query.token
		if (!token) return json(401, { message: "Missing token", code: "missing_token" })
		if (token !== inbox.token) return json(401, { message: "Wrong token", code: "invalid_token" })
		const rest = match[2] ?? ""

		if (rest === "") {
			if (method === "GET") return json(200, view(inbox))
			if (method === "DELETE") {
				inboxes.delete(inbox.address)
				return json(204, null)
			}
			if (method === "PATCH") {
				const ttl = (body as { ttl: number }).ttl
				inbox.expires = new Date(Date.now() + ttl * 1000).toISOString()
				return json(200, view(inbox))
			}
		}

		if (rest === "/messages" && method === "GET") {
			let found = matching(inbox, query)
			const wait = Number(query.wait ?? 0)
			if (!found.length && wait > 0) {
				await hold(inbox, wait * scale, init.signal)
				if (init.signal?.aborted) throw init.signal.reason
				found = matching(inbox, query)
			}
			const cursor = found.length ? Math.max(...found.map((m) => m.seq)) : Number(query.after ?? 0)
			return json(200, { data: found.map(summary), cursor, expires: inbox.expires })
		}

		if (rest === "/wait" && method === "GET") {
			const newest = () => matching(inbox, query).at(-1)
			let found = newest()
			if (!found) {
				await hold(inbox, Number(query.timeout ?? 60) * scale, init.signal)
				if (init.signal?.aborted) throw init.signal.reason
				found = newest()
			}
			if (!found)
				return json(408, { message: "Nothing arrived", code: "timeout", cursor: inbox.seq })
			return json(200, found)
		}

		const message_match = /^\/messages\/([^/]+)(\/raw)?$/.exec(rest)
		if (message_match) {
			const message = inbox.messages.find((m) => m.id === message_match[1])
			if (!message) return json(404, { message: "No such message", code: "not_found" })
			if (message_match[2])
				return new Response(`Subject: ${message.subject}\r\n\r\n${message.text}`, {
					headers: { "content-type": "message/rfc822" },
				})
			return json(200, message)
		}

		return json(404, { message: "Not found", code: "not_found" })
	}

	return {
		base,
		fetch: fetch as typeof globalThis.fetch,
		requests,
		inboxes,
		/** A mail arrives. `to` may carry a plus-tag. */
		deliver(
			to: string,
			mail: Partial<
				Pick<FakeMessage, "from" | "from_name" | "subject" | "text" | "html" | "code" | "link">
			> = {}
		): FakeMessage {
			const plus = /^([^+@]+)\+([^@]+)(@.+)$/.exec(to)
			const address = plus ? `${plus[1]}${plus[3]}` : to
			const inbox = inboxes.get(address)
			if (!inbox) throw new Error(`No inbox ${address}`)
			const seq = ++inbox.seq
			const message: FakeMessage = {
				id: `tmsg_${seq}`,
				seq,
				to,
				tag: plus ? plus[2] : null,
				from: mail.from ?? "hello@example.com",
				from_name: mail.from_name ?? null,
				subject: mail.subject ?? null,
				text: mail.text ?? null,
				html: mail.html ?? null,
				received: new Date().toISOString(),
				code: mail.code ?? null,
				codes: mail.code ? [mail.code] : [],
				link: mail.link ?? null,
				links: mail.link ? [{ url: mail.link, text: "Verify", kind: "verify" }] : [],
				auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
				attachments: [],
				size: 1234,
				truncated: false,
				headers: [["Subject", mail.subject ?? ""]],
				urls: { raw: `/v1/inboxes/${address}/messages/tmsg_${seq}/raw` },
			}
			inbox.messages.push(message)
			for (const listener of [...inbox.listeners]) listener()
			return message
		},
	}
}
