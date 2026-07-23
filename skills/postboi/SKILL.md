---
name: postboi
description: Integrate the postboi email library — send email from any JS framework (SvelteKit, Next.js, Express, Hono, Remix, Nuxt, Astro), wire contact forms with FormData parsing and spam protection, receive delivery webhooks, schedule and track sends. Covers SvelteKit remote functions (postboi/remote) and migrating hand-rolled email code to postboi. Also covers full account setup and provider migration from the terminal: sending domains + DNS via `bunx postboi domains`, importing recipients and suppressions, webhooks, members, and the REST API at api.postboi.email. Use whenever a task involves postboi, adding email sending / contact forms, setting up or migrating an email provider/ESP, or replacing nodemailer/direct provider SDK calls in a project that has (or should have) postboi installed.
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

### SvelteKit — pick the right one-liner

**First check whether the project uses remote functions**: look for `remoteFunctions: true` in `svelte.config.*` (or in the `sveltekit()` call in `vite.config.*`), or any existing `*.remote.ts` files.

**Remote functions in use → `postboi/remote`.** The library ships the whole backend; the component is the entire app. No `+page.server.ts`, no action:

```svelte
<script lang="ts">
	import { mail } from "postboi/remote"
	import Captcha from "postboi/svelte"
</script>

<form {...mail} enctype="multipart/form-data">
	<input {...mail.fields._subject.as("hidden", "Contact Form")} />
	<Captcha />
	<input {...mail.fields.contact.name.as("text")} required />
	<input {...mail.fields.contact.email.as("email")} required />
	<button disabled={!!mail.pending}>Send</button>
</form>

{#if mail.result?.success}<p>Thanks!</p>{/if}
```

Remote-form rules: field names are **nested JS paths** (`fields.contact.name`), not `contact→name` — the rendered email is identical. No schema is needed (`mail` accepts arbitrary fields; spam checks run in the pipeline). Enhancement is built in — no `use:enhance`; the form auto-resets on success; `mail.pending` / `mail.result` carry state; it degrades to a full-page POST without JS. Requires `optimizeDeps: { exclude: ["postboi/remote"] }` in `vite.config` (`postboi init` adds it, and the `postboi/vite` plugin carries it too). Custom provider/forced fields: `remote(instance, { fields? })` from `postboi/kit`, exported from your own `.remote.ts` file.

**Otherwise → the classic action from `postboi/kit`:**

```ts
// +page.server.ts
import { mail } from "postboi/kit"

export const actions = { default: mail }
```

Returns `{ success: true }` or `fail(400, { error })`. Explicit provider or defaults: `action(instance, { status?, fields? })`. Full form example: `/raw/sveltekit`.

Other frameworks have the same pattern — see `/raw/nextjs`, `/raw/express`, `/raw/hono`, `/raw/remix`, `/raw/nuxt`, `/raw/astro`.

### Migrating existing email code to postboi

The lean path, in order. At every step the goal is **deleting code**, not wrapping it:

1. **Hand-rolled provider SDK calls / nodemailer / raw fetch to a mail API** → replace with zero-config `mail()` from `postboi` (run `bunx postboi init` first). Delete the SDK dependency, the transport setup, and any hand-written HTML-escaping or field formatting — `body: FormData | fields` does the table rendering.
2. **A SvelteKit action (or API route) that reads FormData and sends email** → replace the whole action with `export const actions = { default: mail }` from `postboi/kit`. Hidden `_subject` / `_reply_to` inputs replace server-side subject/reply-to code. Keep nothing of the old handler unless it did non-email work.
3. **Classic postboi action → remote functions** (only if the project already enables them):
   - `+page.server.ts` action → delete the file; import `{ mail } from "postboi/remote"` in the component.
   - `<form method="POST" use:enhance enctype=…>` → `<form {...mail} enctype=…>` (drop the `use:enhance` import).
   - `name="contact→email"` → `{...mail.fields.contact.email.as("email")}` (nesting replaces arrows).
   - `<input type="hidden" name="_subject" value=…>` → `{...mail.fields._subject.as("hidden", …)}`.
   - `let { form } = $props()` result handling → `mail.result` (`{ success: true }` or `{ success: false, error }`); pending UI → `mail.pending`.
   - Manual honeypot input → keep `<Captcha />` or rename the raw input to `_honey` (remote forms reject `🍯` and other non-path names).
   - Add `optimizeDeps: { exclude: ["postboi/remote"] }` to `vite.config` if `postboi init` hasn't already.
4. **Never** hand-write what the library owns: FormData parsing, HTML tables, honeypot/captcha checks, provider error normalisation, webhook signature verification. If migrated code still contains any of those, the migration isn't finished.

## Spam protection

Two invisible layers, automatic on every FormData send. Easiest: drop the prop-free `<Captcha />` component inside the form — `postboi/svelte`, `postboi/react`, `postboi/vue`, `postboi/astro`. It renders the honeypot and activates the managed invisible captcha (Postboi provider; key baked in by `bunx postboi sync`).

