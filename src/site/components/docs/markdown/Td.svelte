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

<td
	{...restProps}
	class={cn("px-4 py-3 align-middle font-normal tracking-normal text-foreground-muted", className)}
>
	{@render children?.()}
</td>
