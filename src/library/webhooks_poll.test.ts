import { describe, it, expect, afterEach, vi } from "vitest"
import net from "node:net"
import {
	poll,
	POLL_FIELDS,
	POLL_MODULES,
	MODULES,
	mock_poll,
	parse_dsn,
	receive,
	type PollAdapter,
} from "#library/webhooks/index.js"
import { credential_env_keys } from "#library/registry.js"

const DSN_HARD = [
	"From: MAILER-DAEMON@mail.example.com",
	"To: bounces@example.com",
	"Date: Thu, 21 Aug 2026 09:15:00 +0000",
	'Content-Type: multipart/report; report-type=delivery-status; boundary="=_dsn"',
	"",
	"--=_dsn",
	"Content-Type: text/plain",
	"",
	"Delivery to the following recipient failed permanently.",
	"--=_dsn",
	"Content-Type: message/delivery-status",
	"",
	"Reporting-MTA: dns; mail.example.com",
	"Arrival-Date: Thu, 21 Aug 2026 09:14:58 +0000",
	"",
	"Final-Recipient: rfc822; gone@example.com",
	"Action: failed",
	"Status: 5.1.1",
	"Diagnostic-Code: smtp; 550 5.1.1 mailbox unavailable",
	"",
	"--=_dsn",
	"Content-Type: message/rfc822",
	"",
	"Message-ID: <original@example.com>",
	"Subject: The original subject",
	"From: sender@example.com",
	"",
	"Original body.",
	"--=_dsn--",
].join("\r\n")

describe("poll — provider handling", () => {
	it("throws polling_not_supported for webhook-capable providers", async () => {
		const error = await poll({ provider: "resend" }).catch((e) => e)
		expect(error).toMatchObject({ code: "polling_not_supported", provider: "resend" })
		expect(error.message).toContain("receive()")
	})

	it("throws missing_credentials naming the env var", async () => {
		vi.stubEnv("MS365_TENANT_ID", "")
		const error = await poll({ provider: "microsoft365" }).catch((e) => e)
		expect(error).toMatchObject({ code: "missing_credentials", provider: "microsoft365" })
		expect(error.message).toContain("MS365_TENANT_ID")
	})

	it("throws invalid_cursor on a cursor that doesn't parse", async () => {
		const error = await poll({
			provider: "microsoft365",
			cursor: "not json",
			options: { tenant_id: "t", client_id: "c", client_secret: "s" },
		}).catch((e) => e)
		expect(error).toMatchObject({ code: "invalid_cursor", provider: "microsoft365" })
	})

	it("accepts a custom adapter object", async () => {
		const adapter: PollAdapter = {
			provider: "custom",
			poll: async (ctx) => ({ events: [], cursor: ctx.cursor ?? "fresh" }),
		}
		const result = await poll({ provider: adapter })
		expect(result.cursor).toBe("fresh")
	})

	it("keys every polled event for deduplication", async () => {
		const adapter: PollAdapter = {
			provider: "custom",
			poll: async () => ({
				events: [
					{ type: "delivered", provider: "custom", message_id: "m1", phone: "+1", raw: {} },
					{ type: "delivered", provider: "custom", raw: {} },
				],
			}),
		}
		const { events } = await poll({ provider: adapter })
		expect(events.map((e) => e.dedupe_key)).toEqual(["custom:m1:delivered:+1", undefined])
	})

	it("passes explicit options through, beating the environment", async () => {
		vi.stubEnv("MS365_TENANT_ID", "env-tenant")
		const seen: Array<Record<string, string>> = []
		const adapter: PollAdapter = {
			provider: "microsoft365",
			poll: async (ctx) => {
				seen.push(ctx.options)
				return { events: [] }
			},
		}
		await poll({
			provider: adapter,
			options: { tenant_id: "explicit", client_id: "c", client_secret: "s", extra: "1" },
		})
		expect(seen[0]).toMatchObject({ tenant_id: "explicit", extra: "1" })
	})

	it("keeps POLL_FIELDS env names inside the registry's synced credential set", () => {
		// The app matches synced env_vars keys against POLL_FIELDS — a name the registry
		// doesn't carry would never sync, so the two lists must not drift.
		const synced = new Set(credential_env_keys())
		for (const fields of Object.values(POLL_FIELDS)) {
			for (const field of fields) expect(synced).toContain(field.env)
		}
	})

	it("covers the providers with no webhook adapter, plus Twilio, which has both", () => {
		// The email three have no delivery webhooks at all. Twilio's callbacks are set per
		// message at send time, so it can be polled with nothing set up, or told.
		expect(Object.keys(POLL_MODULES).sort()).toEqual([
			"cloudflare",
			"microsoft365",
			"smtp",
			"twilio",
		])
		const both = Object.keys(POLL_MODULES).filter((key) => MODULES[key])
		expect(both).toEqual(["twilio"])
	})

	it("receive() points polling providers at poll()", async () => {
		const request = new Request("https://example.com/webhooks", { method: "POST", body: "{}" })
		const error = await receive(request, { provider: "microsoft365" as never }).catch((e) => e)
		expect(error).toMatchObject({ code: "webhooks_not_supported", provider: "microsoft365" })
		expect(error.message).toContain("poll()")
	})
})

