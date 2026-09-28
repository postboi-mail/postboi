import { TempboiError } from "./api.js"
import { clean_token, DEFAULT_SERVER, LIFETIMES, pasted_server, server_origin } from "./rules.js"
import { adopt_inbox, load_settings, save_settings } from "./state.js"

const status = document.getElementById("status")
const ttl = document.getElementById("ttl")
const notify = document.getElementById("notify")
const server = document.getElementById("server")

function say(words, { error = false } = {}) {
	status.textContent = words
	status.classList.toggle("error", error)
}

const settings = await load_settings()

for (const lifetime of LIFETIMES) ttl.append(new Option(lifetime.label, lifetime.ttl))
ttl.value = settings.ttl
notify.checked = settings.notify
server.value = settings.server
server.placeholder = DEFAULT_SERVER

ttl.addEventListener("change", async () => {
	await save_settings({ ttl: ttl.value })
	say("Saved. The next inbox you make will last that long.")
})

notify.addEventListener("change", async () => {
	await save_settings({ notify: notify.checked })
	say(notify.checked ? "Notifications are on." : "Notifications are off.")
})

document.getElementById("adopt").addEventListener("submit", async (event) => {
	event.preventDefault()
	const field = document.getElementById("token")
	const token = clean_token(field.value)
	if (!token) return say("That isn't an inbox token. They start tb_.", { error: true })
	const from = pasted_server(field.value)
	if (from && from !== DEFAULT_SERVER && !(await reach(from))) return
	try {
		const inbox = await adopt_inbox(token, from)
		field.value = ""
		say(`${inbox.address} is open in the toolbar now.`)
	} catch (error) {
		say(
			error instanceof TempboiError && error.gone
				? "No live inbox has that token. It may have expired."
				: (error?.message ?? "That didn't work."),
			{ error: true }
		)
	}
})

document.getElementById("server-form").addEventListener("submit", async (event) => {
	event.preventDefault()
	const origin = server_origin(server.value || DEFAULT_SERVER)
	if (!origin) return say("That isn't a web address.", { error: true })
	if (origin !== DEFAULT_SERVER && !(await reach(origin))) return
	await save_settings({ server: origin })
	server.value = origin
	say(`New inboxes will come from ${origin}. The one you have now stays where it was made.`)
})

/** tempboi.email is granted at install; anywhere else is asked for, once, when named. */
async function reach(origin) {
	const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
	if (!granted) say(`tempboi needs permission to reach ${origin}.`, { error: true })
	return granted
}

/** Whether the held inbox is followed by push, which the worker writes as `push`. */
async function show_arrival() {
	const { push, inbox } = await chrome.storage.local.get(["push", "inbox"])
	document.getElementById("arrival").textContent =
		!inbox || push?.instant
			? "tempboi is told the moment mail lands."
			: "Push isn't available here, so tempboi checks every thirty seconds instead, and at once while the popup is open."
}
show_arrival()
chrome.storage.onChanged.addListener((changes) => {
	if ("push" in changes) show_arrival()
})

document.getElementById("shortcuts").addEventListener("click", () => {
	chrome.tabs.create({ url: "chrome://extensions/shortcuts" })
})
