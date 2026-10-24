<script lang="ts">
	import type { Snippet } from "svelte"
	import { cn } from "#site/utils/cn.js"
	import ScrollArea from "#site/components/ui/ScrollArea.svelte"

	type ComponentProps = {
		class?: string
		children?: Snippet
		[prop: string]: unknown
	}

	const { children, class: className = "", ...restProps }: ComponentProps = $props()
</script>

<div class="relative my-8 rounded-sm bg-background card">
	<ScrollArea mode="horizontal" class="w-full rounded-sm" viewportClass="rounded-sm">
		<table {...restProps} class={cn("w-full text-base", className)}>
			{@render children?.()}
		</table>
	</ScrollArea>
</div>
