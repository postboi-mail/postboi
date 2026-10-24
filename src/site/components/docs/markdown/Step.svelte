<script lang="ts">
	import { cn } from "#site/utils/cn.js"
	import type { Snippet } from "svelte"

	let {
		class: className,
		children,
		title,
	}: {
		class?: string
		children?: Snippet
		title?: string
	} = $props()
</script>

<div class={cn("relative pl-8", className)}>
	{#if title}
		<div class="mb-4 flex h-8 items-center">
			<div class="absolute -left-4 flex size-8 bg-background-inset p-0.5">
				<span
					class="docket flex h-full w-full items-center justify-center bg-brand-yellow text-brand-ink [counter-increment:step] before:content-[counter(step)]"
				>
				</span>
			</div>
			<h3 class="relative z-10 text-lg leading-none font-bold tracking-tight">
				{title}
			</h3>
		</div>
	{:else}
		<div class="absolute -left-4 flex size-8 bg-background-inset p-0.5">
			<span
				class="docket flex h-full w-full items-center justify-center bg-brand-yellow text-brand-ink [counter-increment:step] before:content-[counter(step)]"
			>
			</span>
		</div>
	{/if}
	<div
		class={cn("text-base leading-relaxed tracking-normal text-foreground-muted", !title && "pt-2")}
	>
		{@render children?.()}
	</div>
</div>
