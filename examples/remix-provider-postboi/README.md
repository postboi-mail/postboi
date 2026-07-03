# Remix × Postboi Cloud

A minimal Remix (v2, Vite) contact form that turns a submission into a tidy HTML
email via [postboi](https://docs.postboi.email) on Postboi Cloud. The `reply_to`
header is set from the submitted email address in the action, so you can reply
straight from your inbox.

## Set up

```sh
bunx postboi init   # writes .env with your POSTBOI_TOKEN
npm install
npm run dev
```

Then open http://localhost:5173.

## How it works

- **`app/routes/_index.tsx`** — the `<Form>` posts to an `action` that reads the
  submitted `FormData`, sets `_reply_to` / `_subject`, and calls
  `mail({ body: form })`. postboi extracts the `_`-prefixed control fields and
  renders the rest into an HTML table (the `group→field` names become grouped
  sections).
- **`postboi.config.ts`** — selects the provider (`postboi` = Postboi Cloud) and
  the default recipient for contact-form notifications.

Learn more at the [postboi docs](https://docs.postboi.email) and
[Postboi Cloud](https://postboi.email).
