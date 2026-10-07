<!--
	@component
	Drop-in spam protection for a native `<form>`: renders the hidden honeypot field and, on
	the Postboi provider, activates the managed invisible captcha on the surrounding form. The
	publishable key is baked in by `bunx postboi sync`, so no props are needed.

	```svelte
	<script>
		import Captcha from "postboi/svelte"
	</script>

	<form method="POST" use:enhance>
		<input name="contact→name" required />
		<Captcha />
		<button>Send</button>
	</form>
	```

	It works the same inside a SvelteKit remote form (`<form {...contact}>`).
-->
<script lang="ts">
	import { HONEYPOT_FIELD, activate_captcha, honeypot_style, scope_captcha_fields } from "./form.js"

	interface Props {
		/** Publishable key (`pk_…`) override. Defaults to the key baked by `bunx postboi sync`. */
		pk?: string
		/** Origin serving the captcha loader. Defaults to https://postboi.app. */
		origin?: string
		/** Render the hidden honeypot field. Defaults to true. */
		honeypot?: boolean
	}

	let { pk, origin, honeypot = true }: Props = $props()
	let marker = $state<HTMLElement>()

	$effect(() => activate_captcha(marker, pk, origin))
	// Remote forms reject a field without their scope, and the token's input arrives later.
	$effect(() => scope_captcha_fields(marker))
</script>

{#if honeypot}
	<input
		bind:this={marker}
		type="text"
		name={HONEYPOT_FIELD}
		tabindex="-1"
		autocomplete="off"
		aria-hidden="true"
		style={honeypot_style}
	/>
{:else}
	<span bind:this={marker} hidden></span>
{/if}
