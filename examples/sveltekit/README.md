# Postboi × SvelteKit

A minimal contact form wired to [Postboi](https://github.com/darbymanning/postboi) with a
one-line form action.

The form posts `multipart/form-data`, which Postboi turns into a tidy HTML table in the
email body. A hidden `_reply_to` field is bound to the sender's email, so replying to the
notification goes straight back to them — not to your `from` address.

## Run it

```bash
bun install
cp .env.example .env   # then fill in real values
bun dev
```

Open http://localhost:5173 and submit the form.

## Configure

The provider and defaults (`from` / `to`) live in the committed
[`postboi.config.ts`](./postboi.config.ts). The only secret — your provider's API key —
goes in `.env`. This example uses [Resend](https://resend.com); swap `provider` in the
config for any of the [supported providers](https://postboi.dev/providers).

| Var              | What it's for                   |
| ---------------- | ------------------------------- |
| `RESEND_API_KEY` | Your provider API key (secret). |

## How it works

- [`postboi.config.ts`](./postboi.config.ts) — picks the provider and sets the `from` /
  `to` defaults applied to every send.
- [`src/routes/+page.server.ts`](./src/routes/+page.server.ts) — the whole backend, a
  single line: `export const actions = { default: mail }`.
- [`src/routes/+page.svelte`](./src/routes/+page.svelte) — the form. Field names use the
  [`fieldset→field`](https://postboi.dev/formdata#grouped-fields) syntax, `_subject` sets
  the subject, and `_reply_to` is bound to the sender's email.
