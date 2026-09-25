<div align="center">
  <img src="https://raw.githubusercontent.com/postboi-mail/postboi/refs/heads/main/static/logo.svg" alt="Postboi" width="250" />

**Email for your app, set up with one command**

[![CI](https://shieldcn.dev/github/ci/postboi-mail/postboi.svg?size=xs&theme=blue&font=geist&variant=outline)](https://github.com/postboi-mail/postboi/actions/workflows/ci.yml)
[![npm](https://shieldcn.dev/npm/postboi.svg?size=xs&theme=blue&font=geist&variant=outline)](https://www.npmjs.com/package/postboi)
[![runtime Bun](https://shieldcn.dev/badge/runtime-Bun-blue.svg?size=xs&theme=blue&font=geist&logo=bun&variant=outline)](https://bun.sh)
[![framework Svelte](https://shieldcn.dev/badge/framework-Svelte-blue.svg?size=xs&theme=blue&font=geist&logo=svelte&variant=outline)](https://svelte.dev)

</div>

---

**Postboi is an email provider, and `postboi` is its TypeScript SDK.** Run
`npx postboi init` and `mail()` sends: no DNS, no card, no other provider to sign up for.
Receiving, lists, webhooks and forms are already in the box.

3,000 emails a month are free, for good. After that it's £9 for 40,000 or £25 for 100,000,
which is less than Resend charges for the same volume
([Postboi or Resend?](https://postboi.app/compare/resend)).

Already have a provider? `mail()` works with Resend, SES, Postmark and 40-odd others too, so
switching is a line of config. You don't need any of them to use Postboi. And when you want
more than email, the same API sends SMS, WhatsApp, push and chat.

📖 [Docs](https://docs.postboi.app) · [Pricing](https://postboi.app/pricing) · [Postboi compared](https://docs.postboi.app/compare) · [Dashboard](https://postboi.app/dashboard)

## Quick start

```bash
bunx postboi init
```

Pick **Postboi**, sign in in the browser, and you're done. The CLI writes one secret:

```bash
# .env
POSTBOI_TOKEN=…
```

```typescript
import { mail } from "postboi"

await mail({ to: "ada@example.com", subject: "Hi", body: "<p>Hello</p>" })
```

Mail goes out from `you@send.postboi.email` until you verify your own domain. Everything
that isn't a secret (defaults, hooks, the captcha key) goes in a committed
[`postboi.config.ts`](https://docs.postboi.app/config), and `from` is typed to the addresses
your account can send from.

No one at the keyboard? `bunx postboi init --agent` sets up a project with no prompts and no
sign-in. Sends stay sandboxed until someone claims it with one click.
[More on that](https://docs.postboi.app/provider#zero-setup-for-agents--ci).

## What you get

- **Sending, domains, lists and broadcasts, contacts, suppressions and a message log**, all
  on the one token. [The Postboi provider](https://docs.postboi.app/provider)
- **FormData to email.** Hand `mail()` a `FormData` and it becomes a tidy HTML table, with
  attachments and [grouped fields](https://docs.postboi.app/formdata)
- **Hosted forms** for sites with no backend, and
  [spam protection](https://docs.postboi.app/spam) (honeypot plus an invisible captcha)
- **A dev inbox** at [`/__postboi`](https://docs.postboi.app/dev-inbox), so mail sent in
  development never reaches a real person
- **Webhooks** for delivered, opened, clicked and bounced, in one format
  [whichever provider sent it](https://docs.postboi.app/webhooks)
- **Scheduling, tracking and one-click unsubscribe.**
  [Scheduling](https://docs.postboi.app/scheduling) ·
  [Tracking](https://docs.postboi.app/tracking)
- **Email testing.** [`analyze()`](https://docs.postboi.app/email-testing) checks client
  support, Gmail clipping, alt text and links, offline, in any test suite
- **Any HTML** for the body, or [Maizzle](https://docs.postboi.app/templates) templates
- **One error type**, `PostboiError`, whichever provider failed

## Bring your own provider

Pick **Bring your own provider** in `postboi init` instead. Your code stays the same:

```typescript
// postboi.config.ts
import { config } from "postboi"

export default config({ provider: "resend", default: { from: "no-reply@example.com" } })
```

```bash
# .env
RESEND_API_KEY=re_xxxxxxxx
```

See [all providers](https://docs.postboi.app/providers).

## SvelteKit

A contact form action is one line:

```typescript
// +page.server.ts
import { mail } from "postboi/kit"

export const actions = { default: mail }
```

Or use [remote functions](https://docs.postboi.app/sveltekit) with `postboi/remote` and skip
the server file. Postboi also has guides for [Next.js](https://docs.postboi.app/nextjs),
[Astro](https://docs.postboi.app/astro), [Nuxt](https://docs.postboi.app/nuxt),
[Remix](https://docs.postboi.app/remix), [Hono](https://docs.postboi.app/hono),
[Express](https://docs.postboi.app/express) and
[Cloudflare Workers](https://docs.postboi.app/cloudflare-workers).

## Beyond email

Run `bunx postboi init --sms` (or `--whatsapp`, `--push`, `--chat`) and call the function:

```typescript
import { sms, whatsapp, push, slack, send } from "postboi"

await sms({ to: "+447788223344", message: "Your code is 4291" })
await whatsapp({ to: "+447788223344", template: "order_shipped", variables: { name: "Ada" } })
await push({ to: subscription, title: "Order shipped", message: "On its way" })
await slack({ message: "Deploy finished" })

// or try the cheapest channel first and stop when one works
await send({
	to: { push: subscription, sms: "+447788223344" },
	channels: "cheapest",
	message: "Your code is 4291",
})
```

In development, texts and WhatsApp messages are logged, not sent.
[SMS](https://docs.postboi.app/sms) · [WhatsApp](https://docs.postboi.app/whatsapp) ·
[Push](https://docs.postboi.app/push) · [Chat](https://docs.postboi.app/slack) ·
[`send()`](https://docs.postboi.app/send)

## For AI agents

- `bunx postboi skill` installs a skill that teaches the whole library, at
  `.claude/skills/postboi/` and `.agents/skills/postboi/`. It also ships in the package at
  `node_modules/postboi/skills/postboi/SKILL.md`.
- The docs pages render client-side, so fetch plain Markdown from
  `https://docs.postboi.app/raw/<slug>`, or everything at once from
  [`/llms-full.txt`](https://docs.postboi.app/llms-full.txt).

## Development

```bash
bun install
bun run dev     # the docs site
bun run check   # types
bun run lint
bun run test
bun run build   # the package
```

PRs are welcome, new providers especially. Match the code style (snake_case, no
semicolons), add tests, and run `check` and `lint` before pushing. Releases are covered in
[RELEASING.md](RELEASING.md).
