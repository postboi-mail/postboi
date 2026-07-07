# Astro × Postboi

A contact form that turns submissions into a tidy HTML email via [postboi](https://docs.postboi.email) on [the Postboi provider](https://postboi.email). A hidden `_reply_to` field (mirrored from the address the visitor typed) means replying goes straight back to them.

## Set up

```sh
bunx postboi init
npm install
npm run dev
```

Then open http://localhost:4321.

## How it works

- `src/pages/index.astro` — the contact form (posts `multipart/form-data` to `/api/contact`). Hidden `_subject` and `_reply_to` fields ride along; a one-line `oninput` mirrors the email into `_reply_to`.
- `src/pages/api/contact.ts` — reads the `FormData` and calls `mail({ body })`.
- `postboi.config.ts` — picks the provider (the Postboi provider) and the default recipient for notifications.
