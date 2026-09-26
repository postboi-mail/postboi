import { fetch_file, read_message, TempboiError } from "./api.js"
import {
	ago,
	can_extend,
	clean_name,
	file_size,
	has_remote_images,
	initial,
	message_page,
	POLL_SECONDS,
	reader_document,
	sender,
	time_left,
	unread_count,
} from "./rules.js"
import {
	drop_inbox,
	extend,
	load_state,
	mark_seen,
	new_inbox,
	sync,
	update_badge,
} from "./state.js"

/**
 * The popup: the address card, the list, and a reader. Everything drawn here is built
 * with textContent; the one piece of a stranger's markup, a message's html, only ever
 * goes into a sandboxed frame with scripts off and remote loads held back.
 */

const main = document.getElementById("main")
const status = document.getElementById("status")
const web = document.getElementById("web")

/** What the popup is showing. `reading` is a message id; `images` the ids let load them. */
const view = { reading: undefined, naming: false, busy: false, images: new Set() }
let held = await load_state()
/** The full messages already fetched for the reader, by id. */
const full = new Map()

function h(tag, props = {}, ...children) {
	const node = document.createElement(tag)
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === false) continue
		if (key.startsWith("on")) node.addEventListener(key.slice(2), value)
		else if (key === "class") node.className = value
		else if (key === "text") node.textContent = value
		else node.setAttribute(key, value === true ? "" : value)
	}
	for (const child of children.flat()) {
		if (child === undefined || child === null || child === false) continue
		node.append(child instanceof Node ? child : document.createTextNode(String(child)))
	}
	return node
}

function say(words, { error = false } = {}) {
	status.textContent = words ?? ""
	status.classList.toggle("error", error)
}

function fail(error) {
	say(error?.message ?? "Something went wrong.", { error: true })
}

/** Copy, and say so on the thing that was pressed: feedback at the pointer. */
async function copy(text, button, done = "Copied") {
	await navigator.clipboard.writeText(text)
	if (!button) return
	const was = button.dataset.label ?? button.textContent
	button.dataset.label = was
	button.textContent = done
	setTimeout(() => {
		button.textContent = was
	}, 1400)
}

async function act(work) {
	if (view.busy) return
	view.busy = true
	say("")
	render()
	try {
		await work()
	} catch (error) {
		fail(error)
	} finally {
		view.busy = false
		held = await load_state()
		render()
	}
}

// ---------------------------------------------------------------------------------------

function render() {
	const { inbox } = held
	web.disabled = !inbox || inbox.gone
	main.replaceChildren()
	if (!inbox) return main.append(first_run())
	if (inbox.gone) return main.append(gone_card(inbox))
	const reading = view.reading && held.messages.find((message) => message.id === view.reading)
	if (reading) return main.append(reader(reading))
	main.append(address_card(inbox), inbox_list())
}

function first_run() {
	return h(
		"section",
		{ class: "slip card" },
		h("h1", { class: "poster" }, "A throwaway inbox, ", h("span", { class: "hot" }, "right here")),
		h(
			"p",
			{ class: "lede" },
			"No sign-up. Codes are picked out as they land, and a right-click fills your address into any form."
		),
		h(
			"button",
			{ class: "key", type: "button", disabled: view.busy, onclick: () => act(() => new_inbox()) },
			view.busy ? "Making one…" : "Give me an address"
		),
		h(
			"p",
			{ class: "small-print" },
			"Made one on tempboi.email already? ",
			h("button", { type: "button", onclick: open_settings }, "Open it here with its token"),
			"."
		)
	)
}

function gone_card(inbox) {
	return h(
		"section",
		{ class: "slip card" },
		h("p", { class: "label" }, "Expired"),
		h("h1", { class: "poster" }, "That inbox is ", h("span", { class: "hot" }, "gone")),
		h(
			"p",
			{ class: "lede" },
			`${inbox.address} has expired or was deleted, and its mail went with it.`
		),
		h(
			"button",
			{
				class: "key",
				type: "button",
				disabled: view.busy,
				onclick: () =>
					act(async () => {
						await drop_inbox()
						await new_inbox()
					}),
			},
			"New address"
		)
	)
}

