<!--
	@component
	A POST form with Postboi's spam protection built in: the 🍯 honeypot field, hidden
	special fields (`_subject`, `_reply_to`, …) from props, and — given a publishable
	`captcha` key from the dashboard — the managed invisible captcha.

	```svelte
	<script>
		import { enhance } from "$app/forms"
		import MailForm from "postboi/svelte"
	</script>

	<MailForm subject="Contact form" captcha="pk_…" {enhance}>
		<input name="contact→name" required />
		<button>Send</button>
	</MailForm>
	```
-->
<script lang="ts">
	import type { HTMLFormAttributes } from "svelte/elements"
	import type { Snippet } from "svelte"
	import { HONEYPOT_FIELD } from "./captcha.js"
	import {
		ensure_captcha_script,
		honeypot_style,
		special_fields,
		type MailFormFields,
	} from "./form.js"

	interface Props extends HTMLFormAttributes, MailFormFields {
		/** Publishable managed-captcha key (`pk_…`) from the Postboi dashboard. */
		captcha?: string
		/** Origin serving the captcha loader. Defaults to https://postboi.email. */
		captcha_origin?: string
		/** Render the hidden 🍯 honeypot field. Defaults to true. */
		honeypot?: boolean
		/** A form action to apply — pass SvelteKit's `enhance` for progressive enhancement. */
		enhance?: (node: HTMLFormElement) => void | { destroy?: () => void }
		/** The underlying form element, bindable. */
		element?: HTMLFormElement
		children?: Snippet
	}

	let {
		captcha,
		captcha_origin,
		honeypot = true,
		enhance,
		element = $bindable(),
		subject,
		to,
		from,
		reply_to,
		cc,
		bcc,
		children,
		...rest
	}: Props = $props()

	$effect(() => {
		if (captcha) ensure_captcha_script(captcha, captcha_origin)
	})

	function apply_enhance(node: HTMLFormElement) {
		return enhance?.(node)
	}
</script>

<form
	method="POST"
	{...rest}
	data-captcha={captcha ? "" : undefined}
	bind:this={element}
	use:apply_enhance
>
	{#each special_fields({ subject, to, from, reply_to, cc, bcc }) as [name, value] (name)}
		<input type="hidden" {name} {value} />
	{/each}
	{#if honeypot}
		<input
			type="text"
			name={HONEYPOT_FIELD}
			tabindex="-1"
			autocomplete="off"
			aria-hidden="true"
			style={honeypot_style}
		/>
	{/if}
	{@render children?.()}
</form>
