# React Router × Postboi

A minimal React Router (v8, framework mode) contact form that turns a submission into
a tidy HTML email via [postboi](https://docs.postboi.app) on the Postboi provider. A
hidden `_reply_to` field (mirrored from the submitted email) means you can reply
straight from your inbox.

React Router framework mode is what Remix became, so this is also the Remix example.

## Set up

```sh
bunx postboi init   # writes .env with your POSTBOI_TOKEN
npm install
npm run dev
```

Then open http://localhost:5173.

## How it works

- **`app/routes.ts`**: the route config. Each route below is one line in it.
- **`app/routes/home.tsx`**: the `<Form>` carries hidden `_subject` and `_reply_to`
  fields (`_reply_to` mirrors the email via `useState`) and posts to an `action` that
  just calls `mail({ body })`. postboi extracts the `_`-prefixed control fields and
  renders the rest into an HTML table (the `group→field` names become grouped sections).
- **`postboi.config.ts`**: selects the provider (`postboi` = the Postboi provider) and
  the default recipient for contact-form notifications.

Learn more at the [postboi docs](https://docs.postboi.app) and
[the Postboi provider](https://postboi.app).

## Beyond the form

The contact form is the classic; the rest of postboi wires in the same way, each as a
resource route (an `action` and no default export):

- **`POST /webhooks`**: provider delivery events (delivered, opened, bounced, …),
  signature-verified and normalized. Set `<PROVIDER>_WEBHOOK_SECRET` and point your
  provider's webhook here.
- **`POST /notify`**: the other channels, `sms()`, `whatsapp()` and `slack()`, from one
  endpoint. `{ "channel": "sms", "to": "+447700900123", "message": "…" }`. In
  development SMS and WhatsApp are logged, not sent.
- **`/push`**: Web Push end to end: `subscribe()` from `postboi/push` in the browser,
  the subscription stored server-side, and `push()` sending to it. Mint the VAPID pair
  with `bunx postboi init --push` first.
