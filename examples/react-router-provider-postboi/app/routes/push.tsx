import { useState } from "react"
import { usePush } from "postboi/react"

// No loader: `bunx postboi init --push` (or sync) bakes the VAPID public key into the
// package, so nothing needs ferrying from the server. The toggle state machine lives in
// the hook; a missing bake surfaces as push.reason === "missing_key".
export default function Push() {
	const push = usePush({ register: "/push/subscriptions" })
	const [status, setStatus] = useState("")

	async function test() {
		const response = await fetch("/push/subscriptions", { method: "PUT" })
		const { sent } = await response.json()
		setStatus(sent ? "sent — check your notifications" : "nothing subscribed on the server")
	}

	return (
		<main style={{ maxWidth: "32rem", margin: "4rem auto", fontFamily: "system-ui, sans-serif" }}>
			<h1>Web Push</h1>
			<p>
				Subscribe this browser, then have the server push to it — close the tab first if you want
				proof it works with the site gone.
			</p>
			<button onClick={push.toggle} disabled={push.busy}>
				{push.on ? "Unsubscribe" : "Subscribe"}
			</button>{" "}
			<button onClick={test} disabled={!push.on}>
				Send me one
			</button>
			{push.reason ? <p>{push.reason}</p> : status ? <p>{status}</p> : null}
		</main>
	)
}
