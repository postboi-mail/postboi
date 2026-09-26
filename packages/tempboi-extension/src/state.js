import {
	claim_inbox,
	create_inbox,
	delete_inbox,
	extend_inbox,
	list_messages,
	TempboiError,
} from "./api.js"
import { DEFAULT_SERVER, extended_ttl, merge, unread_count } from "./rules.js"

/**
 * What the extension holds, in `chrome.storage.local`, and the few things that change it.
 * The popup and the worker both read and write through here, so a message either of them
 * fetched is the same message to the other, and the badge says one number.
 *
 * - `settings`: `{ server, ttl, notify }`
 * - `inbox`: the wire inbox plus its `token` and the `server` that made it, or absent
 * - `messages`, `cursor`: what has been read so far, newest first
 * - `seen`: ids opened in the reader; `notified`: ids the worker has already announced
 */

export const DEFAULT_SETTINGS = { server: DEFAULT_SERVER, ttl: "1h", notify: true }

export async function load_settings() {
	const { settings } = await chrome.storage.local.get("settings")
	return { ...DEFAULT_SETTINGS, ...settings }
}

export async function save_settings(changes) {
	const settings = { ...(await load_settings()), ...changes }
	await chrome.storage.local.set({ settings })
	return settings
}

export async function load_state() {
	const held = await chrome.storage.local.get(["inbox", "messages", "cursor", "seen", "notified"])
	return {
		inbox: held.inbox,
		messages: held.messages ?? [],
		cursor: held.cursor ?? 0,
		seen: held.seen ?? [],
		notified: held.notified ?? [],
	}
}

/** Start over on a fresh inbox: nothing held from the last one survives. */
async function hold(inbox, server, token) {
	const stored = { ...inbox, token: inbox.token ?? token, server }
	await chrome.storage.local.set({
		inbox: stored,
		messages: [],
		cursor: 0,
		seen: [],
		notified: [],
	})
	await update_badge()
	return stored
}

/** Make a new inbox and make it the one the extension holds. */
export async function new_inbox({ name } = {}) {
	const settings = await load_settings()
	const inbox = await create_inbox(settings.server, { name, ttl: settings.ttl })
	return hold(inbox, settings.server)
}

/** Take over an inbox made elsewhere (the page, the CLI) by its token. */
export async function adopt_inbox(token, server) {
	const from = server ?? (await load_settings()).server
	const inbox = await claim_inbox(from, token)
	const stored = await hold(inbox, from, token)
	// Mail already there counts as announced: it arrived before we were watching.
	await sync()
	const { messages } = await load_state()
	await chrome.storage.local.set({ notified: messages.map((message) => message.id) })
	return stored
}

/** The inbox held now, live; a new one when there is none or it has run out. */
export async function live_inbox() {
	const { inbox } = await load_state()
	if (inbox && !inbox.gone && new Date(inbox.expires).getTime() > Date.now() + 5000) return inbox
	return new_inbox()
}

/** Delete the inbox on the server and forget it here. An inbox already gone is fine. */
export async function drop_inbox() {
	const { inbox } = await load_state()
	if (inbox && !inbox.gone) {
		try {
			await delete_inbox(inbox.server, inbox)
		} catch (error) {
			if (!(error instanceof TempboiError && error.gone)) throw error
		}
	}
	await chrome.storage.local.remove(["inbox", "messages", "cursor", "seen", "notified"])
	await update_badge()
}

/** Add an hour to what is left, as far as the inbox's whole-life cap allows. */
export async function extend() {
	const { inbox } = await load_state()
	if (!inbox) return undefined
	const answer = await extend_inbox(inbox.server, inbox, extended_ttl(inbox.expires))
	const stored = { ...inbox, expires: answer.expires }
	await chrome.storage.local.set({ inbox: stored })
	return stored
}

/**
 * Read what arrived since the cursor and fold it in. `wait` long-polls. Answers the
 * messages that weren't held before, oldest first. An inbox the server no longer knows
 * is marked `gone` rather than forgotten, so the popup can say so.
 */
export async function sync({ wait = 0, signal } = {}) {
	const { inbox, cursor } = await load_state()
	if (!inbox || inbox.gone) return []
	let page
	try {
		page = await list_messages(inbox.server, inbox, { after: cursor, wait, signal })
	} catch (error) {
		if (error instanceof TempboiError && error.gone) {
			await chrome.storage.local.set({ inbox: { ...inbox, gone: true } })
			await update_badge()
		}
		throw error
	}
	// Read again after the wait: the other side may have written while we held.
	const held = await load_state()
	if (held.inbox?.address !== inbox.address) return []
	const merged = merge(held, page)
	// Only write what moved: every write wakes the popup's and the worker's listeners, and
	// an empty long poll every 25 seconds would redraw the popup for nothing.
	const changes = {}
	if (merged.fresh.length || merged.cursor !== held.cursor) {
		changes.messages = merged.messages
		changes.cursor = merged.cursor
	}
	if (page.expires && page.expires !== held.inbox.expires)
		changes.inbox = { ...held.inbox, expires: page.expires }
	if (Object.keys(changes).length) await chrome.storage.local.set(changes)
	if (merged.fresh.length) await update_badge()
	return merged.fresh
}

export async function mark_seen(id) {
	const { seen } = await load_state()
	if (seen.includes(id)) return
	await chrome.storage.local.set({ seen: [...seen, id].slice(-200) })
	await update_badge()
}

/** The badge counts unopened mail, in the house yellow with ink on it. */
export async function update_badge() {
	const { inbox, messages, seen } = await load_state()
	const count = inbox && !inbox.gone ? unread_count(messages, seen) : 0
	await chrome.action.setBadgeBackgroundColor({ color: "#FDC005" })
	await chrome.action.setBadgeTextColor?.({ color: "#141a2e" })
	await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : "" })
}
