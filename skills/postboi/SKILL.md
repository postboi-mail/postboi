---
name: postboi
description: Integrate the postboi messaging library — send email, SMS, WhatsApp, push and chat (Slack, Discord, Teams, Telegram, Bluesky) from any JS framework (SvelteKit, Next.js, Express, Hono, Remix, Nuxt, Astro), plus multi-channel `send()` that fans out or falls back across them. Wire contact forms with FormData parsing and spam protection, receive delivery webhooks, schedule and track sends. Covers SvelteKit remote functions (postboi/remote) and migrating hand-rolled email code to postboi. Also covers full account setup and provider migration from the terminal — sending domains + DNS via `bunx postboi domains`, importing recipients and suppressions, webhooks, members, and the REST API at api.postboi.app. Use whenever a task involves postboi, adding email / SMS / WhatsApp / push / chat sending or contact forms, setting up or migrating an email or SMS provider/ESP, or replacing nodemailer/direct provider SDK calls in a project that has (or should have) postboi installed.
---

# Postboi

Framework-agnostic messaging library. One `mail()` call, 20 email providers, normalized errors and webhooks across all of them — same shape for SMS, WhatsApp, push and chat, plus a `send()` that reaches someone across all of them.

Every docs page is raw Markdown at `https://docs.postboi.app/raw/<slug>` — fetch those for anything below marked with one. Everything in one file: `https://docs.postboi.app/llms-full.txt`.

## Setup

```bash
bunx postboi init   # or npx — email; add --sms, --whatsapp, --push or --chat for a channel
```

Always start here: it picks a provider, writes secrets, and installs the package. Don't hand-write provider wiring unless the runtime demands it (see [Edge runtimes](#edge-runtimes)).

**The config split is a hard rule:** API keys/tokens → env file. Provider name, defaults, non-secret options → committed `postboi.config.ts`.

```ts
// postboi.config.ts (committed)
import { config } from "postboi"

export default config({ provider: "resend", default: { from: "no-reply@example.com" } })
```

Building with Vite, add `postboi()` from `postboi/vite` to `vite.config` — `postboi init` does this for you. Nothing imports `postboi.config.*`, so without the plugin a deployed bundle won't contain it and its defaults and hooks silently vanish in production.

## Sending

```ts
import { mail } from "postboi"

await mail({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
```

| Field                             | Takes                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `body`                            | HTML string, `FormData`, plain object of fields, or a **promise** of any (`body: request.formData()` — no await) |
| `attachments`                     | one `File` or an array of them, straight from a file input                                                       |
| `to` `from` `cc` `bcc` `reply_to` | `"a@b.c"`, `"Name <a@b.c>"`, `{ address, name }`, or arrays                                                      |
| rest of `SendOptions`             | `headers`, `tags`, `idempotency_key`, `scheduled_at`, `tracking`, `unsubscribe_url`, `captcha` — `/raw/api`      |

A plain-text alternative is derived from the HTML automatically (`auto_text`, on by default).

## Other channels — SMS, WhatsApp, push, chat

Same shape as `mail()`: zero-config function off the package root, provider resolved from env then `postboi.config.ts`, the same `PostboiError`, an array argument for batches. Set one up with `bunx postboi init --sms` (or `--whatsapp`, `--push`, `--chat`).

```ts
import { sms, whatsapp, push, slack } from "postboi"

await sms({ to: "+447788223344", message: "Your code is 123456" })
await whatsapp({ to: "+447788223344", template: "order_shipped", variables: { name: "Ada" } })
await push({ to: subscription, title: "Deployed", message: "main is live" })
await slack({ message: "Deploy finished" }) // also discord, teams, telegram, bluesky
```