describe("parse_dsn", () => {
	it("parses a hard bounce with the original's Message-ID and subject", () => {
		const events = parse_dsn(DSN_HARD)
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: "bounced",
			provider: "smtp",
			email: "gone@example.com",
			message_id: "<original@example.com>",
			subject: "The original subject",
			bounce: { category: "hard", detail: "550 5.1.1 mailbox unavailable" },
		})
		expect(events[0].timestamp?.toISOString()).toBe("2026-08-21T09:14:58.000Z")
	})

	it("classifies 4.x.x as a soft delay or bounce and reads rfc822-headers parts", () => {
		const dsn = DSN_HARD.replace("Action: failed", "Action: delayed")
			.replace("Status: 5.1.1", "Status: 4.4.1")
			.replace("Content-Type: message/rfc822", "Content-Type: text/rfc822-headers")
		const events = parse_dsn(dsn)
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe("delayed")
		expect(events[0].message_id).toBe("<original@example.com>")
	})

	it("reports success DSNs as delivered", () => {
		const events = parse_dsn(
			DSN_HARD.replace("Action: failed", "Action: delivered").replace(
				"Status: 5.1.1",
				"Status: 2.0.0"
			)
		)
		expect(events[0].type).toBe("delivered")
		expect(events[0].bounce).toBeUndefined()
	})

	it("emits one event per recipient group", () => {
		const dsn = DSN_HARD.replace(
			["Final-Recipient: rfc822; gone@example.com", "Action: failed", "Status: 5.1.1"].join("\r\n"),
			[
				"Final-Recipient: rfc822; gone@example.com",
				"Action: failed",
				"Status: 5.1.1",
				"",
				"Final-Recipient: rfc822; also-gone@example.com",
				"Action: failed",
				"Status: 5.2.2",
			].join("\r\n")
		)
		const events = parse_dsn(dsn)
		expect(events.map((e) => e.email)).toEqual(["gone@example.com", "also-gone@example.com"])
	})

	it("returns [] for ordinary mail, never throwing", () => {
		expect(parse_dsn("From: a@b.c\r\nSubject: hi\r\n\r\nJust a normal email.")).toEqual([])
		expect(parse_dsn("")).toEqual([])
		expect(parse_dsn("garbage with no headers at all")).toEqual([])
	})

	it("tolerates LF-only line endings", () => {
		const events = parse_dsn(DSN_HARD.replace(/\r\n/g, "\n"))
		expect(events).toHaveLength(1)
		expect(events[0].email).toBe("gone@example.com")
	})
})

/**
 * A throwaway plaintext POP3 server holding one DSN and one ordinary message. Answers
 * -ERR to STLS, so the opportunistic upgrade continues in plaintext (same posture the
 * SMTP fake exercises by not advertising STARTTLS).
 */
