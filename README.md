<div align="center">
  <img src="https://raw.githubusercontent.com/darbymanning/postboi/refs/heads/main/static/logo.svg" alt="Postboi" width="250" />

**I got ninety-nine problems, but mail ain't one**

[![CI](https://github.com/darbymanning/postboi/actions/workflows/ci.yml/badge.svg)](https://github.com/darbymanning/postboi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/postboi)](https://www.npmjs.com/package/postboi)

</div>

---

Postboi is a framework-agnostic email library optimised for SvelteKit. Works with a variety of email providers and turns your FormData into tidy HTML emails, with **zero configuration**.

📖 **Full documentation: [docs.postboi.email](https://docs.postboi.email)**

### Features

- 👨‍💻 **Zero configuration** - works out of the box with minimal setup
- 🔌 **Provider-based** - swap email providers without changing your code
- 📝 **Smart FormData parsing** - automatically converts FormData to HTML tables
- 🎯 **Grouped fields** - organize form fields with `fieldset→field` syntax
- 📎 **Attachments** - attach files directly from form inputs or file objects
- 🎨 **Bring your own templates** - `body` takes any HTML, and the optional `postboi/maizzle` helper renders [Maizzle](https://docs.postboi.email/templates) templates straight into it
- 🍯 **Invisible spam protection** - a zero-config [honeypot](https://docs.postboi.email/spam), plus invisible captcha — fully managed on Postboi Cloud, or bring your own Turnstile key
- 🧩 **`<Captcha />` component** - one prop-free tag inside your own form, for [Svelte, React, Vue and Astro](https://docs.postboi.email/spam#the-captcha-component) — `postboi sync` bakes in the key
- 🛡️ **Type-safe** - full TypeScript support with normalized error handling

## Quick start

Run the CLI to choose a provider, input credentials, optionally set defaults.

```bash
bunx postboi init
```

It writes your provider, defaults, and non-secret options to a committed
`postboi.config.ts`, keeping only secrets (API keys) in your env file — so the best case is
a single env var:

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

Then send from anywhere — no provider import, no constructor, config is picked up automatically:

```typescript
import { mail } from "postboi"

await mail({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
```

On SvelteKit, a form action is a one-liner:

```typescript
// +page.server.ts
import { mail } from "postboi/kit"

export const actions = { default: mail }
```

| Topic                                    | Docs                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Quick start — the CLI (`postboi init`)   | [docs.postboi.email/quick-start](https://docs.postboi.email/quick-start)   |
| Manual setup (no CLI)                    | [docs.postboi.email/manual-setup](https://docs.postboi.email/manual-setup) |
| SvelteKit form actions                   | [docs.postboi.email/sveltekit](https://docs.postboi.email/sveltekit)       |
| FormData → HTML tables                   | [docs.postboi.email/formdata](https://docs.postboi.email/formdata)         |
| All providers & their options            | [docs.postboi.email/providers](https://docs.postboi.email/providers)       |
| Hooks, global config, retries, bulk send | [docs.postboi.email/config](https://docs.postboi.email/config)             |
| API reference                            | [docs.postboi.email/api](https://docs.postboi.email/api)                   |

> On runtimes without ambient env vars (e.g. Cloudflare Workers), construct the provider directly — see [Providers](https://docs.postboi.email/providers#using-a-provider-directly).

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