function address_card(inbox) {
	const left = time_left(inbox.expires)
	const low = new Date(inbox.expires).getTime() - Date.now() < 5 * 60 * 1000
	const copy_key = h("button", { class: "key", type: "button" }, "Copy")
	copy_key.addEventListener("click", () => copy(inbox.address, copy_key))
	const card = h(
		"section",
		{ class: "slip card" },
		h(
			"div",
			{ class: "row split" },
			h("span", { class: "label" }, "Your address"),
			h("span", { class: `clock${low ? " low" : ""}`, id: "clock" }, clock_words(left))
		),
		h(
			"button",
			{
				class: "address",
				type: "button",
				title: "Copy",
				onclick: (event) => copy(inbox.address, undefined).then(() => flash(event.currentTarget)),
			},
			inbox.address
		),
		h(
			"div",
			{ class: "row" },
			copy_key,
			h(
				"div",
				{ class: "actions" },
				h(
					"button",
					{
						class: "key plain small",
						type: "button",
						title: "Keep it an hour longer",
						disabled: view.busy || !can_extend(inbox.created, inbox.expires),
						onclick: () => act(extend),
					},
					"+1h"
				),
				h(
					"button",
					{
						class: "key plain small",
						type: "button",
						disabled: view.busy,
						onclick: () => {
							view.naming = !view.naming
							render()
						},
					},
					"New"
				),
				h(
					"button",
					{
						class: "key plain small danger",
						type: "button",
						title: "Delete this inbox and its mail now",
						disabled: view.busy,
						onclick: () => act(drop_inbox),
					},
					"Delete"
				)
			)
		)
	)
	if (view.naming) card.append(name_form(inbox))
	return card
}

function clock_words(left) {
	return left === "Expired" ? "Expired" : `Gone in ${left}`
}

function flash(node) {
	const was = node.textContent
	node.textContent = "Copied"
	setTimeout(() => (node.textContent = was), 900)
}

/** A new address, random or named. The old inbox is deleted: one inbox at a time. */
function name_form(inbox) {
	const input = h("input", {
		class: "field mono",
		type: "text",
		placeholder: "random",
		"aria-label": "Name for the new address",
		autocomplete: "off",
		spellcheck: "false",
		maxlength: "24",
	})
	const form = h(
		"form",
		{
			class: "name-form",
			onsubmit: (event) => {
				event.preventDefault()
				const name = clean_name(input.value)
				act(async () => {
					await drop_inbox()
					await new_inbox({ name })
					view.naming = false
				})
			},
		},
		input,
		h("span", { class: "domain" }, `@${inbox.domain ?? inbox.address.split("@")[1]}`),
		h("button", { class: "key small", type: "submit", disabled: view.busy }, "Make it")
	)
	queueMicrotask(() => input.focus())
	return form
}

function inbox_list() {
	const { messages, seen } = held
	const unread = unread_count(messages, seen)
	const section = h(
		"section",
		{},
		h(
			"div",
			{ class: "list-head" },
			h("span", { class: "label" }, "Inbox"),
			h(
				"span",
				{ class: "label" },
				messages.length
					? `${messages.length} ${messages.length === 1 ? "message" : "messages"}${unread ? `, ${unread} new` : ""}`
					: ""
			)
		)
	)
	if (!messages.length) {
		section.append(
			h(
				"div",
				{ class: "empty" },
				h("img", { src: "../assets/boi.svg", alt: "" }),
				h("strong", {}, "Nothing here yet"),
				h("span", {}, "Mail lands here the moment it arrives.")
			)
		)
		return section
	}
	const opened = new Set(seen)
	section.append(
		h(
			"ul",
			{ class: "list" },
			messages.map((message) => row(message, opened))
		)
	)
	return section
}

function face(message) {
	if (message.logo?.startsWith("data:image/"))
		return h("span", { class: "face" }, h("img", { src: message.logo, alt: "" }))
	return h("span", { class: "face", "aria-hidden": "true" }, initial(message))
}

