# Hono × Postboi Cloud

A framework-agnostic HTTP example. Hono exposes the Web-standard `Request` and
`FormData`, so the same `mail({ body: form })` pattern works with no framework
magic. A contact form posts to the server, postboi turns the submission into a
tidy HTML email, and the reply-to is set from the submitted email address in the
handler.

## Set up

```sh
bunx postboi init   # writes .env, prompts for your Postboi Cloud token
bun install
bun run dev
```

Then open http://localhost:3000.

## How it works

- **`src/index.ts`** — a Hono app. `GET /` renders the contact form; `POST /contact`
  reads `await c.req.formData()`, sets `_reply_to` from the submitted email and
  `_subject`, then calls `mail({ body: form })`. Field names use the `group→field`
  convention (e.g. `contact→name`) which postboi renders as grouped sections in the
  email.
- **`postboi.config.ts`** — picks the provider (Postboi Cloud) and the default
  recipient for notifications. Swap `provider` for any of
  https://docs.postboi.email/providers to use a different one.

Learn more at the [postboi docs](https://docs.postboi.email) and
[Postboi Cloud](https://postboi.email).
