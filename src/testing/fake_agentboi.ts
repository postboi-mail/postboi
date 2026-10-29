/**
 * The mailbox API (agentboi.email's /v1/mailboxes) in memory, as a `fetch`. Speaks the wire
 * contract closely enough for `postboi/mailbox` and `postboi mailbox` to be tested end to end
 * without the network. Long polls hold for `scale` milliseconds per requested second.
 */

type Trust = "owner" | "thread" | "stranger" | "suspect"
type Folder = "inbox" | "archive" | "spam" | "trash" | "sent"
type Review = "none" | "new" | "all"

const COLOURS = ["grey", "amber", "red", "green", "blue"]
const FOLDERS: ReadonlyArray<string> = ["inbox", "archive", "spam", "trash"]
const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

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
	otp: { code: string; origin: string; signed: boolean } | null
	link: string | null
	links: Array<{ url: string; text: string | null; kind: "verify" | "unsubscribe" | "other" }>
	auth: { spf?: string; dkim?: string; dmarc?: string }
	attachments: Array<{ filename: string; type: string; size: number; url: string | null }>
	size: number
	html: string | null
}

interface FakeSent {
	id: string
	thread_id: string
	to: Array<string>
	cc: Array<string>
	subject: string
	text: string | null
	sent: string
	attachments: Array<{ filename: string; type: string; size: number }>
}

interface FakeThreadState {
	folder: Folder
	unread: boolean
	labels: Set<string>
}

interface FakeLabel {
	id: string
	name: string
	colour: string
}

