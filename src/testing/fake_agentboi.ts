/**
 * The mailbox API (agentboi.email's /v1/mailboxes) in memory, as a `fetch`. Speaks the wire
 * contract closely enough for `postboi/mailbox` and `postboi mailbox` to be tested end to end
 * without the network. Long polls hold for `scale` milliseconds per requested second.
 */

type Trust = "owner" | "thread" | "stranger" | "suspect"

interface FakeMail {
	id: string
	seq: number
	thread_id: string
	to: string
	tag: string | null
	from: string
	from_name: string | null
	reply_to: string | null
	subject: string
	text: string | null
	reply_text: string | null
	trust: Trust
	received: string
	in_reply_to: string | null
	code: string | null
	codes: Array<string>
	link: string | null
	links: Array<{ url: string; text: string | null; kind: "verify" | "unsubscribe" | "other" }>
	auth: { spf?: string; dkim?: string; dmarc?: string }
	attachments: Array<{ filename: string; type: string; size: number; url: string | null }>
	size: number
	html: string | null
}

interface FakeSent {
	id: string
	thread_id: string | null
	to: Array<string>
	subject: string
	text: string | null
	sent: string
}

interface FakeMailbox {
	id: string
	address: string
	name: string | null
	key: string
	team: string | null
	created: string
	mail: Array<FakeMail>
	sent: Array<FakeSent>
	seq: number
	deleted: boolean
	listeners: Set<() => void>
}

export interface FakeMailboxRequest {
	method: string
	path: string
	query: Record<string, string>
	auth: string | null
	body: Record<string, unknown> | undefined
}

/** `pb_team` is a team key that opens every mailbox it made; anything else `pb_` is a stranger's. */
export const TEAM_KEY = "pb_team"

