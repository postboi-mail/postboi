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

This example builds a provider instance directly and wraps it with `action()`. It uses
[Resend](https://resend.com); swap the import in `src/routes/+page.server.ts` for any of
the [supported providers](https://postboi.dev/providers).

| Var              | What it's for                              |
| ---------------- | ------------------------------------------ |
| `RESEND_API_KEY` | Your provider API key (secret).            |
| `EMAIL_FROM`     | Sender address every email is sent from.   |
| `EMAIL_TO`       | Where the contact form notifications land. |

## How it works

- [`src/routes/+page.server.ts`](./src/routes/+page.server.ts) — the whole backend. It
  wraps a configured provider with `action()` and sets `from` / `to` defaults.
- [`src/routes/+page.svelte`](./src/routes/+page.svelte) — the form. Field names use the
  [`fieldset→field`](https://postboi.dev/formdata#grouped-fields) syntax, `_subject` sets
  the subject, and `_reply_to` is bound to the sender's email.