interface FakeDraft {
	id: string
	status: "draft" | "sent"
	to: Array<string>
	cc: Array<string>
	bcc: Array<string>
	subject: string
	text: string | null
	html: string | null
	in_reply_to: string | null
	thread_id: string | null
	attachments: Array<{ filename: string; type: string; size: number }>
	held: boolean
	created_by: "agent" | "team"
	created: string
	updated: string
	sent_at: string | null
	message_id: string | null
	/** Whether the review policy would hold it, worked out when it was written. */
	needs_review: boolean
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
	disabled_at: string | null
	key_revoked: boolean
	listeners: Set<() => void>
	review: Review
	threads: Map<string, FakeThreadState>
	labels: Array<FakeLabel>
	drafts: Array<FakeDraft>
	/** Answers by idempotency key, so a replay answers what the first call did. */
	replays: Map<string, string>
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
			enabled: !box.disabled_at,
			disabled_at: box.disabled_at,
			key_active: !box.disabled_at && !box.key_revoked,
			claimed: box.team !== null,
			...(key && !box.team ? { claim_url: `${base}/claim/${box.id}` } : {}),
			created: box.created,
			count: box.mail.length,
			cursor: box.seq,
			review: box.review,
			drafts_waiting: box.drafts.filter((draft) => draft.status === "draft").length,
			urls: {
				messages: `${path}/messages`,
				wait: `${path}/wait`,
				threads: `${path}/threads`,
				send: `${path}/send`,
				drafts: `${path}/drafts`,
				labels: `${path}/labels`,
			},
		}
	}

	function state(box: FakeMailbox, thread_id: string): FakeThreadState {
		let found = box.threads.get(thread_id)
		if (!found) {
			found = { folder: "inbox", unread: false, labels: new Set() }
			box.threads.set(thread_id, found)
		}
		return found
	}

	function label_wire(label: FakeLabel) {
		return { id: label.id, name: label.name, colour: label.colour }
	}

	function find_label(box: FakeMailbox, ref: string): FakeLabel | undefined {
		const lower = ref.trim().toLowerCase()
		return box.labels.find((label) => label.id === ref || label.name.toLowerCase() === lower)
	}

	function make_label(box: FakeMailbox, name: string, colour = "grey"): FakeLabel | Response {
		const trimmed = name.trim()
		if (!trimmed || trimmed.length > 40)
			return refuse(400, "invalid_request", "A label's name is 1 to 40 characters.")
		if (!COLOURS.includes(colour)) return refuse(400, "invalid_request", "Unknown colour.")
		if (find_label(box, trimmed)) return refuse(409, "label_exists", "That label exists.")
		if (box.labels.length >= 50) return refuse(400, "too_many_labels", "50 labels a mailbox.")
		counter += 1
		const label = { id: `lbl_${counter}`, name: trimmed, colour }
		box.labels.push(label)
		return label
	}

	/** Every thread the mailbox is in: the ones mail started and the ones it started itself. */
	function thread_ids(box: FakeMailbox): Array<string> {
		return [
			...new Set([...box.mail.map((mail) => mail.thread_id), ...box.sent.map((s) => s.thread_id)]),
		]
	}

	function thread_wire(box: FakeMailbox, thread_id: string) {
		const mail = box.mail.filter((candidate) => candidate.thread_id === thread_id)
		const sent = box.sent.filter((candidate) => candidate.thread_id === thread_id)
		const newest = mail.at(-1)
		const times = [...mail.map((m) => m.received), ...sent.map((s) => s.sent)].sort()
		const own = state(box, thread_id)
		return {
			thread_id,
			subject: mail[0]?.subject ?? sent[0]?.subject ?? "",
			from: newest?.from ?? null,
			from_name: newest?.from_name ?? null,
			to: sent[0]?.to ?? [],
			messages: mail.length + sent.length,
			last_at: times.at(-1) ?? new Date().toISOString(),
			trust: newest?.trust ?? null,
			folder: own.folder,
			unread: own.unread,
			labels: box.labels.filter((label) => own.labels.has(label.id)).map(label_wire),
		}
	}

	function draft_wire(draft: FakeDraft) {
		const { needs_review: _needs, ...rest } = draft
		return rest
	}

	type Files = Array<{ filename: string; type: string; size: number }>

	/** The contract's attachment rules: a shape, at most 20, at most 10 MB decoded. */
	function files(body: Record<string, unknown> | undefined): Files | Response {
		const list = body?.attachments
		if (list === undefined) return []
		if (!Array.isArray(list)) return refuse(400, "invalid_request", "attachments is a list.")
		if (list.length > MAX_ATTACHMENTS)
			return refuse(400, "invalid_request", "At most 20 attachments.")
		let total = 0
		const out: Files = []
		for (const file of list as Array<Record<string, unknown>>) {
			if (typeof file?.filename !== "string" || typeof file.content !== "string")
				return refuse(400, "invalid_request", "An attachment needs a filename and content.")
			let size: number
			try {
				size = atob(file.content).length
			} catch {
				return refuse(400, "invalid_request", "An attachment's content is base64.")
			}
			total += size
			out.push({
				filename: file.filename,
				type: typeof file.type === "string" ? file.type : "application/octet-stream",
				size,
			})
		}
		if (total > MAX_ATTACHMENT_BYTES)
			return refuse(413, "attachments_too_large", "At most 10 MB of attachments.")
		return out
	}

	function list(value: unknown): Array<string> {
		return Array.isArray(value) ? (value as Array<string>) : []
	}

	/**
	 * Would review hold this? `new` lets a reply through only when it goes to the person who
	 * wrote and adds nobody; the team's key is never held.
	 */
	function holds(
		box: FakeMailbox,
		auth: string | null,
		send: { answering?: FakeMail; to: Array<string>; cc: Array<string>; bcc: Array<string> }
	): boolean {
		if (!auth?.startsWith("mb_") || box.review === "none") return false
		if (box.review === "all") return true
		const writer = send.answering ? (send.answering.reply_to ?? send.answering.from) : undefined
		const reply =
			!!writer &&
			send.to.length === 1 &&
			send.to[0].toLowerCase() === writer.toLowerCase() &&
			!send.cc.length &&
			!send.bcc.length
		return !reply
	}

	function record_send(
		box: FakeMailbox,
		fields: {
			thread_id: string | null
			to: Array<string>
			cc: Array<string>
			subject: string
			text: string | null
			attachments: Files
		}
	): FakeSent {
		counter += 1
		const id = `msg_${counter}`
		const sent: FakeSent = {
			...fields,
			id,
			thread_id: fields.thread_id ?? id,
			sent: new Date().toISOString(),
		}
		box.sent.push(sent)
		// A thread the mailbox started waits in `sent` until somebody answers it.
		if (!box.threads.has(sent.thread_id))
			box.threads.set(sent.thread_id, { folder: "sent", unread: false, labels: new Set() })
		return sent
	}

	function new_draft(
		box: FakeMailbox,
		fields: Partial<FakeDraft> & { needs_review: boolean },
		auth: string | null
	): FakeDraft {
		counter += 1
		const now = new Date().toISOString()
		const draft: FakeDraft = {
			id: `drf_${counter}`,
			status: "draft",
			to: [],
			cc: [],
			bcc: [],
			subject: "",
			text: null,
			html: null,
			in_reply_to: null,
			thread_id: null,
			attachments: [],
			held: false,
			created_by: auth?.startsWith("mb_") ? "agent" : "team",
			created: now,
			updated: now,
			sent_at: null,
			message_id: null,
			...fields,
		}
		box.drafts.push(draft)
		return draft
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
			if (own.disabled_at) return refuse(403, "mailbox_disabled", "This agent is disabled.")
			if (own.key_revoked) return refuse(401, "invalid_token", "This key is revoked.")
			if (own !== box) return refuse(404, "not_found", "No such mailbox.")
			return own
		}
		if (auth !== TEAM_KEY || !box || box.team !== TEAM_KEY)
			return refuse(404, "not_found", "No such mailbox.")
		return box
	}

	/** Mail arriving, as Postboi would have filed and read it. `junk` starts its thread in spam. */
	function deliver(
		address: string,
		partial: Partial<FakeMail> = {},
		options: { junk?: boolean } = {}
	): FakeMail {
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
			otp: null,
			link: null,
			links: [],
			auth: {},
			attachments: [],
			size: 100,
			html: "<p>Hi there</p>",
			...partial,
		}
		// A sender's OTP-Token is the code, as the server reads it.
		if (mail.otp && partial.code === undefined) {
			mail.code = mail.otp.code
			mail.codes = [mail.otp.code, ...mail.codes.filter((code) => code !== mail.otp?.code)]
		}
		box.mail.push(mail)
		// New mail marks its thread unread and brings it back from the archive or `sent`;
		// spam and trash stay where a person put them.
		const known = box.threads.get(mail.thread_id)
		if (!known)
			box.threads.set(mail.thread_id, {
				folder: options.junk ? "spam" : "inbox",
				unread: true,
				labels: new Set(),
			})
		else {
			known.unread = true
			if (known.folder === "archive" || known.folder === "sent") known.folder = "inbox"
		}
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
				disabled_at: null,
				key_revoked: false,
				listeners: new Set(),
				review: "none",
				threads: new Map(),
				labels: [],
				drafts: [],
				replays: new Map(),
			}
			boxes.set(box.address, box)
			return json(201, wire(box, box.key))
		}
		if (parts.length === 2 && method === "GET") {
			if (auth?.startsWith("mb_")) {
				const own = [...boxes.values()].find((box) => box.key === auth && !box.deleted)
				if (own?.disabled_at) return refuse(403, "mailbox_disabled", "This agent is disabled.")
				if (own?.key_revoked) return refuse(401, "invalid_token", "This key is revoked.")
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
		if (
			box.disabled_at &&
			method === "POST" &&
			(rest[0] === "send" || rest[2] === "reply" || rest[2] === "forward" || rest[2] === "send")
		)
			return refuse(403, "mailbox_disabled", "This agent is disabled.")

		if (rest.length === 0) {
			if (method === "GET") return json(200, wire(box))
			if (method === "PATCH") {
				if (body && "enabled" in body) {
					if (auth !== TEAM_KEY)
						return refuse(403, "team_key_required", "Only the team enables or disables an agent.")
					if (typeof body.enabled !== "boolean")
						return refuse(400, "invalid_request", "enabled must be a boolean.")
					box.disabled_at = body.enabled ? null : new Date().toISOString()
					if (!body.enabled) box.key_revoked = true
				}
				if (body && "review" in body) {
					if (auth?.startsWith("mb_"))
						return refuse(403, "team_key_required", "Only the team changes who reviews.")
					if (!["none", "new", "all"].includes(body.review as string))
						return refuse(400, "invalid_request", "review is none, new or all.")
					box.review = body.review as Review
				}
				if (body && "name" in body) box.name = (body.name as string | null) ?? null
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
			if (box.disabled_at)
				return refuse(403, "mailbox_disabled", "Enable this agent before issuing a key.")
			counter += 1
			box.key = `mb_rotated${counter}`
			box.key_revoked = false
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
		const sending =
			(rest[0] === "messages" && (rest[2] === "reply" || rest[2] === "forward")) ||
			rest[0] === "send"
		if (sending && method === "POST") {
			if (!box.team)
				return refuse(
					403,
					"unclaimed",
					`This mailbox receives until a person claims it at ${base}/claim/${box.id}.`
				)
			const forward = rest[2] === "forward"
			const answering =
				rest[0] === "messages"
					? box.mail.find((mail) => mail.id === rest[1])
					: body?.in_reply_to
						? box.mail.find((mail) => mail.id === body.in_reply_to)
						: undefined
			if ((rest[0] === "messages" || body?.in_reply_to) && !answering)
				return refuse(404, "not_found", "No such message in this mailbox.")
			if (forward && !list(body?.to).length)
				return refuse(400, "invalid_request", "to is required.")
			const key = typeof body?.idempotency_key === "string" ? body.idempotency_key : undefined
			const replayed = key ? box.replays.get(key) : undefined
			if (replayed) {
				const earlier = box.sent.find((sent) => sent.id === replayed)!
				return json(200, {
					status: "sent",
					id: earlier.id,
					thread_id: earlier.thread_id,
					idempotent_replay: true,
				})
			}
			// A forward's `attachments` is a switch for the original's files, not files of its own.
			const attached = forward ? [] : files(body)
			if (attached instanceof Response) return attached
			if (forward && body?.attachments !== undefined && typeof body.attachments !== "boolean")
				return refuse(400, "invalid_request", "A forward's attachments is true or false.")
			const carried = forward && body?.attachments !== false ? (answering?.attachments ?? []) : []
			const to =
				answering && !forward
					? body?.to
						? list(body.to)
						: [answering.reply_to ?? answering.from]
					: list(body?.to)
			const cc = list(body?.cc)
			const bcc = list(body?.bcc)
			const subject =
				(body?.subject as string | undefined) ??
				(answering ? `${forward ? "Fwd" : "Re"}: ${answering.subject}` : "")
			const thread_id = answering && !forward ? answering.thread_id : null
			const text = (body?.text as string | undefined) ?? null
			if (holds(box, auth, { answering: forward ? undefined : answering, to, cc, bcc })) {
				const draft = new_draft(
					box,
					{
						to,
						cc,
						bcc,
						subject,
						text,
						html: (body?.html as string | undefined) ?? null,
						in_reply_to: forward ? null : (answering?.id ?? null),
						thread_id,
						attachments: [
							...attached,
							...carried.map(({ filename, type, size }) => ({ filename, type, size })),
						],
						held: true,
						needs_review: true,
					},
					auth
				)
				return json(202, {
					status: "draft",
					draft_id: draft.id,
					draft: draft_wire(draft),
					message: "This mailbox's sends wait for a person on the team. It is saved as a draft.",
				})
			}
			const sent = record_send(box, {
				thread_id,
				to,
				cc,
				subject,
				text,
				attachments: [
					...attached,
					...carried.map(({ filename, type, size }) => ({ filename, type, size })),
				],
			})
			if (key) box.replays.set(key, sent.id)
			return json(201, { status: "sent", id: sent.id, thread_id: sent.thread_id })
		}
		if (rest[0] === "threads" && rest.length === 1) {
			const folder = query.folder ?? "inbox"
			const label = query.label ? find_label(box, query.label) : undefined
			if (query.label && !label) return json(200, { data: [], before: null })
			const q = query.q?.toLowerCase()
			const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50)))
			const rows = thread_ids(box)
				.map((thread_id) => thread_wire(box, thread_id))
				.filter((thread) => folder === "all" || thread.folder === folder)
				.filter((thread) => !label || thread.labels.some((l) => l.id === label.id))
				.filter((thread) => query.unread === undefined || String(thread.unread) === query.unread)
				.filter((thread) => !query.before || thread.last_at < query.before)
				.filter((thread) => {
					if (!q) return true
					const mail = box.mail.filter((m) => m.thread_id === thread.thread_id)
					const sent = box.sent.filter((m) => m.thread_id === thread.thread_id)
					return [
						thread.subject,
						...mail.flatMap((m) => [m.from, m.from_name ?? "", m.text ?? ""]),
						...sent.flatMap((m) => [...m.to, m.text ?? ""]),
					].some((value) => value.toLowerCase().includes(q))
				})
				.sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
			const page = rows.slice(0, limit)
			return json(200, {
				data: page,
				before: rows.length > limit ? (page.at(-1)?.last_at ?? null) : null,
			})
		}
		if (rest[0] === "threads" && rest.length === 2) {
			if (!thread_ids(box).includes(rest[1])) return refuse(404, "not_found", "No such thread.")
			const own = state(box, rest[1])
			if (method === "PATCH") {
				const change = body ?? {}
				if (!["folder", "read", "labels", "add_labels", "remove_labels"].some((f) => f in change))
					return refuse(400, "invalid_request", "Say what to change.")
				if (change.folder !== undefined) {
					if (!FOLDERS.includes(change.folder as string))
						return refuse(400, "invalid_request", "folder is inbox, archive, spam or trash.")
					own.folder = change.folder as Folder
				}
				if (change.read !== undefined) own.unread = change.read === false
				const named = (names: Array<string>, create: boolean): Array<string> | Response => {
					const ids: Array<string> = []
					for (const name of names) {
						const found = find_label(box, name)
						if (found) ids.push(found.id)
						else if (create) {
							const made = make_label(box, name)
							if (made instanceof Response) return made
							ids.push(made.id)
						}
					}
					return ids
				}
				if (change.labels !== undefined) {
					const ids = named(list(change.labels), true)
					if (ids instanceof Response) return ids
					own.labels = new Set(ids)
				}
				if (change.add_labels !== undefined) {
					const ids = named(list(change.add_labels), true)
					if (ids instanceof Response) return ids
					for (const id of ids) own.labels.add(id)
				}
				if (change.remove_labels !== undefined) {
					const ids = named(list(change.remove_labels), false)
					if (ids instanceof Response) return ids
					for (const id of ids) own.labels.delete(id)
				}
				return json(200, thread_wire(box, rest[1]))
			}
			const received = box.mail.filter((mail) => mail.thread_id === rest[1])
			const summary_of = thread_wire(box, rest[1])
			return json(200, {
				thread_id: rest[1],
				subject: summary_of.subject,
				folder: own.folder,
				unread: own.unread,
				labels: summary_of.labels,
				messages: [
					...received.map((mail) => ({ direction: "received", ...summary(mail) })),
					...box.sent
						.filter((sent) => sent.thread_id === rest[1])
						.map(({ attachments: _files, ...sent }) => ({
							direction: "sent",
							from: box.address,
							status: "sent",
							...sent,
						})),
				],
			})
		}
		if (rest[0] === "labels") {
			if (rest.length === 1 && method === "GET")
				return json(200, {
					data: [...box.labels]
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((label) => ({
							...label_wire(label),
							threads: [...box.threads.values()].filter((t) => t.labels.has(label.id)).length,
						})),
				})
			if (rest.length === 1 && method === "POST") {
				const made = make_label(
					box,
					String(body?.name ?? ""),
					(body?.colour as string | undefined) ?? "grey"
				)
				return made instanceof Response ? made : json(201, label_wire(made))
			}
			const label = find_label(box, rest[1] ?? "")
			if (!label) return refuse(404, "not_found", "No such label.")
			if (method === "PATCH") {
				if (typeof body?.name === "string") {
					const clash = find_label(box, body.name)
					if (clash && clash !== label) return refuse(409, "label_exists", "That label exists.")
					label.name = body.name.trim()
				}
				if (typeof body?.colour === "string") {
					if (!COLOURS.includes(body.colour)) return refuse(400, "invalid_request", "Colour.")
					label.colour = body.colour
				}
				return json(200, label_wire(label))
			}
			if (method === "DELETE") {
				box.labels = box.labels.filter((candidate) => candidate !== label)
				for (const thread of box.threads.values()) thread.labels.delete(label.id)
				return json(204, null)
			}
		}
		if (rest[0] === "drafts") {
			if (rest.length === 1 && method === "GET") {
				const status = query.status ?? "draft"
				return json(200, {
					data: [...box.drafts]
						.reverse()
						.filter((draft) => status === "all" || draft.status === status)
						.slice(0, 100)
						.map(draft_wire),
				})
			}
			if (rest.length === 1 && method === "POST") {
				const attached = files(body)
				if (attached instanceof Response) return attached
				const answering = body?.in_reply_to
					? box.mail.find((mail) => mail.id === body.in_reply_to)
					: undefined
				if (body?.in_reply_to && !answering)
					return refuse(404, "not_found", "No such message in this mailbox.")
				const to = body?.to
					? list(body.to)
					: answering
						? [answering.reply_to ?? answering.from]
						: []
				const cc = list(body?.cc)
				const bcc = list(body?.bcc)
				const draft = new_draft(
					box,
					{
						to,
						cc,
						bcc,
						subject:
							(body?.subject as string | undefined) ??
							(answering ? `Re: ${answering.subject}` : ""),
						text: (body?.text as string | undefined) ?? null,
						html: (body?.html as string | undefined) ?? null,
						in_reply_to: answering?.id ?? null,
						thread_id: answering?.thread_id ?? null,
						attachments: attached,
						needs_review: box.review !== "none",
					},
					auth
				)
				return json(201, draft_wire(draft))
			}
			const draft = box.drafts.find((candidate) => candidate.id === rest[1])
			if (!draft) return refuse(404, "not_found", "No such draft.")
			if (rest.length === 2 && method === "GET") return json(200, draft_wire(draft))
			if (draft.status === "sent") return refuse(409, "already_sent", "That draft was sent.")
			if (rest.length === 2 && method === "PATCH") {
				const attached = body?.attachments === undefined ? undefined : files(body)
				if (attached instanceof Response) return attached
				for (const field of ["to", "cc", "bcc"] as const)
					if (body?.[field] !== undefined) draft[field] = list(body[field])
				for (const field of ["subject", "text", "html"] as const)
					if (body?.[field] !== undefined) (draft[field] as unknown) = body[field]
				if (attached) draft.attachments = attached
				draft.updated = new Date().toISOString()
				return json(200, draft_wire(draft))
			}
			if (rest.length === 2 && method === "DELETE") {
				box.drafts = box.drafts.filter((candidate) => candidate !== draft)
				return json(204, null)
			}
			if (rest[2] === "send" && method === "POST") {
				if (!box.team) return refuse(403, "unclaimed", "This mailbox receives until claimed.")
				const answering = draft.in_reply_to
					? box.mail.find((mail) => mail.id === draft.in_reply_to)
					: undefined
				const held = holds(box, auth, {
					answering,
					to: draft.to,
					cc: draft.cc,
					bcc: draft.bcc,
				})
				if (held) return refuse(403, "review_required", "A person on the team sends this draft.")
				if (!draft.to.length) return refuse(400, "invalid_request", "A draft needs a to.")
				const sent = record_send(box, {
					thread_id: draft.thread_id,
					to: draft.to,
					cc: draft.cc,
					subject: draft.subject,
					text: draft.text,
					attachments: draft.attachments,
				})
				draft.status = "sent"
				draft.sent_at = sent.sent
				draft.message_id = sent.id
				return json(201, {
					status: "sent",
					id: sent.id,
					draft_id: draft.id,
					thread_id: sent.thread_id,
				})
			}
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
		/** Set who reviews a mailbox's sends, as the team would on the dashboard. */
		review(address: string, review: Review) {
			const box = boxes.get(address)
			if (box) box.review = review
		},
	}
}
