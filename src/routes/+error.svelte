<script lang="ts">
	import { page } from "$app/state"
	import nervous from "$lib/assets/nervous.svg?url"

	const is_not_found = $derived(page.status === 404)
	const message = $derived(
		is_not_found
			? "We couldn't find that page — it's probably been returned to sender."
			: (page.error?.message ?? "Something went wrong.")
	)
</script>

<div class="flex min-h-full flex-col items-center justify-center gap-6 text-center text-foreground">
	<img src={nervous} alt="A nervous-looking Postboi" class="w-40" />

	<div class="space-y-2">
		<h1 class="text-5xl font-semibold tracking-tight">{page.status}</h1>
		<p class="max-w-sm text-balance text-foreground-muted">{message}</p>
	</div>
</div>
