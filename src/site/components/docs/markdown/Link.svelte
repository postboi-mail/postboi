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

<a
	{...restProps}
	class={cn(
		"font-medium tracking-normal text-foreground underline decoration-brand-yellow decoration-2 underline-offset-4 transition-[text-decoration-color] duration-150 ease-out hover:decoration-accent",
		className
	)}
>
	{@render children?.()}
</a>