function fake_pop3(): Promise<{ port: number; deleted: () => Array<string>; close: () => void }> {
	const messages: Record<string, string> = {
		"1": DSN_HARD,
		"2": "From: friend@example.com\r\nSubject: lunch?\r\n\r\nNoon?",
	}
	const uids: Record<string, string> = { "1": "uid-dsn", "2": "uid-plain" }
	const deleted: Array<string> = []
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8")
		socket.on("error", () => {})
		socket.write("+OK fake POP3 ready\r\n")
		let buffer = ""
		socket.on("data", (chunk: string) => {
			buffer += chunk
			let nl: number
			while ((nl = buffer.indexOf("\r\n")) !== -1) {
				const line = buffer.slice(0, nl)
				buffer = buffer.slice(nl + 2)
				if (line === "STLS") socket.write("-ERR no TLS here\r\n")
				else if (line.startsWith("USER")) socket.write("+OK\r\n")
				else if (line.startsWith("PASS")) socket.write("+OK logged in\r\n")
				else if (line === "UIDL") {
					const listing = Object.entries(uids)
						.filter(([n]) => !deleted.includes(n))
						.map(([n, uid]) => `${n} ${uid}`)
						.join("\r\n")
					socket.write(`+OK\r\n${listing ? listing + "\r\n" : ""}.\r\n`)
				} else if (line.startsWith("RETR")) {
					const n = line.split(" ")[1]
					// Byte-stuff leading dots per RFC 1939.
					const body = messages[n].replace(/^\./gm, "..")
					socket.write(`+OK\r\n${body}\r\n.\r\n`)
				} else if (line.startsWith("DELE")) {
					deleted.push(line.split(" ")[1])
					socket.write("+OK\r\n")
				} else if (line === "QUIT") socket.write("+OK bye\r\n")
				else socket.write("+OK\r\n")
			}
		})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as net.AddressInfo).port
			resolve({ port, deleted: () => deleted, close: () => server.close() })
		})
	})
}

let srv: Awaited<ReturnType<typeof fake_pop3>> | undefined
afterEach(() => {
	srv?.close()
	srv = undefined
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe("poll — smtp (POP3 + DSN)", () => {
	const options = (port: number) => ({
		host: "127.0.0.1",
		port: String(port),
		user: "bounces",
		pass: "pw",
		secure: "false",
	})

	it("polls the mailbox, parses DSNs, and a second poll with the cursor yields nothing", async () => {
		srv = await fake_pop3()
		const first = await poll({ provider: "smtp", options: options(srv.port) })
		expect(first.events).toHaveLength(1)
		expect(first.events[0]).toMatchObject({ type: "bounced", email: "gone@example.com" })
		expect(first.more).toBeFalsy()

		const second = await poll({
			provider: "smtp",
			options: options(srv.port),
			cursor: first.cursor,
		})
		expect(second.events).toEqual([])
		expect(srv.deleted()).toEqual([])
	})

	it("deletes processed messages when asked", async () => {
		srv = await fake_pop3()
		await poll({ provider: "smtp", options: { ...options(srv.port), delete: "1" } })
		expect(srv.deleted()).toEqual(["1", "2"])
	})

	it("respects the limit and reports more", async () => {
		srv = await fake_pop3()
		const result = await poll({ provider: "smtp", options: options(srv.port), limit: 1 })
		expect(result.more).toBe(true)
		const rest = await poll({
			provider: "smtp",
			options: options(srv.port),
			cursor: result.cursor,
		})
		expect(rest.more).toBeFalsy()
	})
})

const graph_json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// Unique tenant per test — the adapter caches tokens per tenant:client across calls.
const ms_options = (tenant: string) => ({ tenant_id: tenant, client_id: "c", client_secret: "s" })

describe("poll — microsoft365 (Graph message trace)", () => {
	const trace = (id: string, status: string, received: string) => ({
		id,
		senderAddress: "no-reply@example.com",
		recipientAddress: "user@example.com",
		messageId: `<${id}@example.com>`,
		receivedDateTime: received,
		subject: "Hello",
		status,
	})

	it("pages traces, maps terminal statuses, and skips pending", async () => {
		const now = new Date().toISOString()
		const fetch_mock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(graph_json({ access_token: "tok", expires_in: 3600 }))
			.mockResolvedValueOnce(
				graph_json({
					value: [trace("a", "delivered", now), trace("b", "pending", now)],
					"@odata.nextLink": "https://graph.microsoft.com/page2",
				})
			)
			.mockResolvedValueOnce(graph_json({ value: [trace("c", "failed", now)] }))

		const result = await poll({ provider: "microsoft365", options: ms_options("t-pages") })
		expect(result.events.map((e) => [e.type, e.message_id])).toEqual([
			["delivered", "<a@example.com>"],
			["bounced", "<c@example.com>"],
		])
		expect(result.more).toBeFalsy()
		// Token request, page 1, page 2 (followed via nextLink).
		expect(fetch_mock).toHaveBeenCalledTimes(3)
		expect(String(fetch_mock.mock.calls[2][0])).toBe("https://graph.microsoft.com/page2")
	})

	it("dedupes overlap re-reads via the cursor's seen ids", async () => {
		const now = new Date().toISOString()
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(graph_json({ access_token: "tok", expires_in: 3600 }))
			.mockResolvedValueOnce(graph_json({ value: [trace("a", "delivered", now)] }))
		const first = await poll({ provider: "microsoft365", options: ms_options("t-dedupe") })
		expect(first.events).toHaveLength(1)

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			graph_json({ value: [trace("a", "delivered", now)] })
		)
		const second = await poll({
			provider: "microsoft365",
			options: ms_options("t-dedupe"),
			cursor: first.cursor,
		})
		expect(second.events).toEqual([])
	})

	it("explains the Graph permission on 403", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(graph_json({ access_token: "tok", expires_in: 3600 }))
			.mockResolvedValueOnce(graph_json({ error: { code: "Authorization_RequestDenied" } }, 403))
		const error = await poll({ provider: "microsoft365", options: ms_options("t-403") }).catch(
			(e) => e
		)
		expect(error.message).toContain("ExchangeMessageTrace.Read.All")
		expect(error.message).toContain("8bd644d1-64a1-4d4b-ae52-2e0cbf64e373")
	})
})

