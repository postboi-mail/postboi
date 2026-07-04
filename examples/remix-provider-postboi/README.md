# Remix × Postboi Cloud

A minimal Remix (v2, Vite) contact form that turns a submission into a tidy HTML
email via [postboi](https://docs.postboi.email) on Postboi Cloud. A hidden
`_reply_to` field (mirrored from the submitted email) means you can reply
straight from your inbox.

## Set up

```sh
bunx postboi init   # writes .env with your POSTBOI_TOKEN
npm install
npm run dev
```

Then open http://localhost:5173.

## How it works

- **`app/routes/_index.tsx`** — the `<Form>` carries hidden `_subject` and
  `_reply_to` fields (`_reply_to` mirrors the email via `useState`) and posts to an
  `action` that just calls `mail({ body })`. postboi extracts the `_`-prefixed
  control fields and renders the rest into an HTML table (the `group→field` names
  become grouped sections).
- **`postboi.config.ts`** — selects the provider (`postboi` = Postboi Cloud) and
  the default recipient for contact-form notifications.

Learn more at the [postboi docs](https://docs.postboi.email) and
[Postboi Cloud](https://postboi.email).