export function fake_agentboi(options: { base?: string; scale?: number } = {}) {
	const base = options.base ?? "https://agentboi.test"
	const scale = options.scale ?? 4
	const boxes = new Map<string, FakeMailbox>()
	const requests: Array<FakeMailboxRequest> = []
	let counter = 0

	function json(status: number, body: unknown): Response {
		return new Response(status === 204 ? null : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})
	}

	function refuse(status: number, code: string, message: string): Response {
		return json(status, { message, code })
	}

	function wire(box: FakeMailbox, key?: string) {
		const path = `${base}/v1/mailboxes/${box.address}`
		return {
			id: box.id,
			address: box.address,
			name: box.name,
			domain: box.address.split("@")[1],
			...(key ? { key } : {}),
			key_prefix: box.key.slice(0, 10),
			claimed: box.team !== null,
			...(key && !box.team ? { claim_url: `${base}/claim/${box.id}` } : {}),
			created: box.created,
			count: box.mail.length,
			cursor: box.seq,
			urls: {
				messages: `${path}/messages`,
				wait: `${path}/wait`,
				threads: `${path}/threads`,
				send: `${path}/send`,
			},
		}
	}

	function summary(mail: FakeMail) {
		const { html: _html, ...rest } = mail
		return { ...rest, urls: { reply: `${base}/v1/mailboxes/x/messages/${mail.id}/reply` } }
	}

	function passes(mail: FakeMail, query: Record<string, string>): boolean {
		if (query.tag && mail.tag !== query.tag) return false
		if (query.trust && mail.trust !== query.trust) return false
		if (query.thread && mail.thread_id !== query.thread) return false
		if (
			query.from &&
			!`${mail.from_name ?? ""} ${mail.from}`.toLowerCase().includes(query.from.toLowerCase())
		)
			return false
		if (query.subject && !mail.subject.toLowerCase().includes(query.subject.toLowerCase()))
			return false
		return true
	}

	function hold(box: FakeMailbox, seconds: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer)
				box.listeners.delete(done)
				resolve()
			}
			const timer = setTimeout(done, seconds * scale)
			box.listeners.add(done)
		})
	}

	function opened(auth: string | null, ref: string): FakeMailbox | Response {
		if (!auth) return refuse(401, "missing_token", "This needs a key.")
		const box = [...boxes.values()].find(
			(candidate) => !candidate.deleted && (candidate.id === ref || candidate.address === ref)
		)
		if (auth.startsWith("mb_")) {
			const own = [...boxes.values()].find(
				(candidate) => candidate.key === auth && !candidate.deleted
			)
			if (!own) return refuse(401, "invalid_token", "Invalid, rotated or deleted mailbox key.")
			if (own !== box) return refuse(404, "not_found", "No such mailbox.")
			return own
		}
		if (auth !== TEAM_KEY || !box || box.team !== TEAM_KEY)
			return refuse(404, "not_found", "No such mailbox.")
		return box
	}

	/** Mail arriving, as Postboi would have filed and read it. */
	function deliver(address: string, partial: Partial<FakeMail> = {}): FakeMail {
		const [local, domain] = address.split("@")
		const [stem, ...tag] = local.split("+")
		const box = boxes.get(`${stem}@${domain}`)
		if (!box) throw new Error(`No mailbox ${address}`)
		box.seq += 1
		counter += 1
		const id = `in_${counter}`
		const mail: FakeMail = {
			id,
			seq: box.seq,
			thread_id: partial.thread_id ?? id,
			to: address,
			tag: tag.join("+") || null,
			from: "bob@customer.example",
			from_name: "Bob",
			reply_to: null,
			subject: "Hello",
			text: "Hi there",
			reply_text: "Hi there",
			trust: "stranger",
			received: new Date().toISOString(),
			in_reply_to: null,
			code: null,
			codes: [],
			link: null,
			links: [],
			auth: {},
			attachments: [],
			size: 100,
			html: "<p>Hi there</p>",
			...partial,
		}
		box.mail.push(mail)
		for (const listener of [...box.listeners]) listener()
		return mail
	}

	async function handle(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
		const method = (init.method ?? "GET").toUpperCase()
		const headers = new Headers(init.headers)
		const auth = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null
		const body =
			typeof init.body === "string" && init.body
				? (JSON.parse(init.body) as Record<string, unknown>)
				: undefined
		const query = Object.fromEntries(url.searchParams)
		requests.push({ method, path: url.pathname, query, auth, body })
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
		if (parts[0] !== "v1" || parts[1] !== "mailboxes") return refuse(404, "not_found", "Not found")

		if (parts.length === 2 && method === "POST") {
			if (auth?.startsWith("mb_"))
				return refuse(403, "mailbox_key", "A mailbox key makes no others.")
			counter += 1
			const name = typeof body?.address === "string" ? body.address : `quiet-otter`
			const box: FakeMailbox = {
				id: `mbx_${counter}`,
				address: `${name}-${String(counter).padStart(4, "0")}@agentboi.email`,
				name: typeof body?.name === "string" ? body.name : null,
				key: `mb_key${counter}`,
				team: auth === TEAM_KEY ? TEAM_KEY : null,
				created: new Date().toISOString(),
				mail: [],
				sent: [],
				seq: 0,
				deleted: false,
				listeners: new Set(),
			}
			boxes.set(box.address, box)
			return json(201, wire(box, box.key))
		}
		if (parts.length === 2 && method === "GET") {
			if (auth?.startsWith("mb_")) {
				const own = [...boxes.values()].find((box) => box.key === auth && !box.deleted)
				return own ? json(200, wire(own)) : refuse(401, "invalid_token", "Invalid key.")
			}
			if (auth !== TEAM_KEY) return refuse(401, "invalid_token", "Invalid key.")
			return json(200, {
				data: [...boxes.values()]
					.filter((box) => box.team === TEAM_KEY && !box.deleted)
					.map((box) => wire(box)),
			})
		}

		const box = opened(auth, parts[2])
		if (box instanceof Response) return box
		const rest = parts.slice(3)

		if (rest.length === 0) {
			if (method === "GET") return json(200, wire(box))
			if (method === "PATCH") {
				box.name = (body?.name as string | null) ?? null
				return json(200, wire(box))
			}
			if (method === "DELETE") {
				if (auth?.startsWith("mb_") && box.team)
					return refuse(403, "team_key_required", "A claimed mailbox is deleted by its team.")
				box.deleted = true
				return json(204, null)
			}
		}
		if (rest[0] === "key" && method === "POST") {
			counter += 1
			box.key = `mb_rotated${counter}`
			return json(200, wire(box, box.key))
		}
		if (rest[0] === "messages" && rest.length === 1) {
			const after = Number(query.after ?? 0)
			const read = () =>
				box.mail.filter((mail) => mail.seq > after && passes(mail, query)).slice(0, 100)
			let rows = read()
			if (!rows.length && Number(query.wait)) {
				await hold(box, Number(query.wait))
				rows = read()
			}
			return json(200, {
				data: rows.map(summary),
				cursor: rows.reduce((cursor, mail) => Math.max(cursor, mail.seq), after),
			})
		}
		if (rest[0] === "wait") {
			const after = Number(query.after ?? 0)
			const find = () => box.mail.filter((mail) => mail.seq > after && passes(mail, query)).at(-1)
			let found = find()
			if (!found) {
				await hold(box, Number(query.timeout ?? 60))
				found = find()
			}
			return found
				? json(200, found)
				: json(408, {
						message: "Nothing arrived",
						code: "timeout",
						cursor: Math.max(after, box.seq),
					})
		}
		if (rest[0] === "messages" && rest.length === 2 && method === "GET") {
			const mail = box.mail.find((candidate) => candidate.id === rest[1])
			return mail ? json(200, mail) : refuse(404, "not_found", "No such message.")
		}
		if ((rest[0] === "messages" && rest[2] === "reply") || rest[0] === "send") {
			if (!box.team)
				return refuse(
					403,
					"unclaimed",
					`This mailbox receives until a person claims it at ${base}/claim/${box.id}.`
				)
			const answering =
				rest[0] === "messages"
					? box.mail.find((mail) => mail.id === rest[1])
					: body?.in_reply_to
						? box.mail.find((mail) => mail.id === body.in_reply_to)
						: undefined
			if ((rest[0] === "messages" || body?.in_reply_to) && !answering)
				return refuse(404, "not_found", "No such message in this mailbox.")
			counter += 1
			const sent: FakeSent = {
				id: `msg_${counter}`,
				thread_id: answering?.thread_id ?? null,
				to: answering
					? [answering.reply_to ?? answering.from]
					: ((body?.to as Array<string>) ?? []),
				subject:
					(body?.subject as string | undefined) ?? (answering ? `Re: ${answering.subject}` : ""),
				text: (body?.text as string | undefined) ?? null,
				sent: new Date().toISOString(),
			}
			box.sent.push(sent)
			return json(201, { id: sent.id, ...(sent.thread_id ? { thread_id: sent.thread_id } : {}) })
		}
		if (rest[0] === "threads" && rest.length === 1) {
			const ids = [...new Set(box.mail.map((mail) => mail.thread_id))]
			return json(200, {
				data: ids.map((thread_id) => {
					const mail = box.mail.filter((candidate) => candidate.thread_id === thread_id)
					const newest = mail.at(-1)!
					return {
						thread_id,
						subject: mail[0].subject,
						from: newest.from,
						from_name: newest.from_name,
						messages: mail.length + box.sent.filter((sent) => sent.thread_id === thread_id).length,
						last_at: newest.received,
						trust: newest.trust,
					}
				}),
				before: null,
			})
		}
		if (rest[0] === "threads" && rest.length === 2) {
			const received = box.mail.filter((mail) => mail.thread_id === rest[1])
			if (!received.length) return refuse(404, "not_found", "No such thread.")
			return json(200, {
				thread_id: rest[1],
				subject: received[0].subject,
				messages: [
					...received.map((mail) => ({ direction: "received", ...summary(mail) })),
					...box.sent
						.filter((sent) => sent.thread_id === rest[1])
						.map((sent) => ({ direction: "sent", from: box.address, status: "sent", ...sent })),
				],
			})
		}
		return refuse(404, "not_found", "Not found")
	}

	return {
		base,
		fetch: handle as typeof fetch,
		requests,
		boxes,
		deliver,
		/** Claim an unclaimed mailbox into the team, as a person opening its claim link would. */
		claim(address: string) {
			const box = boxes.get(address)
			if (box) box.team = TEAM_KEY
		},
	}
}
