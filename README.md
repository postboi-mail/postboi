<div align="center">
  <img src="https://raw.githubusercontent.com/postboi-mail/postboi/refs/heads/main/static/logo.svg" alt="Postboi" width="250" />

**I got ninety-nine problems, but mail ain't one**

[![CI](https://github.com/postboi-mail/postboi/actions/workflows/ci.yml/badge.svg)](https://github.com/postboi-mail/postboi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/postboi)](https://www.npmjs.com/package/postboi)

</div>

---

Postboi is a framework-agnostic email library optimised for SvelteKit. Works with a variety of email providers and turns your FormData into tidy HTML emails, with **zero configuration**.

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
- 🍯 **Invisible spam protection** - a zero-config [honeypot](https://docs.postboi.email/spam), plus invisible captcha — fully managed on the Postboi provider, or bring your own Turnstile key
- 🧩 **`<Captcha />` component** - one prop-free tag inside your own form, for [Svelte, React, Vue and Astro](https://docs.postboi.email/spam#the-captcha-component) — `postboi sync` bakes in the key
- 🛡️ **Type-safe** - full TypeScript support with normalized error handling

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
[suppressions](https://docs.postboi.email/provider#suppressions), and
[batching with idempotency keys](https://docs.postboi.email/provider#batching--idempotency) — same import,
no extra SDK:

```typescript
import { add_recipients } from "postboi"

await add_recipients("Newsletter", "Ada Lovelace <ada@example.com>")
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
