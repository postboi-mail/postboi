<script lang="ts">
	import type { Snippet } from "svelte"
	import { cn } from "#site/utils/cn.js"

	type ComponentProps = {
		class?: string
		children?: Snippet
		[prop: string]: unknown
	}

	const { children, class: className = "", ...restProps }: ComponentProps = $props()
</script>

<blockquote
	{...restProps}
	class={cn(
		"mt-6 border-l-4 border-l-brand-yellow bg-background px-5 py-4 text-base font-normal text-pretty text-foreground-muted",
		className
	)}
>
	{@render children?.()}
</blockquote>
