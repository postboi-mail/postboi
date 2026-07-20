<script lang="ts">
	import { mail } from "postboi/remote"
	import Captcha from "postboi/svelte"

	// Mirrored into the hidden `_reply_to` field, so replying to the notification
	// goes straight back to the sender.
	let email = $state("")
</script>

<main>
	<h1>Contact us (remote functions)</h1>

	<!--
		The entire backend is the spread: `mail` is a SvelteKit remote function shipped
		by postboi — no +page.server.ts, no action, no endpoint. Nested fields
		(contact.name) group in the email exactly like the classic contact→name syntax.
	-->
	<form {...mail} enctype="multipart/form-data">
		<input {...mail.fields._subject.as("hidden", "Contact Form")} />
		<input {...mail.fields._reply_to.as("hidden", email)} />

		<!-- Invisible spam protection: renders the honeypot and, with a Postboi key, the managed captcha. -->
		<Captcha />

		<label>
			Name
			<input {...mail.fields.contact.name.as("text")} placeholder="Ada Lovelace" required />
		</label>

		<label>
			Email
			<input
				{...mail.fields.contact.email.as("email")}
				placeholder="ada@example.com"
				required
				bind:value={email}
			/>
		</label>

		<label>
			Message
			<textarea {...mail.fields.details.message.as("text")} placeholder="Say hello…"></textarea>
		</label>

		<label>
			Attachments
			<input {...mail.fields.details.attachments.as("file")} multiple />
		</label>

		<button type="submit" disabled={!!mail.pending}>
			{mail.pending ? "Sending…" : "Send"}
		</button>
	</form>

	{#if mail.result?.success}
		<p class="ok">Thanks — we'll be in touch!</p>
	{:else if mail.result && !mail.result.success}
		<p class="error">{mail.result.error}</p>
	{/if}
</main>

<style>
	main {
		margin: 3rem auto;
		max-width: 28rem;
		font-family: system-ui;
	}

	label {
		display: block;
		margin-block: 1rem;
	}

	input:not([type="hidden"]),
	textarea {
		display: block;
		width: 100%;
		padding: 0.5rem;
	}

	.ok {
		color: green;
	}

	.error {
		color: crimson;
	}
</style>
