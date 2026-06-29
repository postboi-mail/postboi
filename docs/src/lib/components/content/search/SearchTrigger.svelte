<script lang="ts">
	import { searchState } from '$lib/stores/search.svelte';
	import { contentUiDefaults, type SectionUiConfig } from '$lib/config/content-ui';
	import { cn } from '$lib/utils/cn';
	import Search from 'carbon-icons-svelte/lib/Search.svelte';

	let {
		class: className,
		searchConfig = contentUiDefaults.search
	}: { class?: string; searchConfig?: SectionUiConfig['search'] } = $props();
</script>

{#if searchConfig.enabled}
	<button
		type="button"
		class={cn(
			'group inset-shadow relative flex h-9 w-full items-center gap-2 rounded-sm bg-background-inset px-3 py-1.5 text-sm font-medium text-foreground-muted/70 transition-[color] duration-150 ease-out hover:text-foreground-muted',
			className
		)}
		onclick={() => {
			searchState.open();
		}}
	>
		<Search size={16} class="text-foreground-muted/70" />
		<span class="flex-1 text-left">{searchConfig.triggerPlaceholder}</span>
		{#if searchConfig.hotkey.enabled}
			<kbd
				class="pointer-events-none relative hidden h-5 items-center gap-1 rounded-xs bg-background px-1.5 font-mono text-[10px] font-medium text-foreground-muted/70 card select-none sm:flex"
			>
				{searchConfig.hotkey.label}
			</kbd>
		{/if}
	</button>
{/if}
