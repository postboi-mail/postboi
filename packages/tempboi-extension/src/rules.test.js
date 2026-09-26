import { describe, expect, test } from "bun:test"
import {
	ago,
	can_extend,
	clean_name,
	clean_token,
	extended_ttl,
	has_remote_images,
	initial,
	latest_code,
	merge,
	message_page,
	notification_for,
	pasted_server,
	push_target,
	same_key,
	key_bytes,
	TEMPBOI_PUSH_KEY,
	reader_document,
	server_origin,
	time_left,
	unread_count,
} from "./rules.js"

const NOW = Date.parse("2026-09-26T12:00:00Z")
const at = (ms) => new Date(NOW + ms).toISOString()
const message = (seq, extra = {}) => ({ id: `tmsg_${seq}`, seq, from: "a@b.c", ...extra })

describe("tokens and servers", () => {
	test("a bare token", () => {
		expect(clean_token("  tb_0123456789abcdef  ")).toBe("tb_0123456789abcdef")
	})
	test("the page's terminal command", () => {
		const pasted = "POSTBOI_INBOX_TOKEN=tb_0123456789abcdef npx tempboi watch"
		expect(clean_token(pasted)).toBe("tb_0123456789abcdef")
		expect(pasted_server(pasted)).toBeUndefined()
	})
	test("a preview's command names its server", () => {
		const pasted =
			"POSTBOI_INBOX_URL=https://postboi-preview-x.dev.workers.dev POSTBOI_INBOX_TOKEN=tb_0123456789abcdef npx tempboi watch"
		expect(clean_token(pasted)).toBe("tb_0123456789abcdef")
		expect(pasted_server(pasted)).toBe("https://postboi-preview-x.dev.workers.dev")
	})
	test("not a token", () => {
		expect(clean_token("pb_live_123")).toBeUndefined()
		expect(clean_token("tb_short")).toBeUndefined()
		expect(clean_token(undefined)).toBeUndefined()
	})
	test("server origins", () => {
		expect(server_origin("https://tempboi.email/")).toBe("https://tempboi.email")
		expect(server_origin("http://localhost:5173/tempboi")).toBe("http://localhost:5173")
		expect(server_origin("javascript:alert(1)")).toBeUndefined()
		expect(server_origin("")).toBeUndefined()
	})
})

test("names are put the way the server takes them", () => {
	expect(clean_name(" My Test ")).toBe("my-test")
	expect(clean_name("signup@tempboi.email")).toBe("signup")
	expect(clean_name("---")).toBeUndefined()
	expect(clean_name("a".repeat(40))).toHaveLength(24)
})

describe("time", () => {
	test("time left", () => {
		expect(time_left(at(30_000), NOW)).toBe("30s")
		expect(time_left(at(42 * 60_000), NOW)).toBe("42m")
		expect(time_left(at(65 * 60_000), NOW)).toBe("1h 5m")
		expect(time_left(at(2 * 3600_000), NOW)).toBe("2h")
		expect(time_left(at(-1), NOW)).toBe("Expired")
	})
	test("ago", () => {
		expect(ago(at(-10_000), NOW)).toBe("now")
		expect(ago(at(-5 * 60_000), NOW)).toBe("5m")
		expect(ago(at(-3 * 3600_000), NOW)).toBe("3h")
	})
	test("+1h adds to what is left, in seconds", () => {
		expect(extended_ttl(at(10 * 60_000), 3600_000, NOW)).toBe(4200)
		expect(extended_ttl(at(-60_000), 3600_000, NOW)).toBe(3600)
	})
	test("+1h stops at the day cap", () => {
		expect(can_extend(at(0), at(3600_000))).toBe(true)
		expect(can_extend(at(0), at(24 * 3600_000))).toBe(false)
	})
})

describe("merging pages", () => {
	test("dedupes, sorts newest first, reports only what is new", () => {
		const held = { messages: [message(2), message(1)], cursor: 2 }
		const merged = merge(held, { data: [message(2), message(3), message(4)], cursor: 4 })
		expect(merged.messages.map((each) => each.seq)).toEqual([4, 3, 2, 1])
		expect(merged.fresh.map((each) => each.seq)).toEqual([3, 4])
		expect(merged.cursor).toBe(4)
	})
	test("the cursor never goes back", () => {
		expect(merge({ messages: [], cursor: 9 }, { data: [], cursor: 3 }).cursor).toBe(9)
	})
	test("caps what is held", () => {
		const data = Array.from({ length: 5 }, (_, n) => message(n + 1))
		expect(merge({}, { data, cursor: 5 }, 3).messages.map((each) => each.seq)).toEqual([5, 4, 3])
	})
})

