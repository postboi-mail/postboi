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

<thead
	{...restProps}
	class={cn(
		"relative overflow-hidden after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-line after:content-['']",
		className
	)}
>
	{@render children?.()}
</thead>
