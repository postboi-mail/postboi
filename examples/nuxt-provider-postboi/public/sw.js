// Service worker, created by `bunx postboi init --push`.
// Receive-only: no fetch handler and no caching — a worker that intercepts requests is a
// different feature, and this one only exists to deliver notifications.

// These are the same handlers `receive()` from postboi/push/sw registers, written out
// because this file is served exactly as written and can't import. Yours to edit.

const POSTBOI_REGISTER = "/push/subscriptions"
// No VAPID public key was available when this was written. Without one, a rotation can
// only be re-filed on browsers that hand over the replacement themselves — paste the
// public half of your pair here to cover the rest.
const POSTBOI_VAPID_KEY = ""

self.addEventListener("push", (event) => {
	let payload = {}
	try {
		payload = (event.data && event.data.json()) || {}
	} catch {
		// Something that isn't postboi sent this. Showing its text beats showing nothing:
		// a push handler that throws shows nothing at all, and a browser that sees pushes
		// arrive with no notification takes the permission away.
		payload = { body: event.data ? event.data.text() : "" }
	}
	// Every push owes the user a notification — that's what `userVisibleOnly` promised.
	// Put your app's name in place of the "" below to give untitled sends a title.
	event.waitUntil(
		self.registration.showNotification(payload.title ?? "", {
			body: payload.body ?? "",
			icon: payload.icon,
			data: { ...payload.data, url: payload.url },
		})
	)
})

self.addEventListener("notificationclick", (event) => {
	event.notification.close()
	const url = event.notification.data && event.notification.data.url
	if (!url) return
	event.waitUntil(
		(async () => {
			// Focus the tab already showing it rather than opening a second one.
			const target = new URL(url, self.location.origin).href
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
			const showing = windows.find((client) => client.url === target)
			await (showing ? showing.focus() : self.clients.openWindow(target))
		})()
	)
})

// Subscriptions expire, and browsers replace them on their own schedule. This event fires
// nowhere but here — without it, the address on the server is dead and the next
// notification silently goes nowhere before the 410 cleans it up.
self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil(
		(async () => {
			let subscription = event.newSubscription ?? null
			if (!subscription) {
				// Firefox hands over the replacement it made; Chrome expects a fresh subscribe.
				if (!POSTBOI_VAPID_KEY) return
				const base64 = POSTBOI_VAPID_KEY.replace(/-/g, "+").replace(/_/g, "/")
				const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
				subscription = await self.registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
				})
			}
			const json = subscription.toJSON()
			// `old_endpoint` is what makes this a swap rather than a leak: delete that row,
			// then store the rest. It's absent on browsers that don't say what was replaced.
			await fetch(POSTBOI_REGISTER, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					endpoint: json.endpoint,
					expirationTime: json.expirationTime ?? null,
					keys: json.keys,
					...(event.oldSubscription && { old_endpoint: event.oldSubscription.endpoint }),
				}),
			})
		})()
	)
})