test("unread and the latest code", () => {
	const messages = [message(3), message(2, { code: "482913" }), message(1, { code: "111111" })]
	expect(unread_count(messages, ["tmsg_3"])).toBe(2)
	expect(latest_code(messages)?.code).toBe("482913")
	expect(latest_code([message(1)])).toBeUndefined()
})

test("senders", () => {
	expect(initial({ from_name: "  ", from: "hello@acme.dev" })).toBe("H")
	expect(initial({ from_name: '"Acme"', from: "x@y.z" })).toBe("A")
	expect(initial({})).toBe("U")
})

test("a message's page is its own path, with the token still after the #", () => {
	const inbox = (address, web) => ({ address, urls: { web } })
	expect(
		message_page(
			inbox("bright-otter@tempboi.email", "https://tempboi.email/bright-otter#t=tb_abc"),
			"tmsg_1"
		)
	).toBe("https://tempboi.email/bright-otter/tmsg_1#t=tb_abc")
	expect(
		message_page(inbox("box@tempboi.email", "http://localhost:5173/tempboi/box#t=tb_abc"), "tmsg_1")
	).toBe("http://localhost:5173/tempboi/box/tmsg_1#t=tb_abc")
	expect(
		message_page(
			inbox("box@reply.acme.com", "https://tempboi.email/#t=tb_abc&a=box%40reply.acme.com"),
			"tmsg_1"
		)
	).toBe("https://tempboi.email/box/tmsg_1#t=tb_abc&a=box%40reply.acme.com")
})

describe("the reader's document", () => {
	test("holds back remote loads by default", () => {
		const doc = reader_document({ html: '<img src="https://track.example/p.gif">' })
		expect(doc).toContain("img-src data: cid:;")
		expect(doc).not.toContain("img-src data: cid: https:")
		expect(doc).toContain('<base target="_blank">')
	})
	test("lets images through when asked", () => {
		expect(reader_document({ html: "<p>hi</p>" }, { images: true })).toContain(
			"img-src data: cid: https: http:"
		)
	})
	test("text is escaped and its links drawn", () => {
		const doc = reader_document({ html: null, text: "<b>hi</b> https://x.dev/v?a=1" })
		expect(doc).toContain("&lt;b&gt;hi&lt;/b&gt;")
		expect(doc).toContain('<a href="https://x.dev/v?a=1" rel="noreferrer">')
	})
	test("spots remote images", () => {
		expect(has_remote_images('<img alt="" src="https://x/y.png">')).toBe(true)
		expect(has_remote_images('<td style="background:url(https://x/y.png)">')).toBe(true)
		expect(has_remote_images('<img src="data:image/png;base64,AA">')).toBe(false)
	})
})

test("notifications lead with the code", () => {
	expect(
		notification_for(message(1, { code: "482913", subject: "Your code", from_name: "Acme" }))
	).toEqual({
		title: "Code 482913",
		message: "Acme: Your code",
	})
	expect(notification_for(message(1, { subject: "" })).title).toBe("New mail from a@b.c")
})

describe("following by push", () => {
	const held = { address: "bright-otter@tempboi.email", server: "https://tempboi.email" }
	test("the inbox's own answer wins", () => {
		const push = { key: "BAAA", url: "https://x.dev/v1/inboxes/a@b/push" }
		expect(push_target({ ...held, push })).toEqual(push)
	})
	test("tempboi.email is known to push before it says so", () => {
		expect(push_target(held)).toEqual({
			key: TEMPBOI_PUSH_KEY,
			url: "https://tempboi.email/v1/inboxes/bright-otter%40tempboi.email/push",
		})
	})
	test("another server without a key is polled", () => {
		expect(push_target({ ...held, server: "http://localhost:5173" })).toBeUndefined()
		expect(push_target({ ...held, push: null, server: "http://localhost:5173" })).toBeUndefined()
	})
	test("a gone inbox is followed by nobody", () => {
		expect(push_target({ ...held, gone: true })).toBeUndefined()
		expect(push_target(undefined)).toBeUndefined()
	})
	test("the key is a P-256 point", () => {
		const bytes = key_bytes(TEMPBOI_PUSH_KEY)
		expect(bytes.length).toBe(65)
		expect(bytes[0]).toBe(4)
		expect(same_key(bytes.buffer, TEMPBOI_PUSH_KEY)).toBe(true)
		expect(same_key(new Uint8Array(65).buffer, TEMPBOI_PUSH_KEY)).toBe(false)
		expect(same_key(null, TEMPBOI_PUSH_KEY)).toBe(false)
	})
})