describe("poll — cloudflare (Queues pull)", () => {
	// queue_id pinned empty: the polluted-env CI run fills CLOUDFLARE_QUEUE_ID, and these
	// tests exercise the provisioning path a configured id would skip.
	const CF_OPTIONS = { api_key: "cf-token", account_id: "acct", queue_id: "" }
	const envelope = (result: unknown) => graph_json({ success: true, errors: [], result })
	const event = (kind: string) => ({
		body: JSON.stringify({
			type: `cf.email.sending.message.${kind}`,
			payload: {
				messageId: "cf-msg-1",
				recipient: "user@example.com",
				subject: "Hello",
				smtpResponse: kind === "bounced" ? "550 5.1.1 no such user" : "250 OK",
			},
		}),
		lease_id: `lease-${kind}`,
		timestamp_ms: Date.now(),
	})

	it("pulls, normalizes and acks with an existing queue id", async () => {
		const fetch_mock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				envelope({ messages: [event("delivered"), event("bounced")], message_backlog_count: 2 })
			)
			.mockResolvedValueOnce(envelope({}))

		const result = await poll({
			provider: "cloudflare",
			options: { ...CF_OPTIONS, queue_id: "q-1" },
		})
		expect(result.events.map((e) => e.type)).toEqual(["delivered", "bounced"])
		expect(result.events[1].bounce).toEqual({
			category: "hard",
			detail: "550 5.1.1 no such user",
		})
		expect(result.cursor).toBe(JSON.stringify({ queue_id: "q-1" }))

		const [pull, ack] = fetch_mock.mock.calls
		expect(String(pull[0])).toContain("/queues/q-1/messages/pull")
		expect(String(ack[0])).toContain("/queues/q-1/messages/ack")
		expect(JSON.parse(String(ack[1]?.body))).toEqual({
			acks: [{ lease_id: "lease-delivered" }, { lease_id: "lease-bounced" }],
		})
	})

	it("provisions the queue and consumer, then asks for the manual subscription step", async () => {
		const fetch_mock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(envelope([])) // list queues — none
			.mockResolvedValueOnce(envelope({ queue_id: "q-new" })) // create queue
			.mockResolvedValueOnce(envelope({})) // create http_pull consumer
			.mockResolvedValueOnce(envelope({ messages: [], message_backlog_count: 0 })) // first pull

		const error = await poll({ provider: "cloudflare", options: CF_OPTIONS }).catch((e) => e)
		expect(error).toMatchObject({ code: "poll_provisioning_failed", provider: "cloudflare" })
		expect(error.message).toContain("q-new")
		expect(error.message).toContain("CLOUDFLARE_QUEUE_ID")
		expect(fetch_mock).toHaveBeenCalledTimes(4)
	})

	it("self-heals once events arrive on a just-provisioned queue", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				envelope([{ queue_id: "q-found", queue_name: "postboi-email-events" }])
			)
			.mockResolvedValueOnce(envelope({})) // consumer add (already exists — still fine)
			.mockResolvedValueOnce(
				envelope({ messages: [event("complained")], message_backlog_count: 1 })
			)
			.mockResolvedValueOnce(envelope({})) // ack

		const result = await poll({ provider: "cloudflare", options: CF_OPTIONS })
		expect(result.events[0].type).toBe("complained")
		expect(result.cursor).toBe(JSON.stringify({ queue_id: "q-found" }))
	})

	it("surfaces token-scope failures as poll_provisioning_failed", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			graph_json(
				{ success: false, errors: [{ code: 10000, message: "Authentication error" }] },
				403
			)
		)
		const error = await poll({ provider: "cloudflare", options: CF_OPTIONS }).catch((e) => e)
		expect(error).toMatchObject({ code: "poll_provisioning_failed" })
		expect(error.message).toContain("Authentication error")
	})
})

