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

<th
	{...restProps}
	class={cn("docket px-4 py-3 text-left align-middle text-foreground-muted", className)}
>
	{@render children?.()}
</th>