function row(message, opened) {
	const open = () => read(message.id)
	const item = h(
		"li",
		{
			class: `item${opened.has(message.id) ? "" : " unread"}`,
			tabindex: "0",
			role: "button",
			onclick: open,
			onkeydown: (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault()
					open()
				}
			},
		},
		face(message),
		h(
			"div",
			{ style: "min-width:0" },
			h(
				"div",
				{ class: "top" },
				h("span", { class: "from" }, sender(message)),
				h(
					"span",
					{ class: "when", title: new Date(message.received).toLocaleString() },
					ago(message.received)
				)
			),
			h("div", { class: "subject" }, message.subject?.trim() || "(No subject)"),
			quick(message)
		)
	)
	return item
}

/** The two things a person opened this for: the code, and the link to press. */
function quick(message) {
	if (!message.code && !message.link) return undefined
	const chips = h("div", { class: "chips" })
	if (message.code) {
		const label = h("span", {}, message.code)
		const chip = h(
			"button",
			{ class: "chip", type: "button", title: "Copy the code" },
			label,
			h("span", { class: "hint" }, "Copy")
		)
		chip.addEventListener("click", (event) => {
			event.stopPropagation()
			copy(message.code, label, "Copied")
		})
		chips.append(chip)
	}
	if (message.link) {
		chips.append(
			h(
				"a",
				{
					class: "key small",
					href: message.link,
					target: "_blank",
					rel: "noreferrer",
					title: message.link,
					onclick: (event) => event.stopPropagation(),
				},
				"Open link"
			)
		)
	}
	return chips
}

// ---------------------------------------------------------------------------------------

async function read(id) {
	view.reading = id
	render()
	await mark_seen(id)
	held = await load_state()
	if (full.has(id)) return render()
	try {
		const { inbox } = held
		full.set(id, await read_message(inbox.server, inbox, id))
	} catch (error) {
		fail(error)
	}
	if (view.reading === id) render()
}

function reader(summary) {
	const message = full.get(summary.id)
	const { inbox } = held
	const back = h(
		"button",
		{
			class: "key plain small",
			type: "button",
			onclick: () => {
				view.reading = undefined
				render()
			},
		},
		"← Inbox"
	)
	const bar = h(
		"div",
		{ class: "reader-bar" },
		back,
		h("span", { class: "when" }, new Date(summary.received).toLocaleString())
	)
	const meta = h(
		"dl",
		{ class: "meta" },
		h("dt", {}, "From"),
		h(
			"dd",
			{},
			summary.from_name ? `${summary.from_name} <${summary.from}>` : summary.from || "Unknown",
			summary.logo
				? h(
						"span",
						{ class: "verified", title: "Passed DMARC with a BIMI mark" },
						"Verified sender"
					)
				: undefined
		),
		h("dt", {}, "To"),
		h("dd", {}, summary.to)
	)
	const codes = summary.codes?.length
		? h(
				"div",
				{ class: "chips" },
				summary.codes.map((code) => {
					const label = h("span", {}, code)
					const chip = h(
						"button",
						{ class: "chip", type: "button", title: "Copy" },
						label,
						h("span", { class: "hint" }, "Copy")
					)
					chip.addEventListener("click", () => copy(code, label))
					return chip
				})
			)
		: undefined
	const node = h(
		"article",
		{ class: "reader" },
		bar,
		h("h2", {}, summary.subject?.trim() || "(No subject)"),
		meta,
		codes,
		summary.link
			? h(
					"a",
					{
						class: "key",
						href: summary.link,
						target: "_blank",
						rel: "noreferrer",
						title: summary.link,
					},
					"Open the link it sent"
				)
			: undefined,
		message ? body(message) : h("p", { class: "lede" }, "Opening…"),
		attachments(summary),
		h(
			"div",
			{ class: "reader-foot" },
			h(
				"a",
				{
					class: "key plain small",
					href: message_page(inbox.urls.web, summary.id),
					target: "_blank",
					rel: "noreferrer",
				},
				"Open on the web"
			),
			message?.urls?.raw
				? h(
						"button",
						{
							class: "key plain small",
							type: "button",
							onclick: () => download(message.urls.raw, `${summary.id}.eml`),
						},
						"Download .eml"
					)
				: undefined
		)
	)
	return node
}

