# SvelteKit × Postboi Cloud

A minimal contact form wired to [Postboi](https://github.com/darbymanning/postboi), running
on [Postboi Cloud](https://postboi.dev) so it can also show off the **typed `from`**.

It demonstrates the two ways to send:

1. **Hand the whole form to the action** — `postboi/kit`'s `mail` action, literally one
   import. See [`src/routes/+page.server.ts`](./src/routes/+page.server.ts).
2. **Build the message yourself** — call the top-level `mail()` from `postboi`. See
   [`src/routes/welcome/+page.server.ts`](./src/routes/welcome/+page.server.ts).

The contact form posts `multipart/form-data`, which Postboi turns into a tidy HTML table in
the email body. A hidden `_reply_to` field is bound to the sender's email, so replying to
the notification goes straight back to them — not to your `from` address.

## Set up

One command does the lot — authenticates you to Postboi Cloud, writes `POSTBOI_TOKEN` to
your `.env`, generates the typed `from` (see below), and adds a `postboi sync` step to your
`prepare` script so those types survive reinstalls:

```bash
bunx postboi init
```

Then install and run:

```bash
bun install
bun dev
```

Open http://localhost:5173 and submit the form.

Already have a token? Skip `init`, drop it in `.env` (`cp .env.example .env`), and run
`bunx postboi sync` to fetch your `from` types.

## The two sends

**1 — the form action (`postboi/kit`)**, the whole backend in one line:

```ts
import { mail } from "postboi/kit"

export const actions = { default: mail }
```

It reads the submitted `FormData`, sends it, and returns `{ success: true }` — or
`fail(400, { error })`. Special keys like `_subject` and `_reply_to` come from hidden fields
in the form.

**2 — the top-level `mail()`**, when you'd rather build the message yourself:

```ts
import { mail } from "postboi"

await mail({
	from: "Acme <hello@acme.example>",
	to: email,
	subject: "Welcome to Acme",
	body: "<p>Thanks for signing up.</p>",
})
```

Same provider (from `postboi.config.ts`), just full control over the message.

## Typed `from`

Because this example runs on Postboi Cloud, `bunx postboi sync` narrows `from` to your
account's verified sending addresses — everywhere it appears: the config default, the kit
action, and every top-level `mail()` call. Pick a domain you don't own and it won't compile
([`src/lib/typed-from-demo.ts`](./src/lib/typed-from-demo.ts)):

```ts
import { mail } from "postboi"

// ✅ one of your Cloud domains
await mail({ from: "Acme <hello@acme.example>", to: "you@example.com", subject: "Hi", body: "…" })

// @ts-expect-error — not one of your verified Cloud domains, so it won't compile
await mail({ from: "hello@totally-not-your-domain.example", to: "you@example.com", subject: "Hi", body: "…" })
```

For real, those types live *inside* `node_modules/postboi` — `bunx postboi sync` writes them
from your account's domains, so there's no project file to commit or gitignore (and `prepare`
re-runs `sync` after installs). This example commits a stand-in at
[`src/postboi-cloud.d.ts`](./src/postboi-cloud.d.ts) purely so it typechecks without a Cloud
account; a real project deletes it after `postboi init`.

> Prefer a plain API-key provider like Resend? That'd be its own example
> (`sveltekit-provider-resend`) — Cloud is used here specifically to demo the typed `from`.

## How it works

- [`postboi.config.ts`](./postboi.config.ts) — selects Postboi Cloud and sets the `from` /
  `to` defaults applied to every send.
- [`src/routes/+page.server.ts`](./src/routes/+page.server.ts) — the contact form's backend:
  `export const actions = { default: mail }`.
- [`src/routes/+page.svelte`](./src/routes/+page.svelte) — the contact form. Field names use
  the [`fieldset→field`](https://postboi.dev/formdata#grouped-fields) syntax, `_subject` sets
  the subject, and `_reply_to` is bound to the sender's email.
- [`src/routes/welcome/+page.server.ts`](./src/routes/welcome/+page.server.ts) — the same
  provider, sent via a hand-built top-level `mail()` call with a typed `from`.
