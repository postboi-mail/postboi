<script lang="ts">
	import { cn } from "#site/utils/cn.js"
	import { themeStore } from "#site/stores/theme.svelte.js"
	import Sun from "carbon-icons-svelte/lib/Sun.svelte"
	import Moon from "carbon-icons-svelte/lib/Moon.svelte"

	type Props = {
		class?: string
	}

	const props = $props()
	const className = $derived((props as Props).class ?? "")
</script>

<button
	type="button"
	class={cn(
		"group key relative inline-flex size-7 items-center justify-center rounded-sm bg-background-muted text-foreground",
		className
	)}
	onclick={themeStore.toggle}
	aria-label={themeStore.isDark ? "Switch to light mode" : "Switch to dark mode"}
>
	<span class="sr-only">{themeStore.isDark ? "Switch to light mode" : "Switch to dark mode"}</span>
	<span class="theme-toggle-icon theme-toggle-sun">
		<Sun size={16} />
	</span>
	<span class="theme-toggle-icon theme-toggle-moon">
		<Moon size={16} />
	</span>
</button>

<style>
	.theme-toggle-icon {
		position: absolute;
		opacity: 0;
		filter: blur(4px);
		scale: 0.25;
		transition:
			opacity 150ms ease-out,
			filter 150ms ease-out,
			scale 150ms ease-out;
		will-change: opacity, filter, scale;
	}

	.theme-toggle-sun {
		opacity: 1;
		filter: blur(0);
		scale: 1;
	}

	:global(.dark) .theme-toggle-sun {
		opacity: 0;
		filter: blur(4px);
		scale: 0.25;
	}

	:global(.dark) .theme-toggle-moon {
		opacity: 1;
		filter: blur(0);
		scale: 1;
	}
</style>
