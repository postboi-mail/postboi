<div align="center">
  <img src="https://raw.githubusercontent.com/darbymanning/postboi/refs/heads/main/static/logo.svg" alt="Postboi" width="250" />

**Gotta emails son? This here ya boi**

[![CI](https://github.com/darbymanning/postboi/actions/workflows/ci.yml/badge.svg)](https://github.com/darbymanning/postboi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/postboi)](https://www.npmjs.com/package/postboi)

</div>

---

Postboi is a dead simple email library that works anywhere you can run JavaScript/TypeScript, but it's optimized for SvelteKit. It's got a provider-based architecture so you can swap email providers whenever you fancy, plus some genuinely useful form handling that turns your FormData into tidy HTML emails without you having to write a single line of HTML yourself.

The core email sending functionality is framework-agnostic and works in Node.js, Bun, Deno, or edge runtimes.

### Features

- 🔌 **Provider-based** - swap email providers without changing your code
- 📝 **Smart FormData parsing** - automatically converts FormData to HTML tables
- 🎯 **Grouped fields** - organize form fields with `fieldset→field` syntax
- 📎 **Attachments** - attach files directly from form inputs or file objects
- 🛡️ **Type-safe** - full TypeScript support with proper error handling
- ⚡ **zero bullshit** - no unnecessary abstractions, just works

## Providers

One API, a whole bunch of providers. Each one is its own entry point, so you only
ever bundle the provider you actually import — nothing else comes along for the ride.

| Provider       | Import               | Constructor options                  |
| -------------- | -------------------- | ------------------------------------ |
| ZeptoMail      | `postboi/zepto`      | `token`                              |
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

Every provider takes the optional `default_from` / `default_to` too, and exposes the
same `send()` and `is_error()` methods. Swapping providers is a one-line import change.

```typescript
import Resend from "postboi/resend"

const mail = new Resend({ api_key: RESEND_API_KEY, default_from: "no-reply@example.com" })
await mail.send({ to: "someone@example.com", subject: "hello", body: "<p>hello world</p>" })
```

### Tree-shaking

Providers live behind separate entry points (`postboi/resend`, `postboi/mailgun`, …) and
each one only imports the shared core — never another provider. Import `postboi/resend`
and your bundle contains Resend and the core, full stop. None of the other providers are
reachable, so there's nothing for the bundler to even shake out.

### Testing with the mock provider

`postboi/mock` records messages in-memory instead of sending them — handy for asserting
what your app would send without hitting a real API. It runs the exact same
normalisation (defaults, FormData parsing, address parsing, attachments) as a real provider.

```typescript
import Mock from "postboi/mock"

const mail = new Mock({ default_from: "no-reply@example.com" })
await mail.send({ to: "contact@example.com", subject: "Hi", body: "<p>Hello</p>" })

expect(mail.sent).toHaveLength(1)
expect(mail.last?.to[0].address).toBe("contact@example.com")
```

Want another provider? Quit being a baby and open a PR.

## Installation

```bash
# if you're cool
bun add postboi

# or if you used to be cool
pnpm add postboi

# or if you're weird
yarn add postboi

# or if you smell like used knickers
npm install postboi
```

## Quick Start

### Basic Usage with ZeptoMail

```typescript
import Postboi from "postboi/zepto"

const mail = new Postboi({
	token: "your-zeptomail-api-token",
	default_from: "no-reply@example.com",
	default_to: "contact@example.com",
})

// simple string body
await mail.send({
	to: "someone@example.com",
	subject: "hello",
	body: "hello world",
})
```

### With SvelteKit Form Actions

```typescript
// +page.server.ts
import Postboi from "postboi/zepto"
import { ZEPTO_TOKEN, EMAIL_FROM_ADDRESS, EMAIL_TO_ADDRESS } from "$env/static/private"
import { fail } from "@sveltejs/kit"

const mail = new Postboi({
	token: ZEPTO_TOKEN,
	default_from: EMAIL_FROM_ADDRESS,
	default_to: EMAIL_TO_ADDRESS,
})

export const actions = {
	async default({ request }) {
		const form_data = await request.formData()

		try {
			await mail.send({ body: form_data })
			return { success: true }
		} catch (error) {
			if (mail.is_error(error)) {
				return fail(400, { error: error.message })
			}
			return fail(400, { error: String(error) })
		}
	},
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

That's it. The FormData automatically becomes a nice HTML table in the email.

## FormData Magic

Postboi handles FormData intelligently. Here's what it does:

### Special Fields

These fields get extracted and don't appear in the email body:

- `_to` — recipient address (overrides default)
- `_from` — sender address (overrides default)
- `_subject` — email subject
- `_reply_to` — reply-to address
- `_cc` — cc addresses (comma-separated or array)
- `_bcc` — bcc addresses (comma-separated or array)

All special field values can be base64 encoded and will be automatically decoded.

### Grouped Fields

Use `fieldset→field` syntax to group related fields:

```html
<input name="contact→name" />
<input name="contact→email" />
<input name="contact→phone" />

<input name="order→product" />
<input name="order→quantity" />
```

This creates sections with headers in the email:

```
Contact
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name:     John Doe
Email:    john@example.com
Phone:    +44 1234 567890

Order
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Product:  Widget Pro
Quantity: 2
```

### Attachments

Files are automatically detected and attached:

```html
<input type="file" name="details→files" multiple />
```

Or programmatically:

```typescript
await mail.send({
	to: "someone@example.com",
	body: "check these out",
	attachments: [file1, file2], // File objects or array
})
```

## Email Address Formats

Postboi accepts multiple email formats because flexibility is good:

```typescript
// plain string
'user@example.com'

// object with display name
{ address: 'user@example.com', name: 'User Name' }

// Display-name format (RFC 5322)
'User Name <user@example.com>'

// arrays for multiple recipients
['user1@example.com', 'user2@example.com']

// mixed formats in arrays
[
  'user1@example.com',
  { address: 'user2@example.com', name: 'User Two' },
  'User Three <user3@example.com>'
]
```

## API Reference

### `Postboi` Class (ZeptoMail Provider)

```typescript
import Postboi from 'postboi/zepto'

const mail = new Postboi({
  token: string                    // ZeptoMail API token (required)
  default_from?: string            // default sender address
  default_to?: string              // default recipient address
})

// send email
await mail.send(options: SendOptions): Promise<SendResponse>

// check if a caught value is a normalized Postboi error
mail.is_error(error: unknown): error is PostboiError
```

### `SendOptions`

```typescript
interface SendOptions {
	to?: Email | Email[] // recipient(s)
	from?: Email // sender
	reply_to?: Email | Email[] // reply-to address(es)
	cc?: Email | Email[] // cc recipient(s)
	bcc?: Email | Email[] // bcc recipient(s)
	subject?: string // email subject (default: "Mail sent from website")
	body: string | FormData // email body (HTML) or formdata to parse
	text?: string // optional plain-text alternative body
	formatter?:
		| {
				// customize label formatting
				fieldset?: ((label: string) => string) | null | false
				name?: ((label: string) => string) | null | false
		  }
		| null
		| false // set to null/false to disable formatting
	attachments?: File | File[] // file attachments
	idempotency_key?: string // forwarded to providers that support it (e.g. Resend)
	headers?: Record<string, string> // custom email headers (provider support varies)
	tags?: string[] // tags / categories for analytics (provider support varies)
}
```

### Custom headers & tags

`headers` and `tags` are forwarded to each provider's native concept, and quietly
ignored by providers that don't have one:

- **headers** → Resend, Postmark, SendGrid, Mailgun (`h:`), Brevo, SparkPost, Mandrill,
  Plunk, Mailtrap, Scaleway, Cloudflare.
- **tags** → SendGrid (categories), Mailgun (`o:tag`), Brevo, MailerSend, Mandrill,
  MailPace, Resend (`{name,value}` pairs). Postmark and Mailtrap take a single value, so
  the **first** tag is used.

```typescript
await mail.send({
	to: "contact@example.com",
	body: "<p>Hello</p>",
	headers: { "X-Campaign": "spring-2026" },
	tags: ["welcome", "vip"],
})
```

### Bulk sending

Pass `send` an **array** and it sends each message as its own request with bounded
concurrency. It never throws — you get one result per message, so a single failure
doesn't lose the rest:

```typescript
const results = await mail.send(messages, { concurrency: 10 }) // default 5

const failed = results.filter((r) => !r.ok)
for (const r of failed) console.error(r.index, r.error.message)
```

### Common constructor options

Every provider also accepts these, on top of its own credentials:

```typescript
{
	default_from?: string // sender used when `from` is omitted
	default_to?: string // recipient used when `to` is omitted
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

Pass `hooks` to any provider to run awaitable callbacks around every send. `before_send`
can observe, rewrite or cancel a message; the rest are best-effort observers (an error
they throw is swallowed, so logging/telemetry can never break a send). In a bulk
`send(array)`, hooks run once per message.

```typescript
const mail = new Resend({
	api_key: RESEND_API_KEY,
	default_from: "no-reply@example.com",
	hooks: {
		// observe, mutate, or throw to cancel — runs before the request
		before_send: ({ message }) => {
			if (process.env.NODE_ENV !== "production") return { ...message, to: "qa@example.com" }
		},
		// success — analytics / audit
		after_send: ({ provider, message, duration_ms }) =>
			track("email.sent", { provider, to: message.to, duration_ms }),
		// any failure — report it
		on_error: ({ error, message }) =>
			Sentry.captureException(error, {
				tags: { provider: error.provider },
				extra: { to: message?.to },
			}),
		// each retry — observe provider flakiness
		on_retry: ({ provider, attempt, status }) =>
			console.warn(`${provider} retry ${attempt} (${status})`),
	},
})
```

Cancel a send from `before_send` by throwing `SkipSendError` (e.g. a suppressed or
unsubscribed recipient). It's a `PostboiError` with `code: "skipped"`, and it does **not**
trigger `on_error`:

```typescript
import Resend from "postboi/resend"
import { SkipSendError } from "postboi"

const mail = new Resend({
	api_key: RESEND_API_KEY,
	hooks: {
		before_send: async ({ message }) => {
			if (await isSuppressed(message.to)) throw new SkipSendError(`suppressed: ${message.to}`)
		},
	},
})
```

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