| Channel  | `to`                                                                                           | Options beyond `message`                                                                      | Providers                                            | Docs                                                                    |
| -------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| SMS      | one number or many                                                                             | `from`, `country` (ISO, resolves national numbers), `scheduled_at`, `tags`, `idempotency_key` | `twilio` `smsworks` `sns`                            | `/raw/sms`                                                              |
| WhatsApp | number                                                                                         | `template` + `variables`, `header`, `buttons`, `language`                                     | `twilio` `meta`                                      | `/raw/whatsapp`                                                         |
| Push     | Web Push subscription or device token                                                          | `title`, `icon`, `url`, `urgency`, `ttl`                                                      | `webpush` `fcm` `apns` `hms`                         | `/raw/push`                                                             |
| Chat     | webhook URL (Slack, Discord, Teams) or chat id (Telegram); usually configured once and omitted | `username` (Slack, Discord)                                                                   | one function per platform — no generic `chat` export | `/raw/slack` `/raw/discord` `/raw/teams` `/raw/telegram` `/raw/bluesky` |

Things that bite:

- **WhatsApp** — a free-form `message` only delivers **within 24h of the user's last reply**. Outside it, use `template` + `variables` or the send fails `outside_window`. `bunx postboi sync` narrows the `template` type to the names approved on the account.
- **Push targets must be registered first.** `subscribe()` from `postboi/push` in the browser (`sync` bakes in `VAPID_PUBLIC_KEY`, so it needs no options), `unsubscribe()` to drop it. Don't hand-roll the toggle state machine — see [Quick reference](#quick-reference).
- **Subscriptions rotate, and only the service worker hears about it.** `pushsubscriptionchange` fires nowhere else, so a worker without a handler misses one notification per rotation before the 410 self-heals it. `bunx postboi init --push` offers to wire the worker — it won't append to one that already handles `push` itself. The handler re-subscribes with the VAPID key and POSTs the replacement to your register endpoint with `old_endpoint` alongside it: delete that row, store the rest.
- **Web Push's VAPID pair is minted, not issued by a dashboard.** `bunx postboi init --push` writes one to `.env`; `bunx postboi vapid` prints a pair to stdout when the secrets belong elsewhere (a Worker, CI, a password manager); `generate_vapid_keys()` from `postboi/webpush` mints one in code. Mint **once** — a second pair orphans every subscription collected under the first.
- **`POSTBOI_*_PROVIDER`: required for SMS and WhatsApp, optional for push and chat.** SMS and WhatsApp never infer — a wrong guess is a billable message to a real handset, and `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` (the Twilio SDK's defaults, set by Voice and Verify users) plus `AWS_*` would be doing the guessing. Push and chat do infer, from a credential set that can only mean one provider: a VAPID trio alone is a working Web Push setup. Credentials the wider world sets for its own reasons are never treated as intent (`AWS_*`, `SMTP_*`, `CLOUDFLARE_*`, `TWILIO_*`, `MJ_APIKEY_*`, and every chat webhook/token name). For `send()`'s chat leg, a `to.chat` that is a recognisable Slack/Discord webhook URL names its own platform and needs nothing set.
- **Development intercepts rather than sends.** SMS and WhatsApp are _always_ captured in development (a stray one costs money and reaches a real handset); unconfigured chat and push fall back to capture too. It lands in the dev inbox at `/__postboi`. For real delivery: `POSTBOI_SMS_DEV=send`, `POSTBOI_WHATSAPP_DEV=send`, or `dev: { sms: false }` in config.

Config mirrors email — `sms` / `whatsapp` / `push` / `chat` sections (`provider`, `default`, non-secret `options`), credentials in env. `options` is scoped to the `provider` named beside it: option names repeat across vendors (`api_key`, `webhook_url`), so options written for one provider never reach another selected by env or by a platform function — that one asks for its own credential instead. `POSTBOI_<CHANNEL>_*` always wins:

- SMS — `POSTBOI_SMS_PROVIDER|FROM|TO|COUNTRY`
- WhatsApp — `POSTBOI_WHATSAPP_PROVIDER|FROM|TO|COUNTRY|LANGUAGE`
- Push — `POSTBOI_PUSH_PROVIDER|TO|ICON`
- Chat — `POSTBOI_CHAT_PROVIDER|TO|USERNAME`

### One call, every channel — `send()`

```ts
import { send } from "postboi"

const result = await send({
	to: { email: "ada@example.com", sms: "+447788223344", push: subscription },
	subject: "Order shipped",
	message: "Your order is on its way",
	channels: "cheapest", // push → chat → email → whatsapp → sms, stop at first success
})
```

|                                        |                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Omit `channels`                        | **fans out** to everything in `to`                                                                                                                |
| Array or `"cheapest"`                  | walks in order, stops at first success                                                                                                            |
| `message`                              | plain text every channel gets, and email's `text` part                                                                                            |
| `subject`                              | email subject, plus the chat/push title                                                                                                           |
| `body`                                 | email HTML                                                                                                                                        |
| `email` `sms` `chat` `push` `whatsapp` | per-channel overrides — WhatsApp's `template` belongs here, so it stays deliverable outside the 24h window while the rest carry the plain message |

Returns `{ ok, results, delivered }` and never rejects once a channel was attempted. The fan-out runs in your process, so nobody meters it. `/raw/send`

## Contact forms (FormData)

Passing `FormData` as `body` renders a tidy HTML table. Field names and values are HTML-escaped, so a public form can't inject markup into the email you read — **don't escape them yourself on the way in**. Multi-line values keep their breaks as `<br>`. Building a `body` string by hand instead? Use `escape_html` (or `escape_lines`) from `postboi` on any interpolated user input.

| Convention       |                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| Grouping         | `fieldset→field` (literal `→`): `name="contact→email"`                                                 |
| Special fields   | `_to` `_from` `_subject` `_reply_to` `_cc` `_bcc` — set send options instead of appearing in the table |
| Standard pattern | a hidden `_reply_to` bound to the submitter's email, so replies reach them                             |
| Attachments      | file inputs become attachments; the form needs `enctype="multipart/form-data"`                         |

### SvelteKit — pick the right one-liner

**First check whether the project uses remote functions**: `remoteFunctions: true` in `svelte.config.*` (or the `sveltekit()` call in `vite.config.*`), or any existing `*.remote.ts` files.

**In use → `postboi/remote`.** The library ships the whole backend; the component is the entire app. No `+page.server.ts`, no action:

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

Remote-form rules: field names are **nested JS paths** (`fields.contact.name`), not `contact→name` — the rendered email is identical. No schema needed (`mail` accepts arbitrary fields; spam checks run in the pipeline). Enhancement is built in — no `use:enhance`, auto-resets on success, `mail.pending` / `mail.result` carry state, degrades to a full-page POST without JS. Requires `optimizeDeps: { exclude: ["postboi/remote"] }` in `vite.config` (`postboi init` adds it, and the `postboi/vite` plugin carries it). Custom provider or forced fields: `remote(instance, { to?, subject?, … })` from `postboi/kit`, exported from your own `.remote.ts` — send options sit at the top level, there is no `fields` wrapper.

**Otherwise → the classic action from `postboi/kit`:**

```ts
// +page.server.ts
import { mail } from "postboi/kit"

export const actions = { default: mail }
```

Returns `{ success: true }` or `fail(400, { error })`. Explicit provider or defaults: `action(instance, { status?, ...send_options })` — again no `fields` wrapper. Full example: `/raw/sveltekit`.

Other frameworks, same pattern: `/raw/nextjs` `/raw/express` `/raw/hono` `/raw/remix` `/raw/nuxt` `/raw/astro`.

### Migrating existing email code to postboi

The lean path, in order. At every step the goal is **deleting code**, not wrapping it.

1. **Provider SDK calls / nodemailer / raw fetch to a mail API** → zero-config `mail()` (run `bunx postboi init` first). Delete the SDK dependency, the transport setup, and any hand-written HTML-escaping or field formatting — `body: FormData | fields` does the table.
2. **A SvelteKit action (or API route) that reads FormData and sends** → `export const actions = { default: mail }` from `postboi/kit`. Hidden `_subject` / `_reply_to` inputs replace server-side subject/reply-to code. Keep nothing of the old handler unless it did non-email work.
3. **Classic action → remote functions** (only if the project already enables them):

   | From                                            | To                                                                                                 |
   | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
   | `+page.server.ts` action                        | delete the file; `import { mail } from "postboi/remote"` in the component                          |
   | `<form method="POST" use:enhance enctype=…>`    | `<form {...mail} enctype=…>` (drop the `use:enhance` import)                                       |
   | `name="contact→email"`                          | `{...mail.fields.contact.email.as("email")}` (nesting replaces arrows)                             |
   | `<input type="hidden" name="_subject" value=…>` | `{...mail.fields._subject.as("hidden", …)}`                                                        |
   | `let { form } = $props()` result handling       | `mail.result` (`{ success: true }` / `{ success: false, error }`); pending UI → `mail.pending`     |
   | manual honeypot input                           | keep `<Captcha />`, or rename the raw input to `_honey` (remote forms reject non-path field names) |

   Add `optimizeDeps: { exclude: ["postboi/remote"] }` to `vite.config` if `postboi init` hasn't.

4. **Never** hand-write what the library owns: FormData parsing, HTML tables, HTML escaping, honeypot/captcha checks, provider error normalisation, webhook signature verification. If migrated code still contains any of those, the migration isn't finished.

## Spam protection

Two invisible layers, automatic on every FormData send. Easiest: drop the prop-free `<Captcha />` inside the form — `postboi/svelte`, `postboi/react`, `postboi/vue`, `postboi/astro`. It renders the honeypot and activates the managed invisible captcha (Postboi provider; key baked in by `bunx postboi sync`).

Manual honeypot — a visually hidden input named `_honey`. **Don't use `display: none`, bots detect it:**

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

A filled honeypot skips the send: `postboi/kit` still returns `{ success: true }` (the bot learns nothing); direct `mail()` throws a `SpamError` — catch with `is_spam(error)` and pretend success. Bring-your-own Cloudflare Turnstile: set `TURNSTILE_SECRET_KEY` and add the widget — note that setting the secret **enforces** the captcha on every FormData send (opt a send out with `captcha: { turnstile: false }`). `/raw/spam`

## Webhooks (delivery events)

```ts
// SvelteKit: src/routes/webhooks/email/+server.ts
import { webhook } from "postboi/kit"

export const POST = webhook(async (event) => {
	if (event.type === "bounced" && event.bounce?.category === "hard") await suppress(event.email)
})
```

Elsewhere: `receive(request)` from `postboi/webhooks` → normalized `WebhookEvent[]` (`sent | delivered | delayed | bounced | complained | opened | clicked | unsubscribed | failed`), with `event.client` parsed locally into name/os/device on opens and clicks. Signature verification is **fail-closed**: set `<PROVIDER>_WEBHOOK_SECRET` (e.g. `RESEND_WEBHOOK_SECRET`) or `receive()` throws. Test without a tunnel using `mock_event` / `mock_request`. `/raw/webhooks`

## Scheduling, tracking, bulk

- `scheduled_at: { days: 1, hours: 5 } | Date | ISO string` — provider-side; only Postboi, Resend, Brevo, Mailgun and SendGrid support it, **others send immediately**. `cancel(id)` where supported; unsupported providers throw `cancel_not_supported`, never a silent no-op. `/raw/scheduling`
- `tracking: { opens?, clicks? }` per send. `unsubscribe_url` sets RFC 8058 one-click headers (required by Gmail/Yahoo for bulk; the URL must accept a direct POST). `/raw/tracking`
- Bulk: pass an array to `mail()` — never throws, returns one result per message (`r.ok` / `r.error`). Personalized batches: one `to` array plus `data` keyed by address with `{name}` placeholders. `/raw/bulk`

## Errors & retries

Every provider on every channel throws the same normalised `PostboiError` (`provider`, `channel?`, `status?`, `code?`, `message`, `raw`); check with `mail.is_error(e)`. `channel` is what tells you which leg of a fan-out failed. Retries are **off by default on purpose** — enable `retries` only alongside an `idempotency_key` where supported, or you risk duplicate sends. `/raw/errors`

## Testing

```ts
import Mock from "postboi/mock"

const mail = new Mock({ default: { from: "no-reply@example.com" } })
await mail.send({ to: "a@b.c", subject: "Hi", body: "<p>x</p>" })
// mail.sent[0], mail.canceled
```

Every channel has one: `postboi/sms-mock`, `postboi/whatsapp-mock`, `postboi/push-mock`, `postboi/chat-mock` — same `sent` array, same normalisation. Or set `provider: "mock"` in that channel's config section to route the zero-config function through it.

## Edge runtimes

Cloudflare Workers, and anything else without a filesystem. `/raw/cloudflare-workers`

|                      |                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Credentials          | Worker bindings (`POSTBOI_TOKEN`, `TURNSTILE_SECRET_KEY`, `VAPID_PRIVATE_KEY`, …) are read automatically off `cloudflare:workers`. Don't reach for `new Postboi({ token: env.POSTBOI_TOKEN })` unless you're overriding        |
| Web Push on a Worker | three `wrangler secret put`s and no config file — no `POSTBOI_PUSH_PROVIDER` (inferred), no `nodejs_compat` (Web Crypto only)                                                                                                  |
| `nodejs_compat`      | needed for email and APNs (HTTP/2), not for Web Push                                                                                                                                                                           |
| Config file          | no filesystem, so it can't auto-load. Vite build → add `postboi()` from `postboi/vite` (also covers the `optimizeDeps` exclude). No Vite → `import "../postboi.config"` from the entry point, or `configure({ … })` at startup |
| Bundle size          | `push()` from the root pulls all four push providers, ~30 KB raw / 9 KB gzipped over importing `postboi/webpush` directly. Immaterial against a 3 MB limit; that's the lever if you're counting                                |

## Templates

`body` is just HTML — any renderer works. For designed emails the blessed pairing is Maizzle via the optional `postboi/maizzle` helper: `body: maizzle("./emails/welcome.vue", { name: "Ava" })`. Needs Node/Bun, not edge. React Email / MJML output drops into `body` the same way. `/raw/templates`

## Account setup & migration (CLI + REST API)

With the Postboi provider the whole account is manageable from the terminal. Exactly two steps need the human; everything else is agent-runnable:

1. **Sign-in** — `bunx postboi init` is interactive and opens a browser to authorise. Have the user run it, or drive it yourself and relay the printed URL. Once `POSTBOI_TOKEN` is in the env, every command below is non-interactive and safe to run repeatedly.
2. **DNS approval** — `domains add` prints a one-click setup URL the user clicks at their registrar (or pastes the printed records).

```bash
bunx postboi whoami                                # account, plan, usage — run first to verify the token
bunx postboi domains add example.com               # prints DNS records + one-click Domain Connect URL
bunx postboi domains check example.com             # re-check until verified (records land in minutes)
bunx postboi lists add Newsletter
bunx postboi recipients Newsletter add a@b.co c@d.co   # upserts contact + membership
bunx postboi contacts add ada@example.com --data '{"plan":"pro"}'  # one contact, global data, shared across lists
bunx postboi webhooks add https://example.com/api/events
bunx postboi sync                                  # writes the webhook secret to POSTBOI_WEBHOOK_SECRET
bunx postboi members invite colleague@example.com
bunx postboi suppressions add bounced@example.com
bunx postboi messages                              # recent sends with delivery status
bunx postboi webhooks deliveries <id>              # per-endpoint delivery log for debugging
```

Anything richer than the CLI exposes, use the REST API — interactive reference at https://api.postboi.app (OpenAPI at `/openapi.json`). Auth is `Authorization: Bearer $POSTBOI_TOKEN`; errors are always `{ "message", "code" }`.

**Cautions:** deletes are immediate and unprompted (`lists delete` takes the recipients with it). API-key management, member roles and billing are dashboard-only by design — send the user there rather than trying.

### Fresh project playbook

`init` (human signs in) → `whoami` → wire the code → optionally `domains add`, user clicks the setup link, `domains check` → only once **verified**, set `default.from` to the custom domain → `webhooks add` + `sync` if the app reacts to delivery events.

Until a domain verifies, sends come from the account's shared `send.postboi.email` address. That works immediately, so **never block the code migration on DNS**.

### Migrating from another ESP

Order matters — the old provider keeps sending until the new domain verifies.

1. `init` + `whoami`.
2. `domains add` the sending domain. The DKIM CNAMEs coexist with the old provider's records, so this is zero-downtime. `domains check` until verified.
3. **Import suppressions before anything sends** — export bounces/complaints/unsubscribes from the old provider, then `suppressions add` each (a loop is fine, one address per call).
4. Import recipients. Bare emails: `recipients <list> add …`. With names/custom data, or in bulk (up to 10,000 per call), POST the API:

   ```bash
   curl -X POST "https://api.postboi.app/v1/lists/Newsletter/recipients?status=subscribed" \
   	-H "Authorization: Bearer $POSTBOI_TOKEN" -H "Content-Type: application/json" \
   	-d '[{ "email": "a@b.co", "name": "Ada", "data": { "plan": "pro" } }]'
   ```

   **Critical on double-opt-in lists:** pass `?status=subscribed` (or per-row `"status": "subscribed"`) for already-confirmed subscribers — those rows get **no** confirmation email. Omitting it re-confirms the entire imported base.

5. Swap the sending code (see [Migrating existing email code](#migrating-existing-email-code-to-postboi)), and flip `default.from` once the domain is verified.
6. `webhooks add` + `sync`; port suppress-on-bounce logic to the normalized events.
7. Verify end-to-end: `messages` shows delivery statuses, `webhooks deliveries <id>` shows the event feed.

## Quick reference

| Task                                 | Import                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zero-config send / cancel            | `mail`, `cancel` from `postboi`                                                                                                                                                                                                                                                          |
| Other channels                       | `sms`, `whatsapp`, `push`, `slack`, `discord`, `teams`, `telegram`, `bluesky` from `postboi`                                                                                                                                                                                             |
| Multi-channel fan-out / fallback     | `send` from `postboi`                                                                                                                                                                                                                                                                    |
| Browser push subscription            | `subscribe`, `unsubscribe` from `postboi/push`                                                                                                                                                                                                                                           |
| Push service worker                  | `receive` from `postboi/push/sw` — the `push`, `notificationclick` and `pushsubscriptionchange` handlers. `bunx postboi init --push` wires it: the import where the framework builds the worker (SvelteKit), the handlers written out where it's served as-is (Next, Nuxt, Astro, Remix) |
| Push toggle state machine            | `subscription` from `postboi/svelte` (reactive: `push.on`, `push.busy`, `push.toggle`) · `usePush` from `postboi/react` · `use_push` from `postboi/vue` · `subscription` from `postboi/push` (store contract) anywhere else                                                              |
| Mint a VAPID pair                    | `generate_vapid_keys` from `postboi/webpush`, or `bunx postboi vapid`                                                                                                                                                                                                                    |
| Explicit provider                    | `postboi/resend`, `postboi/ses`, `postboi/smtp`, … (`/raw/providers` for all 20 + env var names)                                                                                                                                                                                         |
| Explicit channel provider            | `postboi/twilio`, `postboi/smsworks`, `postboi/sns`, `postboi/webpush`, `postboi/fcm`, `postboi/apns`, `postboi/hms`, `postboi/whatsapp-twilio`, `postboi/whatsapp-meta`, `postboi/slack`, …                                                                                             |
| SvelteKit action & webhook handler   | `mail`, `action`, `webhook` from `postboi/kit`                                                                                                                                                                                                                                           |
| SvelteKit remote form (experimental) | `mail` from `postboi/remote`; factory `remote` from `postboi/kit`                                                                                                                                                                                                                        |
| Webhooks anywhere                    | `receive`, `mock_event`, `mock_request` from `postboi/webhooks`                                                                                                                                                                                                                          |
| Captcha component                    | `postboi/svelte`, `postboi/react`, `postboi/vue`, `postboi/astro`                                                                                                                                                                                                                        |
| Escaping by hand                     | `escape_html`, `escape_lines` from `postboi`                                                                                                                                                                                                                                             |
| Maizzle templates                    | `postboi/maizzle`                                                                                                                                                                                                                                                                        |
| Vite plugin                          | `postboi` from `postboi/vite`                                                                                                                                                                                                                                                            |
| Global config                        | `config` from `postboi` (file) · `configure` from `postboi` (runtime)                                                                                                                                                                                                                    |
| Tests                                | `postboi/mock`, `postboi/sms-mock`, `postboi/whatsapp-mock`, `postboi/push-mock`, `postboi/chat-mock`                                                                                                                                                                                    |
| Spam helpers                         | `is_spam`, `SkipSendError` from `postboi`                                                                                                                                                                                                                                                |
