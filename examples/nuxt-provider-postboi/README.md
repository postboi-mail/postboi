# Nuxt (Vue) × Postboi Cloud

A contact form that turns a submission into a tidy HTML email, sent with
[postboi](https://docs.postboi.email) on Postboi Cloud. The server route sets
the email's reply-to from the address the visitor typed, so you can reply
straight from your inbox.

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

- **`app.vue`** — the Vue contact form. It POSTs `multipart/form-data` to
  `/api/contact` and shows a thank-you once the server redirects back with
  `?sent=1`.
- **`server/api/contact.post.ts`** — reads the submitted `FormData`, sets
  `_reply_to` from the visitor's email, and hands it to `mail({ body: form })`.
  postboi renders the fields into an HTML table; `group→field` names become
  grouped sections.
- **`postboi.config.ts`** — picks the provider (Postboi Cloud) and the default
  recipient for notifications.

The `POSTBOI_TOKEN` in `.env` routes mail through
[Postboi Cloud](https://postboi.email). Swap the provider in `postboi.config.ts`
for any of the [supported providers](https://docs.postboi.email/providers).
