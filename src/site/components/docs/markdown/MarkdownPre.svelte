<script lang="ts">
	import type { Snippet } from "svelte"
	import Pre from "./Pre.svelte"
	import CodeBlock from "../CodeBlock.svelte"

	type Props = {
		html: string
		code?: Snippet
		lang?: string
		raw?: string
	}

	const props = $props()
	const html = $derived((props as Props).html)
	const code = $derived((props as Props).code)
	const lang = $derived((props as Props).lang)
	const raw = $derived((props as Props).raw ?? "")
</script>

{#if code}
	<Pre data-language={lang} code={raw}>
		{@render code()}
	</Pre>
{:else}
	<CodeBlock code={raw} {html} {lang} />
{/if}
