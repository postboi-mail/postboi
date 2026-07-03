<script lang="ts">
	import {
		siSvelte,
		siNextdotjs,
		siAstro,
		siNuxt,
		siRemix,
		siHono,
		siExpress,
		siCloudflareworkers,
	} from "simple-icons"

	// Keyed by the framework page's slug — monochrome (currentColor) so it sits quietly in the nav.
	const ICONS: Record<string, { path: string; title: string }> = {
		sveltekit: siSvelte,
		nextjs: siNextdotjs,
		astro: siAstro,
		nuxt: siNuxt,
		remix: siRemix,
		hono: siHono,
		express: siExpress,
		"cloudflare-workers": siCloudflareworkers,
	}

	let {
		name,
		size = 14,
		class: className = "",
	}: { name: string; size?: number; class?: string } = $props()

	const icon = $derived(ICONS[name])
</script>

{#if icon}
	<svg
		role="img"
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="currentColor"
		class={className}
		aria-hidden="true"
	>
		<path d={icon.path} />
	</svg>
{/if}
