---
name: postboi
description: Integrate the postboi email library — send email from any JS framework (SvelteKit, Next.js, Express, Hono, Remix, Nuxt, Astro), wire contact forms with FormData parsing and spam protection, receive delivery webhooks, schedule and track sends. Use whenever a task involves postboi, or adding email sending / contact forms to a project that has postboi installed.
---

# Postboi

Framework-agnostic email library. One `mail()` call, 20 providers (Resend, SES, Mailgun, SMTP, its own Postboi provider, …), normalized errors and webhooks across all of them.

Full docs: https://docs.postboi.email — every page is available as raw Markdown at `https://docs.postboi.email/raw/<slug>` (e.g. `/raw/webhooks`). Fetch those for anything not covered here. Complete docs in one file: `https://docs.postboi.email/llms-full.txt`.

## Setup

Always start with the CLI — it picks a provider, writes secrets to `.env` and everything else to a committed `postboi.config.ts`, and installs the package:

```bash
bunx postboi init   # or npx
```

Don't hand-write provider wiring unless the runtime demands it (see Edge runtimes). The config split is a hard rule: **API keys/tokens → env file; provider name, defaults, non-secret options → `postboi.config.ts`**.

```ts
// postboi.config.ts (committed)
import { config } from "postboi"

export default config({
	provider: "resend",
	default: { from: "no-reply@example.com" },
})
```

## Sending

Zero-config `mail()` picks up the config automatically:

```ts
import { mail } from "postboi"

await mail({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
```

- `body` accepts an HTML string, a `FormData` object, a plain object of fields, or a **promise** of any of those (`body: request.formData()` — no await needed).
- `to`/`from`/`cc`/`bcc`/`reply_to` accept `"a@b.c"`, `"Name <a@b.c>"`, `{ address, name }`, or arrays.
- A plain-text alternative is derived from the HTML automatically (`auto_text`, on by default).
- Other `SendOptions`: `attachments: File | File[]`, `headers`, `tags`, `idempotency_key`, `scheduled_at`, `tracking`, `unsubscribe_url`, `captcha`. Reference: `/raw/api`.

## Contact forms (FormData)

Passing `FormData` as `body` renders a tidy HTML table. Conventions:

- Field names use `fieldset→field` (literal `→` character) to group fields into sections: `name="contact→email"`.
- Special fields set send options instead of appearing in the table: `_to`, `_from`, `_subject`, `_reply_to`, `_cc`, `_bcc`. Standard pattern: a hidden `_reply_to` bound to the submitter's email so replies go to them.
- File inputs become attachments; the form needs `enctype="multipart/form-data"`.

### SvelteKit — one line

```ts
// +page.server.ts
import { mail } from "postboi/kit"

export const actions = { default: mail }
```

Returns `{ success: true }` or `fail(400, { error })`. To use an explicit provider instance or set defaults: `action(instance, { status?, fields? })` from `postboi/kit`. Full form example: `/raw/sveltekit`.

Other frameworks have the same pattern — see `/raw/nextjs`, `/raw/express`, `/raw/hono`, `/raw/remix`, `/raw/nuxt`, `/raw/astro`.

## Spam protection

Two invisible layers, automatic on every FormData send. Easiest: drop the prop-free `<Captcha />` component inside the form — `postboi/svelte`, `postboi/react`, `postboi/vue`, `postboi/astro`. It renders the honeypot and activates the managed invisible captcha (Postboi provider; key baked in by `bunx postboi sync`).

