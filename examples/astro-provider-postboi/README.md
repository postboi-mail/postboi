# Astro × Postboi Cloud

A contact form that turns submissions into a tidy HTML email via [postboi](https://docs.postboi.email) on [Postboi Cloud](https://postboi.email). The API route sets the email's reply-to from the address the visitor typed, so replying goes straight back to them.

## Set up

```sh
bunx postboi init
npm install
npm run dev
```

Then open http://localhost:4321.

## How it works

- `src/pages/index.astro` — the contact form (posts `multipart/form-data` to `/api/contact`).
- `src/pages/api/contact.ts` — reads the `FormData`, sets `_reply_to` from the submitted email, and calls `mail({ body: form })`.
- `postboi.config.ts` — picks the provider (Postboi Cloud) and the default recipient for notifications.