describe("poll — twilio (SMS and WhatsApp)", () => {
	// Options are always explicit: the polluted-env CI run fills TWILIO_*, and a test
	// that quietly picked up a real account SID would be testing the environment.
	const TW_OPTIONS = { account_sid: "AC-test", auth_token: "tok-test" }

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status }) as never

	function message(overrides: Record<string, unknown> = {}) {
		return {
			sid: "SM1",
			status: "delivered",
			to: "+15557770006",
			from: "+15551110001",
			direction: "outbound-api",
			date_sent: "2026-09-01T10:00:00Z",
			...overrides,
		}
	}

	it("asks for a trailing window of the Message resource, with basic auth", async () => {
		const fetch_mock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json({ messages: [message()] }))
		await poll({ provider: "twilio", options: TW_OPTIONS, limit: 25 })

		const url = new URL(String(fetch_mock.mock.calls[0][0]))
		expect(url.origin + url.pathname).toBe(
			"https://api.twilio.com/2010-04-01/Accounts/AC-test/Messages.json"
		)
		expect(url.searchParams.get("PageSize")).toBe("25")
		// Date-granular, and yesterday-or-earlier: a message sent last night and
		// delivered this morning still carries last night's DateSent.
		const since = url.searchParams.get("DateSent>=") ?? ""
		expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(new Date(since).getTime()).toBeLessThanOrEqual(Date.now())

		const headers = (fetch_mock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
		expect(headers.Authorization).toBe(`Basic ${btoa("AC-test:tok-test")}`)
	})

	it("tags the channel from the address and never fills email", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({
				messages: [
					message({ sid: "SM-sms" }),
					message({ sid: "SM-wa", to: "whatsapp:+15557770006", from: "whatsapp:+15551110001" }),
				],
			})
		)
		const result = await poll({ provider: "twilio", options: TW_OPTIONS })
		expect(result.events).toMatchObject([
			{ message_id: "SM-sms", channel: "sms", phone: "+15557770006", type: "delivered" },
			{ message_id: "SM-wa", channel: "whatsapp", phone: "+15557770006", type: "delivered" },
		])
		for (const event of result.events) expect(event.email).toBeUndefined()
	})

	it("maps the statuses worth an event and stays quiet about the rest", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({
				messages: [
					message({ sid: "a", status: "sent" }),
					message({ sid: "b", status: "delivered" }),
					message({ sid: "c", status: "undelivered", error_code: 30006 }),
					message({ sid: "d", status: "failed", error_message: "Unknown error" }),
					message({ sid: "e", status: "read", to: "whatsapp:+15557770006" }),
					// In flight: the provider thinking, not something that happened.
					message({ sid: "f", status: "queued" }),
					message({ sid: "g", status: "sending" }),
					message({ sid: "h", status: "accepted" }),
					// Somebody writing to us: a reply, not a receipt for a send.
					message({ sid: "i", status: "received", direction: "inbound", body: "Thanks!" }),
				],
			})
		)
		const result = await poll({ provider: "twilio", options: TW_OPTIONS })
		expect(result.events.map((event) => [event.message_id, event.type])).toEqual([
			["a", "sent"],
			["b", "delivered"],
			["c", "failed"],
			["d", "failed"],
			["e", "opened"],
			["i", "received"],
		])
		// The carrier's own words, in the field consumers already read.
		expect(result.events[2].bounce).toEqual({ category: "unknown", detail: "30006" })
		expect(result.events[3].bounce?.detail).toBe("Unknown error")
	})

	it("reads inbound keywords and replies from the number that sent them", async () => {
		const inbound = (overrides: Record<string, unknown>) =>
			message({
				status: "received",
				direction: "inbound",
				// The reply travels the other way: our number is `to`, theirs is `from`.
				to: "+15551110001",
				from: "+15557770006",
				...overrides,
			})
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({
				messages: [
					inbound({ sid: "r1", body: "STOP" }),
					inbound({ sid: "r2", body: "stop." }),
					inbound({
						sid: "r3",
						body: "Unsubscribe",
						to: "whatsapp:+15551110001",
						from: "whatsapp:+15557770006",
					}),
					// A sentence is a person to talk to, not a flag to set.
					inbound({ sid: "r4", body: "please stop texting me" }),
					inbound({ sid: "r5", body: "What time do you open?" }),
					inbound({ sid: "r6", body: "Start" }),
					inbound({ sid: "r7", body: "HELP" }),
				],
			})
		)
		const result = await poll({ provider: "twilio", options: TW_OPTIONS })
		expect(result.events).toMatchObject([
			{ message_id: "r1", type: "unsubscribed", keyword: "stop", phone: "+15557770006" },
			{ message_id: "r2", type: "unsubscribed", channel: "sms", phone: "+15557770006" },
			{ message_id: "r3", type: "unsubscribed", channel: "whatsapp", phone: "+15557770006" },
			{ message_id: "r4", type: "received", body: { text: "please stop texting me" } },
			{ message_id: "r5", type: "received", body: { text: "What time do you open?" } },
			{ message_id: "r6", type: "resubscribed", keyword: "start", phone: "+15557770006" },
			{ message_id: "r7", type: "received", keyword: "help", body: { text: "HELP" } },
		])
		expect(result.events[3].keyword).toBeUndefined()
		for (const event of result.events) expect(event.email).toBeUndefined()

		// An inbound message never changes status, so the cursor emits it exactly once.
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({ messages: [inbound({ sid: "r1", body: "STOP" })] })
		)
		const again = await poll({ provider: "twilio", options: TW_OPTIONS, cursor: result.cursor })
		expect(again.events).toEqual([])
	})

	it("re-emits on a status change, not on a sid it has seen", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({ messages: [message({ sid: "SM9", status: "sent" })] })
		)
		const first = await poll({ provider: "twilio", options: TW_OPTIONS })
		expect(first.events.map((event) => event.type)).toEqual(["sent"])

		// The same row, listed again unchanged: nothing happened.
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({ messages: [message({ sid: "SM9", status: "sent" })] })
		)
		const again = await poll({ provider: "twilio", options: TW_OPTIONS, cursor: first.cursor })
		expect(again.events).toEqual([])

		// The same row, now delivered: that is the transition the poller exists for.
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({ messages: [message({ sid: "SM9", status: "delivered" })] })
		)
		const moved = await poll({ provider: "twilio", options: TW_OPTIONS, cursor: again.cursor })
		expect(moved.events.map((event) => event.type)).toEqual(["delivered"])
	})

	it("remembers in-flight statuses too, so a queued row doesn't re-emit at every poll", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({ messages: [message({ sid: "SM8", status: "queued" })] })
		)
		const first = await poll({ provider: "twilio", options: TW_OPTIONS })
		expect(first.events).toEqual([])
		expect(JSON.parse(first.cursor ?? "{}").seen).toEqual({ SM8: "queued" })

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({ messages: [message({ sid: "SM8", status: "delivered" })] })
		)
		const second = await poll({ provider: "twilio", options: TW_OPTIONS, cursor: first.cursor })
		expect(second.events.map((event) => event.type)).toEqual(["delivered"])
	})

	it("reports a backlog when the page came back full", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({ messages: [message({ sid: "x" }), message({ sid: "y" })] })
		)
		const full = await poll({ provider: "twilio", options: TW_OPTIONS, limit: 2 })
		expect(full.more).toBe(true)

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ messages: [message({ sid: "z" })] }))
		const partial = await poll({ provider: "twilio", options: TW_OPTIONS, limit: 2 })
		expect(partial.more).toBe(false)
	})

	it("rejects a cursor that doesn't parse, so the caller can drop it", async () => {
		const error = await poll({
			provider: "twilio",
			options: TW_OPTIONS,
			cursor: "not json",
		}).catch((e) => e)
		expect(error).toMatchObject({ code: "invalid_cursor", provider: "twilio" })
	})

	it("surfaces Twilio's own error rather than an empty page", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			json({ code: 20003, message: "Authenticate" }, 401)
		)
		const error = await poll({ provider: "twilio", options: TW_OPTIONS }).catch((e) => e)
		expect(error).toMatchObject({ provider: "twilio", status: 401, code: 20003 })
		expect(error.message).toBe("Authenticate")
	})
})

