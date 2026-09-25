<script lang="ts">
	import { page } from "$app/state"
	import nervous from "$site/assets/nervous.svg?url"
	import { resolve } from "$app/paths"

	const is_not_found = $derived(page.status === 404)
	const message = $derived(
		is_not_found
			? "We couldn't find that page. It's probably been returned to sender."
			: (page.error?.message ?? "Something went wrong.")
	)
	// The mark a sorting office actually strikes on an undeliverable item. It only
	// makes sense for a 404 — a 500 wasn't returned, it fell over.
	const cancellation = $derived(is_not_found ? "Return to sender" : "Undeliverable")
</script>

<div class="flex min-h-full flex-col items-center justify-center gap-8 text-center text-foreground">
	<!-- The item that came back: the mascot on a piece of paper, with the office's
	     mark struck across the corner of it. -->
	<div class="relative">
		<img src={nervous} alt="A nervous-looking Postboi" class="w-40" />
		<span
			class="docket absolute -right-14 -bottom-2 -rotate-12 border-2 border-current px-2.5 py-1.5 text-postal-red sm:-right-20"
		>
			{cancellation}
		</span>
	</div>

	<div class="flex flex-col items-center gap-4">
		<span class="docket text-foreground-muted">Status</span>
		<h1 class="poster text-6xl uppercase">{page.status}</h1>
		<div class="h-0.5 w-40 bg-line"></div>
		<p class="max-w-sm text-balance text-foreground-muted">{message}</p>
	</div>

	<a
		href={resolve("/")}
		class="key inline-flex items-center rounded-sm bg-brand-yellow px-4 py-2.5 text-brand-ink"
	>
		<span class="docket">Back to the docs</span>
	</a>
</div>
