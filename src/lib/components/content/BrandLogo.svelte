<script lang="ts">
	import winkRaw from "$lib/assets/wink.svg?raw"

	// Stacks the brand face and a winking variant; hovering the logo swaps to the wink.
	// Mirrors the postboi-app BrandMark. Pass wink={false} to keep a static face (e.g. error state).
	let {
		defaultRaw,
		wink = true,
		class: className = "",
	}: { defaultRaw: string; wink?: boolean; class?: string } = $props()
</script>

<span class={["group/logo grid shrink-0 items-center", className]} aria-hidden="true">
	<!-- eslint-disable svelte/no-at-html-tags -->
	<span class={["col-start-1 row-start-1 inline-flex", wink && "group-hover/logo:opacity-0"]}>
		{@html defaultRaw}
	</span>
	{#if wink}
		<span class="col-start-1 row-start-1 inline-flex opacity-0 group-hover/logo:opacity-100">
			{@html winkRaw}
		</span>
	{/if}
	<!-- eslint-enable svelte/no-at-html-tags -->
</span>
