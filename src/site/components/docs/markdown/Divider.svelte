<script lang="ts">
	import { cn } from "#site/utils/cn.js"

	type ComponentProps = Record<string, unknown> & { class?: string }
	const { class: className = "", ...restProps }: ComponentProps = $props()
</script>

<hr {...restProps} class={cn("h-px border-0 bg-border", className)} />