describe("mock_poll", () => {
	it("builds realistic results for every polling provider", async () => {
		for (const provider of Object.keys(POLL_MODULES)) {
			// A text message has no bounce classification — there is no mailbox to be
			// permanently or temporarily unavailable — so the failure type differs by
			// channel. Everything else about the fixture is the same shape.
			const failure = provider === "twilio" ? "failed" : "bounced"
			const failed = await mock_poll({ provider, type: failure })
			expect(failed.events[0]).toMatchObject({ type: failure, provider })
			expect(failed.events[0].bounce?.category).toBeTruthy()
			expect(failed.cursor).toBeTruthy()

			const delivered = await mock_poll({ provider, type: "delivered" })
			expect(delivered.events[0]).toMatchObject({ type: "delivered", provider })
		}
	})

	it("builds both of Twilio's channels, and puts the number where numbers go", async () => {
		const sms = await mock_poll({ provider: "twilio", type: "delivered" })
		expect(sms.events[0]).toMatchObject({ channel: "sms", phone: "+15557770006" })
		expect(sms.events[0].email).toBeUndefined()

		const whatsapp = await mock_poll({ provider: "twilio", type: "opened", channel: "whatsapp" })
		// WhatsApp's read receipt is the same fact as an email open.
		expect(whatsapp.events[0]).toMatchObject({
			type: "opened",
			channel: "whatsapp",
			phone: "+15557770006",
		})

		// The one inbound sample: the person texting STOP, so the number is still theirs.
		const stop = await mock_poll({ provider: "twilio", type: "unsubscribed" })
		expect(stop.events[0]).toMatchObject({
			type: "unsubscribed",
			channel: "sms",
			phone: "+15557770006",
		})
	})

	it("throws polling_not_supported for providers without a poll mock", async () => {
		const error = await mock_poll({ provider: "resend" }).catch((e) => e)
		expect(error).toMatchObject({ code: "polling_not_supported", provider: "resend" })
	})
})
