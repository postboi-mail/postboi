<script lang="ts">
	import { resolve } from "$app/paths"
	import { cn } from "$site/utils/cn"

	type ComponentProps = {
		label: string
		title: string
		href: string
		align?: "left" | "right"
		forceSecondColumn?: boolean
	}

	const { label, title, href, align = "left", forceSecondColumn = false }: ComponentProps = $props()
</script>

<div
	class={cn("group", align === "right" && "sm:text-right", forceSecondColumn && "sm:col-start-2")}
>
	<a
		href={resolve(href)}
		class={cn(
			"key relative flex flex-col gap-1 rounded-sm bg-background px-4 py-3 transition-[background-color] duration-150 ease-out hover:bg-background-muted"
		)}
	>
		<span class="docket text-foreground-muted">{label}</span>
		<span class="font-display text-lg font-bold tracking-tight text-balance text-foreground">
			{title}
		</span>
	</a>
</div>
