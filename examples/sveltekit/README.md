# Postboi × SvelteKit

A minimal contact form wired to [Postboi](https://github.com/darbymanning/postboi) with a
one-line form action, running on [Postboi Cloud](https://postboi.dev).

The form posts `multipart/form-data`, which Postboi turns into a tidy HTML table in the
email body. A hidden `_reply_to` field is bound to the sender's email, so replying to the
notification goes straight back to them — not to your `from` address.

## Set up

One command does the lot — authenticates you to Postboi Cloud, writes `POSTBOI_TOKEN` to
your `.env`, generates the typed `from` (see below), and adds a `postboi sync` step to your
`prepare` script so those types survive reinstalls:

```bash
bunx postboi init
```

Then install and run:

```bash
bun install
bun dev
```

Open http://localhost:5173 and submit the form.

Already have a token? Skip `init`, drop it in `.env` (`cp .env.example .env`), and run
`bunx postboi sync` to fetch your `from` types.

## Typed `from`

Because this example runs on Postboi Cloud, `bunx postboi sync` narrows `from` to your
account's verified sending addresses — right there in your editor. Pick a domain you don't
own and it won't typecheck:

```ts
export default config({
	provider: "postboi",
	default: {
		from: "Acme <hello@acme.example>", // ✅ one of your Cloud domains

		// @ts-expect-error — not one of your verified domains, so Postboi Cloud's
		// generated `from` type rejects it.
		from: "hello@totally-not-your-domain.example",
	},
})
```

The types live inside `node_modules/postboi` (no project file to commit), so they refresh
whenever you run `bunx postboi sync` — wired into `prepare` here so a reinstall restores
them automatically.

> Prefer a plain API-key provider like Resend? That's a separate example (coming soon) —
> Cloud is used here specifically to demo the typed `from`.

## How it works

- [`postboi.config.ts`](./postboi.config.ts) — selects Postboi Cloud and sets the `from` /
  `to` defaults applied to every send.
- [`src/routes/+page.server.ts`](./src/routes/+page.server.ts) — the whole backend, a
  single line: `export const actions = { default: mail }`.
- [`src/routes/+page.svelte`](./src/routes/+page.svelte) — the form. Field names use the
  [`fieldset→field`](https://postboi.dev/formdata#grouped-fields) syntax, `_subject` sets
  the subject, and `_reply_to` is bound to the sender's email.
