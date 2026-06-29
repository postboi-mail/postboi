<div align="center">
  <img src="https://raw.githubusercontent.com/darbymanning/postboi/refs/heads/main/static/logo.svg" alt="Postboi" width="250" />

**I got ninety-nine problems, but mail ain't one**

[![CI](https://github.com/darbymanning/postboi/actions/workflows/ci.yml/badge.svg)](https://github.com/darbymanning/postboi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/postboi)](https://www.npmjs.com/package/postboi)

</div>

---

Postboi is a framework-agnostic email library optimised for SvelteKit. Works with a variety of email providers and turns your FormData into tidy HTML emails, with **zero configuration**.

📖 **Full documentation: [postboi.uiloco.workers.dev](https://postboi.uiloco.workers.dev)**

### Features
- 👨‍💻 **Zero configuration** - works out of the box with minimal setup
- 🔌 **Provider-based** - swap email providers without changing your code
- 📝 **Smart FormData parsing** - automatically converts FormData to HTML tables
- 🎯 **Grouped fields** - organize form fields with `fieldset→field` syntax
- 📎 **Attachments** - attach files directly from form inputs or file objects
- 🛡️ **Type-safe** - full TypeScript support with normalized error handling

## Quick start

Run the CLI to choose a provider, input credentials, optionally set defaults.

```bash
bunx postboi init
```

Then send from anywhere — no provider import, no constructor, credentials come from env:

```typescript
import { send } from "postboi"

await send({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
```

On SvelteKit, a form action is a one-liner:

```typescript
// +page.server.ts
import { send } from "postboi/kit"

export const actions = { default: send }
```

| Topic                                                  | Docs                                            |
| ------------------------------------------------------ | ----------------------------------------------- |
| Quick start — the CLI (`postboi init`)                 | [postboi.uiloco.workers.dev/quick-start](https://postboi.uiloco.workers.dev/quick-start) |
| Manual setup (no CLI)                                  | [postboi.uiloco.workers.dev/manual-setup](https://postboi.uiloco.workers.dev/manual-setup) |
| SvelteKit form actions                                 | [postboi.uiloco.workers.dev/sveltekit](https://postboi.uiloco.workers.dev/sveltekit) |
| FormData → HTML tables                                 | [postboi.uiloco.workers.dev/formdata](https://postboi.uiloco.workers.dev/formdata)   |
| All providers & their options                          | [postboi.uiloco.workers.dev/providers](https://postboi.uiloco.workers.dev/providers) |
| Hooks, global settings, retries, bulk send             | [postboi.uiloco.workers.dev/settings](https://postboi.uiloco.workers.dev/settings)   |
| API reference                                          | [postboi.uiloco.workers.dev/api](https://postboi.uiloco.workers.dev/api)             |

> On runtimes without ambient env vars (e.g. Cloudflare Workers), construct the provider directly — see [Providers](https://postboi.uiloco.workers.dev/providers#using-a-provider-directly).

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

The docs site lives in [`docs/`](docs) — `cd docs && bun install && bun run dev`.

## Contributing

PRs welcome! Especially for new email providers. Make sure you:

- Follow the existing code style (snake_case, no semicolons)
- Add tests for new features
- Run `bun run check` and `bun run lint` before pushing
