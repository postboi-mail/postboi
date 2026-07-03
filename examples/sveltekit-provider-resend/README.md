# SvelteKit × Resend

A minimal contact form wired to [Postboi](https://github.com/darbymanning/postboi) using
[Resend](https://resend.com) as the provider.

It demonstrates the two ways to send:

1. **Hand the whole form to the action** — `postboi/kit`'s `mail` action, literally one
   import. See [`src/routes/+page.server.ts`](./src/routes/+page.server.ts).
2. **Build the message yourself** — call the top-level `mail()` from `postboi`. See
   [`src/routes/welcome/+page.server.ts`](./src/routes/welcome/+page.server.ts).

The contact form posts `multipart/form-data`, which Postboi turns into a tidy HTML table in
the email body. A hidden `_reply_to` field is bound to the sender's email, so replying to
the notification goes straight back to them — not to your `from` address.

> This is the plain API-key counterpart to
> [`sveltekit-provider-postboi`](../sveltekit-provider-postboi). The code is identical — only
> the provider and its secret differ. Postboi Cloud additionally gives you a typed `from`;
> with Resend you verify your domain in their dashboard instead.

## Set up

Run `init` and pick **Resend** — it collects your API key, writes it to `.env`, and drops a
`postboi.config.ts`:

```bash
bunx postboi init
```

Then install and run:

```bash
bun install
bun dev
```

Open http://localhost:5173 and submit the form.

Prefer to do it by hand? `cp .env.example .env`, add your `RESEND_API_KEY`, and set your
verified `from` in [`postboi.config.ts`](./postboi.config.ts).

## The two sends

**1 — the form action (`postboi/kit`)**, the whole backend in one line:

```ts
import { mail } from "postboi/kit"

export const actions = { default: mail }
```

It reads the submitted `FormData`, sends it, and returns `{ success: true }` — or
`fail(400, { error })`. Special keys like `_subject` and `_reply_to` come from hidden fields
in the form.

**2 — the top-level `mail()`**, when you'd rather build the message yourself:

```ts
import { mail } from "postboi"

await mail({
	from: "Acme <hello@acme.example>",
	to: email,
	subject: "Welcome to Acme",
	body: "<p>Thanks for signing up.</p>",
})
```

Same provider (from `postboi.config.ts`), just full control over the message.

## The `from` address

Resend only sends from domains you've verified in their dashboard, so set `from` to an
address on one of yours — in `postboi.config.ts` (the default applied to every send) or per
message. It accepts a display name: `"Acme <hello@yourdomain.com>"` arrives as **Acme**.

## How it works

- [`postboi.config.ts`](./postboi.config.ts) — selects Resend and sets the `from` / `to`
  defaults applied to every send. The `RESEND_API_KEY` is read from `.env`.
- [`src/routes/+page.server.ts`](./src/routes/+page.server.ts) — the contact form's backend:
  `export const actions = { default: mail }`.
- [`src/routes/+page.svelte`](./src/routes/+page.svelte) — the contact form. Field names use
  the [`fieldset→field`](https://postboi.dev/formdata#grouped-fields) syntax, `_subject` sets
  the subject, and `_reply_to` is bound to the sender's email.
- [`src/routes/welcome/+page.server.ts`](./src/routes/welcome/+page.server.ts) — the same
  provider, sent via a hand-built top-level `mail()` call.
