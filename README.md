<div align="center">
  <img src="https://raw.githubusercontent.com/darbymanning/postboi/refs/heads/main/static/logo.svg" alt="Postboi" width="250" />

**I got ninety-nine problems, but mail ain't one**

[![CI](https://github.com/darbymanning/postboi/actions/workflows/ci.yml/badge.svg)](https://github.com/darbymanning/postboi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/postboi)](https://www.npmjs.com/package/postboi)

</div>

---

Postboi is a framework-agnostic email library optimised for SvelteKit. Works with a variety of email providers and turns your FormData into tidy HTML emails, with **zero configuration**.

### Features
- 👨‍💻 **Zero configuration** - works out of the box with minimal setup
- 🔌 **Provider-based** - swap email providers without changing your code
- 📝 **Smart FormData parsing** - automatically converts FormData to HTML tables
- 🎯 **Grouped fields** - organize form fields with `fieldset→field` syntax
- 📎 **Attachments** - attach files directly from form inputs or file objects
- 🛡️ **Type-safe** - full TypeScript support with normalized error handling

## Quick start

Run the CLI — it picks a provider, asks for credentials, optionally sets defaults, writes your env vars, and installs `postboi` if needed:

```bash
bunx postboi init
```

Then send from anywhere — no provider import, no constructor, credentials come from env:

```typescript
import { send } from "postboi"

await send({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })
```

On SvelteKit, a form action is a one-liner ([details](#sveltekit-form-actions)):

```typescript
// +page.server.ts
import { send } from "postboi/kit"

export const actions = { default: send }
```

`init` writes `POSTBOI_PROVIDER`, the provider's credential env vars, and optional `POSTBOI_*` defaults. `send()` reads them on every call:

| Variable                                                                          | For                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `POSTBOI_PROVIDER`                                                                | which provider to use (`resend`, `mailgun`, `postmark`, …)     |
| _provider creds_                                                                  | e.g. `RESEND_API_KEY`, or `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` |
| `POSTBOI_FROM` / `POSTBOI_TO` / `POSTBOI_CC` / `POSTBOI_BCC` / `POSTBOI_REPLY_TO` | optional defaults applied to every send                        |

Bulk send by passing an array — each message is its own request:

```typescript
const results = await send([
	{ to: "a@example.com", body: "…" },
	{ to: "b@example.com", body: "…" },
])
```

For shared hooks, defaults or retries, see [Global settings](#global-settings). Prefer wiring things up yourself? See [Manual setup](#manual-setup).

> On runtimes without ambient env vars (e.g. Cloudflare Workers), construct the provider directly — [Using a provider directly](#using-a-provider-directly).

## Providers

Each provider is its own entry point, so you only bundle the one you import. Every provider exposes the same `send()` and `is_error()` methods.

| Provider       | Import               | Constructor options                  |
| -------------- | -------------------- | ------------------------------------ |
| ZeptoMail      | `postboi/zepto`      | `api_key`                            |
| Resend         | `postboi/resend`     | `api_key`                            |
| Postmark       | `postboi/postmark`   | `api_key`, `message_stream?`         |
| SendGrid       | `postboi/sendgrid`   | `api_key`, `region?`                 |
| Mailgun        | `postboi/mailgun`    | `api_key`, `domain`, `region?`       |
| Brevo          | `postboi/brevo`      | `api_key`                            |
| Cloudflare     | `postboi/cloudflare` | `api_key`, `account_id`              |
| MailerSend     | `postboi/mailersend` | `api_key`                            |
| SparkPost      | `postboi/sparkpost`  | `api_key`, `region?`                 |
| Mandrill       | `postboi/mandrill`   | `api_key`                            |
| Plunk          | `postboi/plunk`      | `api_key`                            |
| Mailtrap       | `postboi/mailtrap`   | `api_key`, `sandbox?`, `inbox_id?`   |
| MailPace       | `postboi/mailpace`   | `api_key`                            |
| Scaleway       | `postboi/scaleway`   | `secret_key`, `project_id`, `region` |
| Mock (testing) | `postboi/mock`       | _none_                               |

Want another provider? Quit being a baby and open a PR.

### Mock provider

`postboi/mock` records messages in-memory instead of sending them — same normalisation as a real provider:

```typescript
import Mock from "postboi/mock"

const mail = new Mock({ default: { from: "no-reply@example.com" } })
await mail.send({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })

expect(mail.sent).toHaveLength(1)
```

## Manual setup

Skip the CLI and wire things up yourself.

### Installation

```bash
bun add postboi      # if you're cool
pnpm add postboi     # if you used to be cool
yarn add postboi     # if you're weird
npm install postboi  # if you smell like used knickers
```

Set `POSTBOI_PROVIDER` and the provider credential env vars yourself (see [Providers](#providers)), or construct a provider instance directly.

### Using a provider directly

Useful when you want an explicit instance, or you're on a runtime without ambient env vars:

```typescript
import Resend from "postboi/resend"

const mail = new Resend({
	api_key: process.env.RESEND_API_KEY!,
	default: { from: "no-reply@example.com" },
})

await mail.send({
	to: "someone@example.com",
	subject: "hello",
	body: "<p>hello world</p>",
})
```

Every provider also accepts `default`, `timeout`, `retries`, `retry_delay`, `auto_text`, and `hooks` — see [Common constructor options](#common-constructor-options).

### SvelteKit form actions

`postboi/kit` reads FormData, sends it, and returns `{ success: true }` — or `fail(400, { error })` on failure:

```typescript
// +page.server.ts
import { send } from "postboi/kit"

export const actions = { default: send }
```

Got a configured provider instance (or no ambient env vars)? Wrap it with `action()`:

```typescript
import Resend from "postboi/resend"
import { action } from "postboi/kit"
import { RESEND_API_KEY, EMAIL_FROM_ADDRESS } from "$env/static/private"

const mail = new Resend({ api_key: RESEND_API_KEY, default: { from: EMAIL_FROM_ADDRESS } })

export const actions = {
	default: action(mail, { status: 422, fields: { to: "team@example.com" } }),
}
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
	import { enhance } from "$app/forms"
</script>

<form method="POST" use:enhance enctype="multipart/form-data">
	<input type="hidden" name="_subject" value="Contact Form" />
	<input name="contact→name" placeholder="Name" required />
	<input name="contact→email" type="email" placeholder="Email" required />
	<textarea name="details→message" placeholder="Message" />
	<input type="file" name="details→attachments" multiple />
	<button type="submit">Send</button>
</form>
```

FormData becomes a tidy HTML table in the email. See [FormData](#formdata).

## FormData

### Special fields

Extracted from the body and applied to the send options:

- `_to`, `_from`, `_subject`, `_reply_to`
- `_cc`, `_bcc` — comma-separated or array

Values can be base64-encoded; they'll be decoded automatically.

### Grouped fields

Use `fieldset→field` syntax to group related fields:

```html
<input name="contact→name" />
<input name="contact→email" />
<input name="order→product" />
<input name="order→quantity" />
```

Creates sectioned tables in the email body. Attachments work from file inputs (`details→files`) or via `attachments: File | File[]` on `send()`.

## Email address formats

```typescript
"user@example.com"
{ address: "user@example.com", name: "User Name" }
"User Name <user@example.com>"
["user1@example.com", "user2@example.com"]
```

## API reference

### Provider class

Every provider exposes the same surface:

```typescript
import Resend from "postboi/resend"

const mail = new Resend({
	api_key: string // see Providers table for credential option names
	default?: { from?, to?, cc?, bcc?, reply_to? }
})

await mail.send(options: SendOptions): Promise<SendResponse>
mail.is_error(error: unknown): error is PostboiError
```

### `SendOptions`

```typescript
interface SendOptions {
	to?: Email | Email[]
	from?: Email
	reply_to?: Email | Email[]
	cc?: Email | Email[]
	bcc?: Email | Email[]
	subject?: string // default: "Mail sent from website"
	body: string | FormData
	text?: string
	formatter?:
		| {
				fieldset?: ((label: string) => string) | null | false
				name?: ((label: string) => string) | null | false
		  }
		| null
		| false
	attachments?: File | File[]
	idempotency_key?: string
	headers?: Record<string, string>
	tags?: string[]
}
```

### Custom headers & tags

Forwarded to each provider's native concept; quietly ignored where unsupported.

- **headers** → Resend, Postmark, SendGrid, Mailgun (`h:`), Brevo, SparkPost, Mandrill, Plunk, Mailtrap, Scaleway, Cloudflare.
- **tags** → SendGrid (categories), Mailgun (`o:tag`), Brevo, MailerSend, Mandrill, MailPace, Resend (`{name,value}` pairs). Postmark and Mailtrap use the **first** tag only.

### Bulk sending

Pass an array to `send()` — bounded concurrency, never throws; you get one result per message:

```typescript
const results = await mail.send(messages, { concurrency: 10 }) // default 5

const failed = results.filter((r) => !r.ok)
for (const r of failed) console.error(r.index, r.error.message)
```

### Common constructor options

Every provider also accepts these, on top of its own credentials:

```typescript
{
	// field defaults applied when a send omits them; to/cc/bcc accept a string or array
	default?: { from?, to?, cc?, bcc?, reply_to? }
	timeout?: number // per-request timeout in ms (default 30000)
	retries?: number // retries on 429/5xx and network errors (default 0)
	retry_delay?: number // base backoff in ms, doubles each attempt (default 500)
	auto_text?: boolean // derive a plain-text body from the HTML (default false)
}
```

> **Retries are off by default on purpose.** Retrying a send that already reached the
> provider can deliver a duplicate email, so enable `retries` only alongside an
> `idempotency_key` (where the provider supports it).

### `Email` Type

```typescript
type Email =
	| string // plain address or "Name <address>"
	| { address: string; name?: string }
```

### Error Handling

Every provider throws the **same** normalized `PostboiError` on failure (HTTP errors,
provider error envelopes, timeouts and network failures), so error handling is identical
no matter which provider you use. The original provider payload is kept on `.raw`.

```typescript
try {
	await mail.send({ to: "bad@email", body: "test" })
} catch (error) {
	if (mail.is_error(error)) {
		// error is a PostboiError
		console.error(error.provider) // e.g. "resend"
		console.error(error.status) // HTTP status, when applicable
		console.error(error.code) // provider-specific code, when available
		console.error(error.message) // normalized message
		console.error(error.raw) // the original provider payload
	} else {
		console.error(error)
	}
}
```

### Hooks

Pass `hooks` to any provider to run awaitable callbacks around every send. `before.send`
can observe, rewrite or cancel a message; the rest are best-effort observers (an error
they throw is swallowed, so logging/telemetry can never break a send). In a bulk
`send(array)`, hooks run once per message.

> Setting the same hooks on every instance? Define them **once** in
> [`postboi.settings.ts`](#global-settings) and they apply everywhere — including the
> zero-config `send()`.

```typescript
const mail = new Resend({
	api_key: RESEND_API_KEY,
	default: { from: "no-reply@example.com" },
	hooks: {
		// observe, mutate, or throw to cancel — runs before the request
		before: {
			send: ({ message }) => {
				if (process.env.NODE_ENV !== "production") return { ...message, to: "qa@example.com" }
			},
		},
		// success — analytics / audit
		after: {
			send: ({ provider, message, duration_ms }) =>
				track("email.sent", { provider, to: message.to, duration_ms }),
		},
		// any failure — report it
		on: {
			error: ({ error, message }) =>
				Sentry.captureException(error, {
					tags: { provider: error.provider },
					extra: { to: message?.to },
				}),
			// each retry — observe provider flakiness
			retry: ({ provider, attempt, status }) =>
				console.warn(`${provider} retry ${attempt} (${status})`),
		},
	},
})
```

Cancel a send from `before.send` by throwing `SkipSendError` (e.g. a suppressed or
unsubscribed recipient). It's a `PostboiError` with `code: "skipped"`, and it does **not**
trigger `on.error`:

```typescript
import Resend from "postboi/resend"
import { SkipSendError } from "postboi"

const mail = new Resend({
	api_key: RESEND_API_KEY,
	hooks: {
		before: {
			send: async ({ message }) => {
				if (await isSuppressed(message.to)) throw new SkipSendError(`suppressed: ${message.to}`)
			},
		},
	},
})
```

## Global settings

Set hooks, defaults and behaviour once, applied to every send. Drop a **`postboi.settings.ts`**
at your project root (`bunx postboi init` offers to scaffold one) — the only place hooks can
live, since they're functions:

```typescript
// postboi.settings.ts
import { config } from "postboi"

export default config({
	default: { from: "no-reply@example.com" },
	retries: 2,
	hooks: {
		on: {
			error: ({ error }) => Sentry.captureException(error),
		},
	},
})
```

It auto-loads on the first `send()`. Precedence, low to high: `postboi.settings.ts` →
`POSTBOI_*` env vars → options passed explicitly.

> Edge runtimes (Cloudflare Workers, etc.) have no filesystem — register settings at startup
> instead with `configure({ ... })`.

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

## Testing

The test suite uses Vitest and mocks the ZeptoMail client:

```bash
bun run test        # run tests once
bun run test:unit   # watch mode
```

## Contributing

PRs welcome! Especially for new email providers. Make sure you:

- Follow the existing code style (snake_case, no semicolons)
- Add tests for new features
- Run `bun run check` and `bun run lint` before pushing
