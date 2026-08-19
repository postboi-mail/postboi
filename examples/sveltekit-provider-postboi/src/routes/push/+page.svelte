<script lang="ts">
	import { subscription } from "postboi/svelte"

	// postboi bakes the VAPID public key into the package, so nothing has to carry it to
	// the browser. `register` is where the subscription the browser mints gets filed —
	// the /push endpoint below — which is how the server learns where to push. `on`,
	// `busy` and `reason` are reactive, so read them straight off it.
	//
	// `service_worker` because SvelteKit builds `src/service-worker.ts` and serves it at
	// its own path; subscribe() looks for /sw.js otherwise. That worker is one line —
	// `receive()` from postboi/push/sw — and handles the rotations nothing here can see.
	const push = subscription({ register: "/push", service_worker: "/service-worker.js" })

	let status = $state("")

	async function test() {
		const response = await fetch("/push", { method: "PUT" })
		const { sent } = await response.json()
		status = sent ? "sent — check your notifications" : "nothing subscribed on the server"
	}
</script>

<main>
	<h1>Web Push</h1>

	<p>
		Subscribe this browser, then have the server push to it — close the tab first if you
		want proof it works with the site gone.
	</p>
	<button onclick={push.toggle} disabled={push.busy}>
		{push.on ? "Unsubscribe" : "Subscribe"}
	</button>
	<button onclick={test} disabled={!push.on}>Send me one</button>
	<!-- missing_key lands here too — run `bunx postboi init --push`, then restart. -->
	{#if push.reason}<p>{push.reason}</p>{:else if status}<p>{status}</p>{/if}
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		max-width: 32rem;
		margin: 4rem auto;
		padding: 0 1rem;
	}
	button {
		font: inherit;
		padding: 0.5rem 1rem;
		margin-right: 0.5rem;
	}
</style>
