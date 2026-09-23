<div align="center">
  <img src="https://raw.githubusercontent.com/postboi-mail/postboi/refs/heads/main/static/logo.svg" alt="Postboi" width="250" />

**Every channel, zero config**

[![CI](https://shieldcn.dev/github/ci/postboi-mail/postboi.svg?size=xs&theme=blue&font=geist&variant=outline)](https://github.com/postboi-mail/postboi/actions/workflows/ci.yml)
[![npm](https://shieldcn.dev/npm/postboi.svg?size=xs&theme=blue&font=geist&variant=outline)](https://www.npmjs.com/package/postboi)
[![runtime Bun](https://shieldcn.dev/badge/runtime-Bun-blue.svg?size=xs&theme=blue&font=geist&logo=bun&variant=outline)](https://bun.sh)
[![framework Svelte](https://shieldcn.dev/badge/framework-Svelte-blue.svg?size=xs&theme=blue&font=geist&logo=svelte&variant=outline)](https://svelte.dev)

</div>

---

**Postboi is an email provider** — managed sending infrastructure, like Resend, Postmark or
SendGrid — **and the TypeScript SDK that talks to it.** One command gives you a token, and
`mail()` sends: no other provider account, no DNS, no card. Around it: custom sending domains,
lists and broadcasts, contacts, suppressions, a message log, delivery webhooks, hosted forms,
receiving, and email testing. The same API also sends **SMS, WhatsApp, push and chat**.

Bring your own provider is an _option_, not the premise: the same `mail()` call can go through
Resend, SES, Postmark or 40-odd others, so leaving Postboi — or never starting on it — is a
config change rather than a rewrite. You never _need_ another provider to use Postboi.

- **Postboi is an email service.** You can use it as your complete email infrastructure with
  just `POSTBOI_TOKEN`.
- **Postboi is an SDK.** One import, one call, one normalised error type, in any JS framework
  and optimised for SvelteKit.
- **Postboi can also front other providers**, when you want to keep an existing one.

📖 **Full documentation: [docs.postboi.app](https://docs.postboi.app)** · Choosing between
Postboi and Resend, SendGrid or nodemailer? See **[Postboi compared](https://docs.postboi.app/compare)**.

🤖 **Using an AI coding agent?** Setup needs no human at all: `bunx postboi init --agent`
provisions a working, claimable account with zero prompts and zero sign-in — the agent
wires everything, you claim the project with one click when you're ready. The package
also ships a skill that teaches agents the whole library. `bunx postboi skill` installs
it at `.claude/skills/postboi/SKILL.md` and `.agents/skills/postboi/SKILL.md`, with the
longer recipes beside it in `references/`, and adds a three-line pointer to an existing
`AGENTS.md` (`init` offers the same thing), or read it in place at
`node_modules/postboi/skills/postboi/SKILL.md`. Every docs page is also plain
Markdown at [`docs.postboi.app/raw/<slug>`](https://docs.postboi.app/raw/push) — the HTML
pages render client-side, so fetch those instead. All of it in one file:
[`/llms-full.txt`](https://docs.postboi.app/llms-full.txt).

### Features

- ☁️ **Postboi is the provider** - `postboi init`, sign in, send. The [Postboi provider](https://docs.postboi.app/provider) is managed sending, domains, lists & broadcasts, suppressions and a message log — one token, no DNS, no card, no second vendor
- 🤖 **Zero setup for agents & CI** - `postboi init --agent` needs no sign-in either: it provisions a [claimable sandbox project](https://docs.postboi.app/provider#zero-setup-for-agents--ci) in one round trip — an AI agent wires everything, you claim it with one click
- 👨‍💻 **Zero configuration** - works out of the box with minimal setup
- 🔌 **Or bring your own provider** - optionally send through Resend, SES, Mailgun, Postmark, … instead, and swap without changing your code
- 📝 **Smart FormData parsing** - automatically converts FormData to HTML tables
- 🎯 **Grouped fields** - organize form fields with `fieldset→field` syntax
- 📎 **Attachments** - attach files directly from form inputs or file objects
- 📮 **Hosted forms** - no backend? point any HTML form at a [hosted endpoint](https://docs.postboi.app/forms) and submissions land in your inbox, spam-checked
- 🎨 **Bring your own templates** - `body` takes any HTML, and the optional `postboi/maizzle` helper renders [Maizzle](https://docs.postboi.app/templates) templates straight into it
- 📬 **Webhooks** - receive delivery events ([delivered / opened / clicked / bounced](https://docs.postboi.app/webhooks)) normalized across providers, signatures verified — including _which client and device_ opened the mail
- 📈 **Per-send tracking & one-click unsubscribe** - `tracking: { opens, clicks }` and `unsubscribe_url` ([RFC 8058 headers](https://docs.postboi.app/tracking)) on any provider that supports them
- ⏰ **Schedule & cancel** - `scheduled_at` for future sends, `cancel(id)` to [call them off](https://docs.postboi.app/scheduling)
- 📥 **Local dev inbox** - mail you send in development lands in a [mailbox at `/__postboi`](https://docs.postboi.app/dev-inbox) instead of a real inbox — rendered HTML, headers, attachments. No code changes, no second tool, and no way to accidentally mail a customer from your laptop
- 🔍 **Email testing** - [`analyze()` from `postboi/inspect`](https://docs.postboi.app/email-testing) lints an email before anyone receives it: client compatibility from [Can I email](https://www.caniemail.com) data, Gmail clipping, missing alt text, dead links, unsubscribe headers. Synchronous, zero-network, zero-dependency — drop it into any test suite
- 🍯 **Invisible spam protection** - a zero-config [honeypot](https://docs.postboi.app/spam), plus invisible captcha — fully managed on the Postboi provider, or bring your own Turnstile key
- 🗂️ **Named forms** - `mail({ form: "Contact" })` files the submission under a form in the dashboard, fields and all, ready to [export as a table](https://docs.postboi.app/formdata#naming-the-form); `postboi sync` types the names
- 🧩 **`<Captcha />` component** - one prop-free tag inside your own form, for [Svelte, React, Vue and Astro](https://docs.postboi.app/spam#the-captcha-component) — `postboi sync` bakes in the key
- 🛡️ **Type-safe** - full TypeScript support with normalized error handling
- 💬 **Every channel, one shape** - [`sms()`](https://docs.postboi.app/sms), [`whatsapp()`](https://docs.postboi.app/whatsapp), [`push()`](https://docs.postboi.app/push), [`slack()`, `discord()`, `teams()`, `telegram()` and `bluesky()`](https://docs.postboi.app/slack) resolve, hook and error exactly like `mail()` — Twilio, The SMS Works, Meta, Web Push, FCM and friends behind them
- 📡 **Multi-channel `send()`** - [one call](https://docs.postboi.app/send) fans out to everything in `to`, or walks `channels: "cheapest"` (push → chat → email → whatsapp → sms) and stops at the first success — the fan-out runs in your process, so nobody meters it

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
[dashboard](https://postboi.app/dashboard).

No human at the keyboard? **`bunx postboi init --agent`** does the same thing with zero
prompts and zero sign-in: it provisions a claimable project on the spot (your
`package.json` name becomes the sending address — `@acme/mail-site` sends from
`mail-site@send.postboi.email`), sends run sandboxed into your message log, and one click
on the printed claim URL flips them to real delivery. Built for AI coding agents and CI —
see [Zero setup](https://docs.postboi.app/provider#zero-setup-for-agents--ci).

`init` also:

- writes defaults, hooks and the publishable captcha key to a committed
  [`postboi.config.ts`](https://docs.postboi.app/config) — everything but the token lives in version control
- **types `from`** to the addresses your account can actually send from, so a wrong one is
  a type error instead of a runtime `from_not_allowed`
- wires **managed captcha** (`<Captcha />` works with no keys) and your **webhook secrets**

Beyond `mail()`, the token unlocks [message status](https://docs.postboi.app/provider#delivery-status),
[recipient lists, broadcasts and double opt-in](https://docs.postboi.app/provider#lists--broadcasts),
your [contacts (the audience)](https://docs.postboi.app/provider#contacts-the-audience),
[suppressions](https://docs.postboi.app/provider#suppressions), and
[batching with idempotency keys](https://docs.postboi.app/provider#batching--idempotency) — same import,
no extra SDK:

```typescript
import { mail } from "postboi"

await mail.recipients.add("Newsletter", "Ada Lovelace <ada@example.com>")
await mail.contacts.add("ada@example.com", { data: { plan: "pro" } }) // one contact, shared across lists
```

Full details: [The Postboi provider](https://docs.postboi.app/provider).

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

| Topic                                    | Docs                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Quick start — the CLI (`postboi init`)   | [docs.postboi.app/quick-start](https://docs.postboi.app/quick-start)   |
| The Postboi provider                     | [docs.postboi.app/provider](https://docs.postboi.app/provider)         |
| Manual setup (no CLI)                    | [docs.postboi.app/manual-setup](https://docs.postboi.app/manual-setup) |
| SvelteKit form actions                   | [docs.postboi.app/sveltekit](https://docs.postboi.app/sveltekit)       |
| FormData → HTML tables                   | [docs.postboi.app/formdata](https://docs.postboi.app/formdata)         |
| All providers & their options            | [docs.postboi.app/providers](https://docs.postboi.app/providers)       |
| Hooks, global config, retries, bulk send | [docs.postboi.app/config](https://docs.postboi.app/config)             |
| API reference                            | [docs.postboi.app/api](https://docs.postboi.app/api)                   |

> Cloudflare Workers work the same way — bindings are read as env vars, and the `postboi/vite` plugin bundles `postboi.config.ts` in place of the filesystem auto-load. See [Cloudflare Workers](https://docs.postboi.app/cloudflare-workers).

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

| Channel                          | Docs                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| Multi-channel `send()`           | [docs.postboi.app/send](https://docs.postboi.app/send)         |
| SMS (and RCS)                    | [docs.postboi.app/sms](https://docs.postboi.app/sms)           |
| WhatsApp                         | [docs.postboi.app/whatsapp](https://docs.postboi.app/whatsapp) |
| Push (Web Push, FCM, APNs, Expo) | [docs.postboi.app/push](https://docs.postboi.app/push)         |
| Chat (Slack, Discord, …)         | [docs.postboi.app/slack](https://docs.postboi.app/slack)       |

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
