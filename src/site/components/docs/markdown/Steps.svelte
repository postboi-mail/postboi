<script lang="ts">
	import { cn } from "#site/utils/cn.js"
	import type { Snippet } from "svelte"

	let {
		class: className,
		children,
	}: {
		class?: string
		children?: Snippet
	} = $props()
</script>

<div
	class={cn("relative mb-12 ml-4 space-y-10 border-l border-line [counter-reset:step]", className)}
>
	{@render children?.()}
</div>
