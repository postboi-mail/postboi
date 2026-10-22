<script lang="ts">
	import type { Snippet } from "svelte"
	import { cn } from "#site/utils/cn.js"

	type ComponentProps = {
		class?: string
		children?: Snippet
		[prop: string]: unknown
	}

	const { children, class: className = "", ...restProps }: ComponentProps = $props()

	const isBlock = (classValue: string | undefined, dataTheme: unknown) => {
		if (dataTheme !== undefined) return true
		if (!classValue) return false

		return classValue.split(/\s+/).some((token) => token.startsWith("language-"))
	}
</script>

{#if isBlock(typeof className === "string" ? className : undefined, restProps["data-theme"])}
	<code
		{...restProps}
		class={cn("block font-mono text-sm leading-relaxed whitespace-pre", className)}
	>
		{@render children?.()}
	</code>
{:else}
	<code
		{...restProps}
		class={cn(
			"rounded-xs bg-background-muted px-1.5 py-0.5 font-mono text-[0.9em] whitespace-nowrap text-foreground ring-1 ring-border",
			className
		)}
	>
		{@render children?.()}
	</code>
{/if}
