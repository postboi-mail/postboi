# Nuxt (Vue) × Postboi

A contact form that turns a submission into a tidy HTML email, sent with
[postboi](https://docs.postboi.app) on the Postboi provider. A hidden `_reply_to`
field (bound to the address the visitor typed) means you can reply straight from
your inbox.

Nuxt is used here because sending email needs a server — Nuxt is Vue's
full-stack framework, giving us a server route alongside the Vue UI.

## Set up

```sh
bunx postboi init
npm install
npm run dev
```

Then open http://localhost:3000.

## How it works

- **`app/pages/index.vue`** — the Vue contact form. It POSTs `multipart/form-data` to
  `/api/contact` and shows a thank-you once the server redirects back with
  `?sent=1`. Hidden `_subject` and `_reply_to` fields ride along; `_reply_to` is
  bound to the email via `v-model`.
- **`server/api/contact.post.ts`** — reads the submitted `FormData` and hands it
  to `mail({ body })`. postboi renders the fields into an HTML table; `group→field`
  names become grouped sections.
- **`postboi.config.ts`** — picks the provider (the Postboi provider) and the default
  recipient for notifications.

The `POSTBOI_TOKEN` in `.env` routes mail through
[the Postboi provider](https://postboi.app). Swap the provider in `postboi.config.ts`
for any of the [supported providers](https://docs.postboi.app/providers).

## Beyond the form

The contact form is the classic; the rest of postboi wires in the same way:

- **`POST /webhooks`** — provider delivery events (delivered, opened, bounced, …),
  signature-verified and normalized. Set `<PROVIDER>_WEBHOOK_SECRET` and point your
  provider's webhook here.
- **`POST /api/notify`** — the other channels: `sms()`, `whatsapp()` and `slack()` from one
  endpoint. `{ "channel": "sms", "to": "+447700900123", "message": "…" }` — in
  development SMS and WhatsApp are logged, not sent.
- **`/push`** — Web Push end to end: the `use_push()` toggle from `postboi/vue`
  (`on`, `busy`, `toggle`), the subscription stored server-side, and `push()` sending to
  it. Mint the VAPID pair with `bunx postboi init --push` first.
