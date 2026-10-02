<script lang="ts">
	import { subscription } from "postboi/svelte"

	// `register` is the route next door, which files this browser under whoever is signed
	// in. With managed push, `bunx postboi sync` bakes the account's key into the package,
	// so nothing carries it to the browser. `on`, `busy` and `reason` are reactive.
	//
	// No worker path: subscribe() finds SvelteKit's /service-worker.js on its own. That
	// worker is a bare `receive()`, and a rotated subscription goes straight to Postboi.
	const push = subscription({ register: "/push" })

	// A public list needs no route at all: open the list to browsers on its page in the
	// dashboard, and the page subscribes on the publishable key alone.
	const news = subscription({ list: "news" })

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

	<h2>A public list</h2>
	<p>
		Follow the <code>news</code> list from this page, with no server code. Send to it with
		<code>push(&lbrace; to: &lbrace; list: "news" &rbrace; &rbrace;)</code>.
	</p>
	<button onclick={news.toggle} disabled={news.busy}>
		{news.on ? "Unfollow" : "Follow news"}
	</button>
	{#if news.reason}<p>{news.reason}</p>{/if}
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