Manual honeypot — a visually hidden input named `_honey` (default; the classic `🍯` is also accepted, but remote forms reject it — **don't** use `display: none`, bots detect it):

```html
<input
	type="text"
	name="_honey"
	tabindex="-1"
	autocomplete="off"
	aria-hidden="true"
	style="position: absolute; left: -9999px; height: 0; width: 0; opacity: 0"
/>
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

Cloudflare Worker bindings (`POSTBOI_TOKEN`, `TURNSTILE_SECRET_KEY`, …) are read automatically off `cloudflare:workers`, so `mail()` needs no explicit credentials — don't reach for `new Postboi({ token: env.POSTBOI_TOKEN })` unless you're overriding. There's no filesystem either, so `postboi.config.ts` can't auto-load: add `postboi()` from `postboi/vite` to `vite.config` and it's bundled into the server build (this also covers the `optimizeDeps` exclude). No Vite in the build? `import "../postboi.config"` from the entry point, or `configure({ ... })` at startup. `/raw/cloudflare-workers`

## Templates

`body` is just HTML — any renderer works. For designed emails the blessed pairing is Maizzle via the optional `postboi/maizzle` helper: `body: maizzle("./emails/welcome.vue", { name: "Ava" })`. Needs Node/Bun (not edge). React Email / MJML output drops into `body` the same way. `/raw/templates`

## Account setup & migration (CLI + REST API)

With the Postboi provider, the whole account is manageable from the terminal. Exactly two steps need the human; everything else is agent-runnable:

1. **Sign-in** — `bunx postboi init` is interactive and opens a browser to authorise. Have the user run it (or drive it yourself and relay the printed URL). Once `POSTBOI_TOKEN` is in the env, every command below is non-interactive and safe to run repeatedly.
2. **DNS approval** — `domains add` prints a one-click setup URL; the user clicks it at their registrar (or pastes the printed records).

```bash
bunx postboi whoami                                # account, plan, usage — run first to verify the token
bunx postboi domains add example.com               # prints DNS records + one-click Domain Connect URL
bunx postboi domains check example.com             # re-check until verified (records land in minutes)
bunx postboi lists add Newsletter
bunx postboi recipients Newsletter add a@b.co c@d.co   # upserts contact + membership
bunx postboi contacts add ada@example.com --data '{"plan":"pro"}'  # the audience: one contact, global data, shared across lists
bunx postboi webhooks add https://example.com/api/events
bunx postboi sync                                  # writes the webhook secret to POSTBOI_WEBHOOK_SECRET
bunx postboi members invite colleague@example.com
bunx postboi suppressions add bounced@example.com
bunx postboi messages                              # recent sends with delivery status
bunx postboi webhooks deliveries <id>              # per-endpoint delivery log for debugging
```

Anything richer than the CLI exposes, use the REST API directly — full interactive reference at https://api.postboi.email (OpenAPI spec at `/openapi.json`). Auth is `Authorization: Bearer $POSTBOI_TOKEN`; errors are always `{ "message", "code" }`.

### Fresh project playbook

`init` (human signs in) → `whoami` → wire the code (see Setup / Contact forms above) → optionally `domains add` + user clicks the setup link + `domains check` → only after **verified**, set `default.from` to the custom domain in `postboi.config.ts` → `webhooks add` + `sync` if the app reacts to delivery events. Until a domain verifies, sends come from the account's shared `send.postboi.email` address — that works immediately, so never block the code migration on DNS.

### Migrating from another ESP/provider

Order matters — the old provider keeps sending until the new domain verifies:

1. `init` + `whoami`.
2. `domains add` the sending domain; the DKIM CNAMEs coexist with the old provider's DNS records, so this is zero-downtime. `domains check` until verified.
3. **Import suppressions before anything sends**: export bounces/complaints/unsubscribes from the old provider, then `suppressions add` each (loop is fine — one address per call).
4. Import recipients. Bare emails: `recipients <list> add …`. With names/custom data, or in bulk (up to 10,000 per call), POST the API:

   ```bash
   curl -X POST "https://api.postboi.email/v1/lists/Newsletter/recipients?status=subscribed" \
   	-H "Authorization: Bearer $POSTBOI_TOKEN" -H "Content-Type: application/json" \
   	-d '[{ "email": "a@b.co", "name": "Ada", "data": { "plan": "pro" } }]'
   ```

   **Critical on double-opt-in lists:** pass `?status=subscribed` (or per-row `"status": "subscribed"`) for already-confirmed subscribers — those rows get **no** confirmation email. Omitting it re-confirms the entire imported base.

5. Swap the sending code (see _Migrating existing email code_ above) and flip `default.from` once the domain is verified.
6. `webhooks add` + `sync`; port suppress-on-bounce logic to the normalized events.
7. Verify end-to-end: `messages` shows delivery statuses, `webhooks deliveries <id>` shows the event feed.

Cautions: deletes are immediate and unprompted (`lists delete` takes the recipients with it). API-key management, member roles, and billing are dashboard-only by design — send the user there rather than trying.

## Quick reference

| Task                                 | Import                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Zero-config send / cancel            | `mail`, `cancel` from `postboi`                                                                  |
| Explicit provider                    | `postboi/resend`, `postboi/ses`, `postboi/smtp`, … (`/raw/providers` for all 20 + env var names) |
| SvelteKit action & webhook handler   | `mail`, `action`, `webhook` from `postboi/kit`                                                   |
| SvelteKit remote form (experimental) | `mail` from `postboi/remote`; factory `remote` from `postboi/kit`                                |
| Webhooks anywhere                    | `receive`, `mock_event`, `mock_request` from `postboi/webhooks`                                  |
| Captcha component                    | `postboi/svelte`, `postboi/react`, `postboi/vue`, `postboi/astro`                                |
| Maizzle templates                    | `postboi/maizzle`                                                                                |
| Tests                                | `postboi/mock`                                                                                   |
| Spam helpers                         | `is_spam`, `SkipSendError` from `postboi`                                                        |
