# SvelteKit × bring-your-own provider

A minimal contact form wired to [Postboi](https://github.com/darbymanning/postboi) that runs
on **any** of the [~20 supported providers](https://docs.postboi.email/providers) — Resend,
Postmark, SendGrid, Mailgun, SES, SMTP, and the rest.

The point of this example: **[`postboi.config.ts`](./postboi.config.ts) is the only file that
changes between providers.** The routes and every `mail()` call are provider-agnostic — swap
the `provider` key and the API key in `.env`, and everything else stays exactly the same.
(For the Postboi provider version with a typed `from`, see
[`sveltekit-provider-postboi`](../sveltekit-provider-postboi).)

It demonstrates the two ways to send:

1. **Hand the whole form to the action** — `postboi/kit`'s `mail` action, literally one
   import. See [`src/routes/+page.server.ts`](./src/routes/+page.server.ts).
2. **Build the message yourself** — call the top-level `mail()` from `postboi`. See
   [`src/routes/welcome/+page.server.ts`](./src/routes/welcome/+page.server.ts).

The contact form posts `multipart/form-data`, which Postboi turns into a tidy HTML table in
the email body. A hidden `_reply_to` field is bound to the sender's email, so replying to
the notification goes straight back to them — not to your `from` address.

## Pick your provider

The fastest path — `init` lets you choose a provider, collects its credentials into `.env`,
and writes `postboi.config.ts` for you:

```bash
bunx postboi init
```

Or do it by hand — the whole switch is two edits:

1. In [`postboi.config.ts`](./postboi.config.ts), set `provider` (and any non-secret
   `options` like a Mailgun domain or SES region).
2. In `.env`, add that provider's secret(s). See [`.env.example`](./.env.example) for which
   var each provider uses.

That config file has a table of the common providers and exactly what each one needs.

Then:

```bash
bun install
bun dev
```

Open http://localhost:5173 and submit the form.

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

Neither send names a provider — both go through whatever `postboi.config.ts` selects.

## The `from` address

Set `from` to an address your provider is allowed to send from (most require a verified
domain). It accepts a display name: `"Acme <hello@yourdomain.com>"` arrives as **Acme**.

## How it works

- [`postboi.config.ts`](./postboi.config.ts) — **the only provider-specific file.** Selects
  the provider, its non-secret `options`, and the `from` / `to` defaults. Secrets come from
  `.env`.
- [`src/routes/+page.server.ts`](./src/routes/+page.server.ts) — the contact form's backend:
  `export const actions = { default: mail }`.
- [`src/routes/+page.svelte`](./src/routes/+page.svelte) — the contact form. Field names use
  the [`fieldset→field`](https://docs.postboi.email/formdata#grouped-fields) syntax, `_subject` sets
  the subject, and `_reply_to` is bound to the sender's email.
- [`src/routes/welcome/+page.server.ts`](./src/routes/welcome/+page.server.ts) — a hand-built
  top-level `mail()` call, again provider-agnostic.
