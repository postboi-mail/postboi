<div align="center">
  <img src="https://raw.githubusercontent.com/postboi-mail/postboi/refs/heads/main/static/logo.svg" alt="Postboi" width="250" />

**I got ninety-nine problems, but mail ain't one**

[![CI](https://github.com/postboi-mail/postboi/actions/workflows/ci.yml/badge.svg)](https://github.com/postboi-mail/postboi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/postboi)](https://www.npmjs.com/package/postboi)

</div>

---

Postboi is a framework-agnostic messaging library optimised for SvelteKit — **email first, and now SMS, WhatsApp, push and chat behind the same API**. Works with a variety of providers and turns your FormData into tidy HTML emails, with **zero configuration**.

📖 **Full documentation: [docs.postboi.email](https://docs.postboi.email)**

### Features

- ☁️ **Send with no provider account** - `postboi init`, sign in, send. The [Postboi provider](https://docs.postboi.email/provider) brings managed sending, domains, lists & broadcasts, suppressions and a message log — one token, no DNS, no card
- 👨‍💻 **Zero configuration** - works out of the box with minimal setup
- 🔌 **Provider-based** - or bring your own (Resend, SES, Mailgun, Postmark, …) and swap it without changing your code
- 📝 **Smart FormData parsing** - automatically converts FormData to HTML tables
- 🎯 **Grouped fields** - organize form fields with `fieldset→field` syntax
- 📎 **Attachments** - attach files directly from form inputs or file objects
- 📮 **Hosted forms** - no backend? point any HTML form at a [hosted endpoint](https://docs.postboi.email/forms) and submissions land in your inbox, spam-checked
- 🎨 **Bring your own templates** - `body` takes any HTML, and the optional `postboi/maizzle` helper renders [Maizzle](https://docs.postboi.email/templates) templates straight into it
- 📬 **Webhooks** - receive delivery events ([delivered / opened / clicked / bounced](https://docs.postboi.email/webhooks)) normalized across providers, signatures verified — including _which client and device_ opened the mail
- 📈 **Per-send tracking & one-click unsubscribe** - `tracking: { opens, clicks }` and `unsubscribe_url` ([RFC 8058 headers](https://docs.postboi.email/tracking)) on any provider that supports them
- ⏰ **Schedule & cancel** - `scheduled_at` for future sends, `cancel(id)` to [call them off](https://docs.postboi.email/scheduling)
- 📥 **Local dev inbox** - mail you send in development lands in a [mailbox at `/__postboi`](https://docs.postboi.email/dev-inbox) instead of a real inbox — rendered HTML, headers, attachments. No code changes, no second tool, and no way to accidentally mail a customer from your laptop
- 🍯 **Invisible spam protection** - a zero-config [honeypot](https://docs.postboi.email/spam), plus invisible captcha — fully managed on the Postboi provider, or bring your own Turnstile key
- 🧩 **`<Captcha />` component** - one prop-free tag inside your own form, for [Svelte, React, Vue and Astro](https://docs.postboi.email/spam#the-captcha-component) — `postboi sync` bakes in the key
- 🛡️ **Type-safe** - full TypeScript support with normalized error handling
- 💬 **Every channel, one shape** - [`sms()`](https://docs.postboi.email/sms), [`whatsapp()`](https://docs.postboi.email/whatsapp), [`push()`](https://docs.postboi.email/push), [`slack()`, `discord()`, `teams()` and `telegram()`](https://docs.postboi.email/chat) resolve, hook and error exactly like `mail()` — Twilio, The SMS Works, Meta, Web Push, FCM and friends behind them
- 📡 **Multi-channel `send()`** - [one call](https://docs.postboi.email/send) fans out to everything in `to`, or walks `channels: "cheapest"` (push → chat → email → whatsapp → sms) and stops at the first success — the fan-out runs in your process, so nobody meters it

## Quick start

```bash
bunx postboi init
```

Pick **Postboi** at the first prompt and you're sending in under a minute. The CLI opens
your browser, authorises the device, and writes a single env var — no provider account,
no API keys to copy, no DNS, no card:

```bash
# .env  (gitignored — the only secret)
POSTBOI_TOKEN=…
```

```typescript
import { mail } from "postboi"

await mail({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
```

That's the whole setup. Mail goes out from your `you@send.postboi.email` address (set
`reply_to` to get replies) until you verify a domain of your own in the
[dashboard](https://postboi.email/dashboard). `init` also:

- writes defaults, hooks and the publishable captcha key to a committed
  [`postboi.config.ts`](https://docs.postboi.email/config) — everything but the token lives in version control
- **types `from`** to the addresses your account can actually send from, so a wrong one is
  a type error instead of a runtime `from_not_allowed`
- wires **managed captcha** (`<Captcha />` works with no keys) and your **webhook secrets**

Beyond `mail()`, the token unlocks [message status](https://docs.postboi.email/provider#delivery-status),
[recipient lists, broadcasts and double opt-in](https://docs.postboi.email/provider#lists--broadcasts),
your [contacts (the audience)](https://docs.postboi.email/provider#contacts-the-audience),
[suppressions](https://docs.postboi.email/provider#suppressions), and
[batching with idempotency keys](https://docs.postboi.email/provider#batching--idempotency) — same import,
no extra SDK:

```typescript
import { mail } from "postboi"

await mail.recipients.add("Newsletter", "Ada Lovelace <ada@example.com>")
await mail.contacts.add("ada@example.com", { data: { plan: "pro" } }) // one contact, shared across lists
```

Full details: [The Postboi provider](https://docs.postboi.email/provider).

### Bring your own provider

Prefer Resend, SES, Mailgun, Postmark…? Pick **Bring your own provider** instead and the
CLI collects that provider's credentials. Secrets go to your env file, everything else to
the committed config — best case, still a single env var:

```typescript
// postboi.config.ts  (committed)
import { config } from "postboi"

export default config({
	provider: "resend",
	default: { from: "no-reply@example.com" },
})
```

```bash
# .env  (gitignored — secrets only)
RESEND_API_KEY=re_xxxxxxxx
```

Every example below is identical either way: `mail()` picks up whichever provider is
configured — no provider import, no constructor.

On SvelteKit, a form action is a one-liner:

```typescript
// +page.server.ts
import { mail } from "postboi/kit"

export const actions = { default: mail }
```

Or skip the server file entirely with [remote functions](https://svelte.dev/docs/kit/remote-functions)
(experimental — set `kit.experimental.remoteFunctions: true`; `postboi init` adds the
required `optimizeDeps: { exclude: ["postboi/remote"] }` to `vite.config` for you):

```svelte
<script>
	import { mail } from "postboi/remote"
</script>

<form {...mail}>
	<input {...mail.fields.contact.name.as("text")} required />
	<input {...mail.fields.contact.email.as("email")} required />
	<button disabled={!!mail.pending}>Send</button>
</form>

{#if mail.result?.success}<p>Thanks!</p>{/if}
```

Nested fields (`contact.name`) group in the email exactly like the classic `contact→name`
syntax, spam protection and attachments included. For a custom provider or forced fields,
build your own with `remote(...)` from `postboi/kit`.

| Topic                                    | Docs                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Quick start — the CLI (`postboi init`)   | [docs.postboi.email/quick-start](https://docs.postboi.email/quick-start)   |
| The Postboi provider                     | [docs.postboi.email/provider](https://docs.postboi.email/provider)         |
| Manual setup (no CLI)                    | [docs.postboi.email/manual-setup](https://docs.postboi.email/manual-setup) |
| SvelteKit form actions                   | [docs.postboi.email/sveltekit](https://docs.postboi.email/sveltekit)       |
| FormData → HTML tables                   | [docs.postboi.email/formdata](https://docs.postboi.email/formdata)         |
| All providers & their options            | [docs.postboi.email/providers](https://docs.postboi.email/providers)       |
| Hooks, global config, retries, bulk send | [docs.postboi.email/config](https://docs.postboi.email/config)             |
| API reference                            | [docs.postboi.email/api](https://docs.postboi.email/api)                   |

> Cloudflare Workers work the same way — bindings are read as env vars, and the `postboi/vite` plugin bundles `postboi.config.ts` in place of the filesystem auto-load. See [Cloudflare Workers](https://docs.postboi.email/cloudflare-workers).

## Beyond email

Every channel is the same three moves: `bunx postboi init --sms` (or `--whatsapp`,
`--push`, `--chat`), credentials land in env, then call the function. Same hooks, same
normalized errors, same zero config:

```typescript
import { sms, whatsapp, push, slack, send } from "postboi"

await sms({ to: "+447788223344", message: "Your code is 4291" })
await whatsapp({ to: "+447788223344", template: "order_shipped", variables: { name: "Ada" } })
await push({ to: subscription, title: "Order shipped", message: "On its way" })
await slack({ message: "Deploy finished" })

// …or one call that stops at the first (cheapest) channel that works:
await send({
	to: { push: subscription, sms: "+447788223344" },
	channels: "cheapest",
	message: "Your code is 4291",
})
```

In development, texts and WhatsApp messages are **logged, never sent** — the same
no-way-to-mail-a-customer-from-your-laptop guarantee the dev inbox gives email, but
stricter, because a stray text costs money and can't be recalled.

| Channel                  | Docs                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| Multi-channel `send()`   | [docs.postboi.email/send](https://docs.postboi.email/send)         |
| SMS (and RCS)            | [docs.postboi.email/sms](https://docs.postboi.email/sms)           |
| WhatsApp                 | [docs.postboi.email/whatsapp](https://docs.postboi.email/whatsapp) |
| Push (Web Push, FCM)     | [docs.postboi.email/push](https://docs.postboi.email/push)         |
| Chat (Slack, Discord, …) | [docs.postboi.email/chat](https://docs.postboi.email/chat)         |

## Development

```bash
# install dependencies
bun install

# start dev server
bun run dev

# type checking
bun run check

# linting
bun run lint

# run tests
bun run test

# build library
bun run build
```

The docs site is the SvelteKit app at the repo root — `bun run dev` serves it locally.

## Contributing

PRs welcome! Especially for new email providers. Make sure you:

- Follow the existing code style (snake_case, no semicolons)
- Add tests for new features
- Run `bun run check` and `bun run lint` before pushing

## Releasing

Maintainers: `npm run release -- <patch|minor|major>` publishes the library and
creates the GitHub release. See [RELEASING.md](RELEASING.md) for the full
process, including snapshotting the versioned docs.
