import { follow_inbox } from "./api.js"
import { insert_text } from "./fill.js"
import {
	ALARM_MINUTES,
	key_bytes,
	latest_code,
	message_page,
	notification_for,
	push_target,
	same_key,
} from "./rules.js"
import { live_inbox, load_settings, load_state, sync, update_badge } from "./state.js"

/**
 * The worker: it is told the moment mail lands, keeps the badge, announces new mail, and
 * answers the right-click menu and the fill shortcut. The popup long-polls on its own
 * while it is open; both fold into the same storage (state.js).
 *
 * "Told" is Web Push, the same push tempboi's page offers under Notify me: the worker
 * files a subscription against the inbox it holds, and each arrival wakes it. The push is
 * silent (`userVisibleOnly: false`, Chrome 121) and carries nothing we read: it is a bell,
 * and the worker fetches the mail itself, so the notification is ours and follows the
 * settings. An alarm stays on as a backstop for a push the push service dropped, and is
 * the whole of it wherever push can't be had.
 */

const POLL = "tempboi-poll"
const FILL_ADDRESS = "tempboi-fill-address"
const FILL_CODE = "tempboi-fill-code"

function setup() {
	follow()
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: FILL_ADDRESS,
			title: "Fill in my tempboi address",
			contexts: ["editable"],
		})
		chrome.contextMenus.create({
			id: FILL_CODE,
			title: "Fill in the latest code",
			contexts: ["editable"],
		})
	})
	update_badge()
}

chrome.runtime.onInstalled.addListener(setup)
chrome.runtime.onStartup.addListener(setup)

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === POLL) return check()
})

self.addEventListener("push", (event) => event.waitUntil(check()))

// The browser rotated the subscription: file the new one, with the token we hold.
self.addEventListener("pushsubscriptionchange", (event) => event.waitUntil(follow()))

// A new inbox (made, adopted, replaced) is followed; expiry moving is the same inbox.
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "local" || !("inbox" in changes)) return
	const { oldValue: was, newValue: now } = changes.inbox
	if (was?.address !== now?.address || was?.token !== now?.token || was?.gone !== now?.gone)
		follow()
})

async function check() {
	try {
		await announce(await sync())
	} catch {
		// Offline, expired, rate limited: the next tick asks again, and the popup says why.
	}
}

/**
 * Follow the held inbox by push, and set the alarm to match: a backstop when that worked,
 * the way mail is found when it didn't. `push` in storage says which, for the settings.
 */
async function follow() {
	const { inbox } = await load_state()
	const target = push_target(inbox)
	let instant = false
	if (target) {
		try {
			const manager = self.registration.pushManager
			let subscription = await manager.getSubscription()
			if (subscription && !same_key(subscription.options.applicationServerKey, target.key)) {
				await subscription.unsubscribe()
				subscription = null
			}
			subscription ??= await manager.subscribe({
				userVisibleOnly: false,
				applicationServerKey: key_bytes(target.key),
			})
			await follow_inbox(target.url, inbox, subscription.toJSON())
			instant = true
		} catch (error) {
			console.warn("tempboi: push unavailable, checking on a timer instead:", error?.message)
		}
	}
	await chrome.alarms.create(POLL, {
		periodInMinutes: instant ? ALARM_MINUTES.pushed : ALARM_MINUTES.polled,
	})
	await chrome.storage.local.set({ push: { address: inbox?.address, instant } })
}

/** A notification per new message nobody has been told about yet. */
async function announce(fresh) {
	if (!fresh.length) return
	const settings = await load_settings()
	const { notified } = await load_state()
	const told = new Set(notified)
	const untold = fresh.filter((message) => !told.has(message.id))
	if (!untold.length) return
	await chrome.storage.local.set({
		notified: [...notified, ...untold.map((message) => message.id)].slice(-200),
	})
	if (!settings.notify) return
	for (const message of untold.slice(-3)) {
		const words = notification_for(message)
		const buttons = []
		if (message.code) buttons.push({ title: "Copy code" })
		if (message.link) buttons.push({ title: "Open link" })
		chrome.notifications.create(`tempboi:${message.id}`, {
			type: "basic",
			iconUrl: chrome.runtime.getURL("icons/128.png"),
			title: words.title,
			message: words.message,
			contextMessage: message.to,
			buttons,
			priority: 1,
		})
	}
}

async function message_for(notification_id) {
	const id = notification_id.replace(/^tempboi:/, "")
	const { inbox, messages } = await load_state()
	return { inbox, message: messages.find((each) => each.id === id), id }
}

chrome.notifications.onClicked.addListener(async (notification_id) => {
	const { inbox, id } = await message_for(notification_id)
	chrome.notifications.clear(notification_id)
	if (inbox?.urls?.web) chrome.tabs.create({ url: message_page(inbox, id) })
})

chrome.notifications.onButtonClicked.addListener(async (notification_id, index) => {
	const { message } = await message_for(notification_id)
	if (!message) return
	const actions = []
	if (message.code) actions.push(() => copy(message.code))
	if (message.link) actions.push(() => chrome.tabs.create({ url: message.link }))
	await actions[index]?.()
	chrome.notifications.clear(notification_id)
})

/**
 * A worker has no clipboard of its own, so a copy goes through an offscreen document made
 * for the one job and closed after it.
 */
async function copy(text) {
	const url = chrome.runtime.getURL("src/offscreen.html")
	const open = await chrome.runtime.getContexts?.({
		contextTypes: ["OFFSCREEN_DOCUMENT"],
		documentUrls: [url],
	})
	if (!open?.length)
		await chrome.offscreen.createDocument({
			url,
			reasons: ["CLIPBOARD"],
			justification: "Copy a sign-up code from a notification",
		})
	await chrome.runtime.sendMessage({ target: "offscreen", type: "copy", text })
	await chrome.offscreen.closeDocument().catch(() => {})
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	if (!tab?.id) return
	const target = { tabId: tab.id, frameIds: [info.frameId ?? 0] }
	if (info.menuItemId === FILL_ADDRESS) await fill_address(target)
	if (info.menuItemId === FILL_CODE) await fill_code(target)
})

chrome.commands.onCommand.addListener(async (command, tab) => {
	if (!tab?.id) return
	const target = { tabId: tab.id, allFrames: true }
	if (command === "fill-address") await fill_address(target)
	if (command === "fill-code") await fill_code(target)
})

async function fill_address(target) {
	try {
		const inbox = await live_inbox()
		await fill(target, inbox.address)
	} catch (error) {
		await say(target, error?.message ?? "tempboi couldn't make an inbox just now.")
	}
}

async function fill_code(target) {
	// Ask once more before answering: the code is usually seconds old.
	await sync().catch(() => [])
	const found = latest_code((await load_state()).messages)
	if (found) await fill(target, found.code)
	else await say(target, "No code has arrived at your tempboi address yet.")
}

function fill(target, text) {
	return chrome.scripting.executeScript({ target, func: insert_text, args: [text] })
}

function say(target, words) {
	return chrome.scripting
		.executeScript({ target: { tabId: target.tabId }, func: (text) => alert(text), args: [words] })
		.catch(() => {})
}
