<script lang="ts">
	import { enhance } from "$app/forms"

	let { form } = $props()
</script>

<main>
	<h1>Welcome email</h1>
	<p>
		The <a href="/">contact form</a> hands the whole submission to the
		<code>postboi/kit</code> action. This one instead builds the message by hand and calls the
		top-level <code>mail()</code> — see <code>src/routes/welcome/+page.server.ts</code>.
	</p>

	<form method="POST" use:enhance>
		<label>
			Email
			<input name="email" type="email" placeholder="ada@example.com" required />
		</label>
		<button type="submit">Send welcome email</button>
	</form>

	{#if form?.success}
		<p role="status">Sent — check the inbox.</p>
	{:else if form?.error}
		<p role="alert">{form.error}</p>
	{/if}
</main>

<style>
	main {
		max-width: 32rem;
		margin: 4rem auto;
		padding: 0 1rem;
		font-family: system-ui, sans-serif;
	}

	form {
		display: grid;
		gap: 1rem;
	}

	label {
		display: grid;
		gap: 0.25rem;
	}

	input {
		padding: 0.5rem;
		font: inherit;
	}

	button {
		justify-self: start;
		padding: 0.5rem 1rem;
		font: inherit;
		cursor: pointer;
	}
</style>
