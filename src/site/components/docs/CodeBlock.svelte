<script lang="ts">
	import Pre from "./markdown/Pre.svelte"

	type Props = {
		code: string
		/** Twinkleplop's markup, from `highlight()` in $site/utils/highlight.js. */
		html: string
		lang?: string
		class?: string
		unstyled?: boolean
	}

	let { code, html, lang, class: className, unstyled = false }: Props = $props()
</script>

<Pre {code} class={className} data-language={lang} {unstyled}>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html html}
</Pre>