function body(message) {
	const images = view.images.has(message.id)
	const frame = h("iframe", {
		title: "Message",
		// No scripts and no forms: links open in a new tab, and that is all. Same-origin is
		// only so the frame can be measured; with scripts off nothing in it can use it.
		sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
		referrerpolicy: "no-referrer",
	})
	frame.srcdoc = reader_document(message, { images })
	frame.addEventListener("load", () => {
		try {
			const height = frame.contentDocument?.documentElement.scrollHeight
			if (height) frame.style.height = `${Math.min(Math.max(height, 160), 1600)}px`
		} catch {
			// Cross-origin by design; the fixed height stands.
		}
	})
	const wrap = h("div", { class: "frame-wrap" })
	if (!images && has_remote_images(message.html))
		wrap.append(
			h(
				"div",
				{ class: "held" },
				h("span", {}, "Remote images are held back, so the sender can't tell you opened it."),
				h(
					"button",
					{
						type: "button",
						onclick: () => {
							view.images.add(message.id)
							render()
						},
					},
					"Show"
				)
			)
		)
	wrap.append(frame)
	return wrap
}

function attachments(summary) {
	if (!summary.attachments?.length) return undefined
	return h(
		"ul",
		{ class: "files" },
		summary.attachments.map((file, n) =>
			h(
				"li",
				{},
				h(
					"button",
					{
						type: "button",
						onclick: () => download(file.url, file.filename || `attachment-${n + 1}`),
					},
					h("span", {}, file.filename || `Attachment ${n + 1}`),
					h("span", { class: "size" }, file_size(file.size))
				)
			)
		)
	)
}

/** Fetched with the token in a header, then saved from a blob, so the key isn't in a URL. */
async function download(url, filename) {
	try {
		const blob = await fetch_file(held.inbox, url)
		const link = h("a", { href: URL.createObjectURL(blob), download: filename })
		document.body.append(link)
		link.click()
		link.remove()
		setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
	} catch (error) {
		fail(error)
	}
}

function open_settings() {
	chrome.runtime.openOptionsPage()
}

// ---------------------------------------------------------------------------------------

document.getElementById("settings").addEventListener("click", open_settings)
web.addEventListener("click", () => {
	if (held.inbox?.urls?.web) chrome.tabs.create({ url: held.inbox.urls.web })
})

// The worker writes too (an alarm tick, a right-click that made an inbox).
chrome.storage.onChanged.addListener(async (_changes, area) => {
	if (area !== "local") return
	held = await load_state()
	// A reader is left alone: redrawing it would reload the frame under the person reading.
	if (!view.busy && !view.reading) render()
})

// The clock, without redrawing the list under the pointer.
setInterval(() => {
	const clock = document.getElementById("clock")
	if (!clock || !held.inbox) return
	const left = time_left(held.inbox.expires)
	clock.textContent = clock_words(left)
	clock.classList.toggle("low", new Date(held.inbox.expires).getTime() - Date.now() < 5 * 60 * 1000)
	if (left === "Expired" && !held.inbox.gone) sync().catch(() => {})
}, 1000)

/**
 * While the popup is open it long-polls, so mail shows up the moment it lands rather than
 * at the worker's next alarm. What arrives with the popup open has been seen arrive, so
 * the worker doesn't also announce it.
 */
async function watch() {
	let pause = 0
	for (;;) {
		if (pause) await new Promise((done) => setTimeout(done, pause))
		const { inbox } = await load_state()
		if (!inbox || inbox.gone) {
			pause = 1000
			continue
		}
		try {
			const fresh = await sync({ wait: POLL_SECONDS })
			if (fresh.length) {
				const { notified } = await load_state()
				await chrome.storage.local.set({
					notified: [...notified, ...fresh.map((message) => message.id)].slice(-200),
				})
			}
			pause = 0
		} catch (error) {
			if (error instanceof TempboiError && error.status === 429) say(error.message, { error: true })
			pause = 5000
		}
	}
}

render()
update_badge()
watch()
