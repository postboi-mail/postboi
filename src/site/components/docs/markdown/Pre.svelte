<script lang="ts">
	import type { Snippet } from "svelte"
	import { cn } from "$site/utils/cn"
	import ScrollArea from "$site/components/ui/ScrollArea.svelte"
	import CopyCodeButton from "./CopyCodeButton.svelte"

	type ComponentProps = {
		class?: string
		children?: Snippet
		code?: string
		unstyled?: boolean
		[prop: string]: unknown
	}

	const props = $props()
	const className = $derived((props as ComponentProps).class ?? "")
	const code = $derived((props as ComponentProps).code ?? "")
	const unstyled = $derived((props as ComponentProps).unstyled ?? false)
	const children = $derived((props as ComponentProps).children)
	// Anything a machine said gets a docket label: which language this slip is in,
	// printed on the block the way a form names the box you are about to fill.
	const language = $derived((props as ComponentProps)["data-language"])
	const language_label = $derived(typeof language === "string" && language ? language : null)
	const restProps = $derived.by(() => {
		const {
			class: _class,
			children: _children,
			code: _code,
			unstyled: _unstyled,
			...rest
		} = props as ComponentProps
		return rest
	})
</script>

<div class={unstyled ? "" : "mt-8"}>
	<div
		{...restProps}
		class={cn(
			unstyled
				? "group/pre relative font-mono text-base font-normal"
				: "group/pre relative rounded-sm bg-background p-4 font-mono text-base font-normal text-foreground card",
			// A labelled slip reserves the strip the label sits in, so the last line
			// of code never runs underneath it.
			!unstyled && language_label && "pb-9",
			className
		)}
	>
		<ScrollArea mode="horizontal" class="w-full" thumbTabbable={false}>
			{@render children?.()}
		</ScrollArea>
		{#if !unstyled && language_label}
			<!-- Bottom-right, not top-left: the top-left of a code block is the first
			     token you read, and a label parked there is read as part of the code. -->
			<span
				class="docket pointer-events-none absolute right-3 bottom-3 text-foreground-faint"
				aria-hidden="true"
			>
				{language_label}
			</span>
		{/if}
		{#if code}
			<div class="pointer-events-none absolute top-2 right-2 z-10">
				<CopyCodeButton {code} class="pointer-events-auto" />
			</div>
		{/if}
	</div>
</div>

<style>
	/* The slip is the surface; the block carries only the type. */
	:global(.twinkleplop) {
		background-color: transparent;
		font-size: 14px;
		font-weight: 400;
	}
</style>