Manual honeypot — a visually hidden input named `🍯` (default name; **don't** use `display: none`, bots detect it):

```html
<input type="text" name="🍯" tabindex="-1" autocomplete="off" aria-hidden="true"
	style="position: absolute; left: -9999px; height: 0; width: 0; opacity: 0" />
```

A filled honeypot skips the send: `postboi/kit` still returns `{ success: true }` (bot learns nothing); direct `mail()` throws a `SpamError` — catch with `is_spam(error)` and pretend success. Bring-your-own Cloudflare Turnstile: set `TURNSTILE_SECRET_KEY` and add the widget; note that setting the secret **enforces** the captcha on every FormData send (opt a send out with `captcha: { turnstile: false }`). Details: `/raw/spam`.

## Webhooks (delivery events)

```ts
// SvelteKit: src/routes/webhooks/email/+server.ts
import { webhook } from "postboi/kit"

export const POST = webhook(async (event) => {
	if (event.type === "bounced" && event.bounce?.category === "hard") await suppress(event.email)
})
```

Elsewhere use `receive(request)` from `postboi/webhooks` — returns normalized `WebhookEvent[]` (`sent | delivered | delayed | bounced | complained | opened | clicked | unsubscribed | failed`), with `event.client` parsed locally into name/os/device on opens and clicks. Signature verification is **fail-closed**: set `<PROVIDER>_WEBHOOK_SECRET` (e.g. `RESEND_WEBHOOK_SECRET`) or `receive()` throws. Test without a tunnel using `mock_event` / `mock_request` from `postboi/webhooks`. Per-provider secrets and schemes: `/raw/webhooks`.

## Scheduling, tracking, bulk

- `scheduled_at: { days: 1, hours: 5 } | Date | ISO string` — provider-side; only Postboi, Resend, Brevo, Mailgun, SendGrid support it, **others send immediately**. `cancel(id)` where supported; unsupported providers throw `cancel_not_supported` (never a silent no-op). `/raw/scheduling`
- `tracking: { opens?, clicks? }` per send; `unsubscribe_url` sets RFC 8058 one-click headers (required by Gmail/Yahoo for bulk; the URL must accept a direct POST). `/raw/tracking`
- Bulk: pass an array to `mail()` — never throws, returns one result per message (`r.ok` / `r.error`). Personalized batches: one `to` array + `data` keyed by address with `{name}` placeholders. `/raw/bulk`

## Errors & retries

Every provider throws the same normalised `PostboiError` (`provider`, `status?`, `code?`, `message`, `raw`); check with `mail.is_error(e)`. Retries are **off by default on purpose** — enable `retries` only alongside an `idempotency_key` where supported, or you risk duplicate sends. `/raw/errors`

## Testing

Use the mock provider — same normalisation, records instead of sending:

```ts
import Mock from "postboi/mock"

const mail = new Mock({ default: { from: "no-reply@example.com" } })
await mail.send({ to: "a@b.c", subject: "Hi", body: "<p>x</p>" })
// mail.sent[0], mail.canceled
```

## Edge runtimes (Cloudflare Workers, …)

No filesystem, no ambient env — so `postboi.config.ts` can't auto-load. Either call `configure({ ... })` at startup, or construct the provider directly with credentials from `env`, and pass the Turnstile secret explicitly: `captcha: { turnstile: { secret_key: env.TURNSTILE_SECRET_KEY } }`. `/raw/cloudflare-workers`

## Templates

`body` is just HTML — any renderer works. For designed emails the blessed pairing is Maizzle via the optional `postboi/maizzle` helper: `body: maizzle("./emails/welcome.vue", { name: "Ava" })`. Needs Node/Bun (not edge). React Email / MJML output drops into `body` the same way. `/raw/templates`

## Quick reference

| Task | Import |
| --- | --- |
| Zero-config send / cancel | `mail`, `cancel` from `postboi` |
| Explicit provider | `postboi/resend`, `postboi/ses`, `postboi/smtp`, … (`/raw/providers` for all 20 + env var names) |
| SvelteKit action & webhook handler | `mail`, `action`, `webhook` from `postboi/kit` |
| Webhooks anywhere | `receive`, `mock_event`, `mock_request` from `postboi/webhooks` |
| Captcha component | `postboi/svelte`, `postboi/react`, `postboi/vue`, `postboi/astro` |
| Maizzle templates | `postboi/maizzle` |
| Tests | `postboi/mock` |
| Spam helpers | `is_spam`, `SkipSendError` from `postboi` |
