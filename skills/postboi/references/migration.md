# Setting up and migrating — the orderings that matter

Read from SKILL.md's account section. Both sequences below exist because a step done out of
order costs something real: a code migration blocked on DNS, a re-confirmation email to an
entire imported list, an old provider still sending into a domain the new one just verified.

## Fresh project playbook

`init --agent` (no human needed) → `whoami` → wire the code → **hand the user the claim URL** → optionally `domains add`, user clicks the setup link, `domains check` → only once **verified**, set `default.from` to the custom domain → `webhooks add` + `sync` if the app reacts to delivery events. When the human is present and wants to sign in now, plain `init` (interactive) does that instead and skips the sandbox.

Until a domain verifies, sends come from the account's shared `send.postboi.email` address. That works immediately, so **never block the code migration on DNS** — and never block wiring the code on the claim either: sandboxed sends prove the integration end to end (they're in the message log), and in dev the [dev inbox](https://docs.postboi.app/raw/dev-inbox) captures everything locally anyway.

## Migrating from Resend

One command: `bunx postboi migrate resend --dry-run` reads the Resend account behind
`RESEND_API_KEY` (or `--key re_…`) and says what would move; without the flag it registers
each domain here and prints its DNS records, turns each audience into a list with its
contacts (`?status=subscribed`, so nobody is re-confirmed, and Resend's unsubscribed stay
unsubscribed), and re-registers each webhook at the same URL with the same events in
Postboi's names and a fresh secret. Re-running skips what is already here. Templates, API
keys and the suppression list don't move (no templates API here, keys are never
exportable, Resend has no suppression export) and the command says so. Then the ordering
below from step 5: keep `provider: "resend"` until the domain verifies, flip it, done.

## Migrating from another ESP

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

   **Critical on double-opt-in lists:** pass `?status=subscribed` (or per-row `"status": "subscribed"`) for already-confirmed subscribers — those rows get **no** confirmation email. Omitting it re-confirms the entire imported base. An opt-out from the old provider is a row with `"status": "unsubscribed"`: kept on the list, never mailed, never passing through subscribed on the way.

5. Swap the sending code (see [Migrating existing email code](#migrating-existing-email-code-to-postboi)), and flip `default.from` once the domain is verified.
6. `webhooks add` + `sync`; port suppress-on-bounce logic to the normalized events.
7. Verify end-to-end: `messages` shows delivery statuses, `webhooks deliveries <id>` shows the event feed.

## Upgrading postboi

Use this when a site is pinned to an old `postboi` and you're moving it to the current one.
Before 1.0 a breaking change ships as a minor version, so a site several minors behind has
more to do than bump the version. The full record is `node_modules/postboi/CHANGELOG.md`
(or `CHANGELOG.md` at the repo root): read the `### Breaking` list of every version between
the site's and the new one.

1. Find the installed version in the lockfile, not the range in `package.json`.
2. Bump it and run the type check. Most renames below show up as type errors; the behaviour
   changes (marked **runtime**) don't, so check those by hand.
3. Run `bunx postboi doctor` to check the config, token, sending address and webhook secrets.
4. Send one real message (`bunx postboi send --to you@example.com --subject Test --text hi`)
   and submit each form once.

### From 0.0.x (`postboi/zepto`)

The 0.0.x releases were a single ZeptoMail sender. ZeptoMail still works through
`postboi/zepto`; these are the renames.

| 0.0.x                                                            | Now                                                                                                                                                       | Since        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `new Postboi({ token })` from `postboi/zepto`                    | `new Postboi({ api_key })`, or no instance: `import { mail } from "postboi"` with `provider: "zepto"` in `postboi.config.ts` and `ZEPTO_TOKEN` in the env | 0.1.0        |
| `default_from`, `default_to`                                     | `default: { from, to }` (also takes `cc`, `bcc`, `reply_to`)                                                                                              | 0.1.0        |
| `mail.is_error(e)` on ZeptoMail's `{ error: { code, message } }` | `is_error(e)` from `postboi`, true for a `PostboiError`. Instances still have `.is_error()`, but the zero-config `mail` function doesn't                  | 0.1.0        |
| `e.error.message`, `e.error.code`                                | `e.message`, `e.code` (plus `e.status`, `e.provider`); ZeptoMail's untouched body is `e.raw`                                                              | 0.1.0        |
| A hand-written SvelteKit action with `try`/`catch`               | `import { mail } from "postboi/kit"` and `export const actions = { default: mail }`, or `action({ to, status })` from `postboi/kit`                       | 0.2.0        |
| Your own `EMAIL_FROM_ADDRESS` / `EMAIL_TO_ADDRESS` env vars      | `default.from` / `default.to` in `postboi.config.ts`, or `POSTBOI_FROM` / `POSTBOI_TO` (env beats the config file)                                        | 0.1.0        |
| Custom provider overriding `send(options, defaults)`             | Implement `build_request(message)`, `parse_response(response, data)` and optionally `parse_error`; `prepare_send(options)` takes one argument             | 0.1.0        |
| No config file                                                   | `postboi.config.ts` with `config({ provider, default, options, hooks })`. It was `postboi.settings.ts` and `PostboiSettings` before 0.6.0                 | 0.1.0, 0.6.0 |
| Posted `_to`, `_from`, `_cc`, `_bcc` addressed the send          | Ignored unless the send sets `form_addressing: true`; options the send passes beat posted fields                                                          | 0.56.0       |

Behaviour a 0.0.x site will notice: HTML sends now carry a plain-text part (`auto_text: false`
to stop it, 0.12.0), requests time out after 30 seconds, form posts are spam-checked
(below), and a site with only `POSTBOI_TOKEN` set sends through the Postboi provider.

### The breaking changes that bite most

| Since  | What changed                                                                                                                                 | What to do                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 0.2.0  | Zero-config `send()` is `mail()`, in `postboi` and `postboi/kit`                                                                             | Rename the import. An instance's `.send()` is unchanged                                                                               |
| 0.6.0  | `postboi.settings.*` is `postboi.config.*`; `PostboiSettings` is `PostboiConfig`                                                             | Rename the file and type, and a named `settings` export to `config`                                                                   |
| 0.10.0 | **Runtime.** Form bodies are spam-checked: a filled honeypot throws `SpamError`, and `TURNSTILE_SECRET_KEY` makes a Turnstile token required | Add `<Captcha />` to the form, or opt out with `captcha: { honeypot: false, turnstile: false }`                                       |
| 0.11.0 | `CloudOptions` is `PostboiOptions`                                                                                                           | Rename the type                                                                                                                       |
| 0.12.0 | **Runtime.** `auto_text` defaults to `true`                                                                                                  | Nothing, or `auto_text: false` to keep HTML-only sends                                                                                |
| 0.18.0 | Postboi provider methods moved into namespaces, and the standalone `add_recipients` export is gone                                           | `add_recipients` to `mail.recipients.add`, `create_list` to `mail.lists.create`, `suppress` to `mail.suppressions.add`; see CHANGELOG |
| 0.19.0 | `RecipientStatus` lost `"bounced"` and `"complained"`                                                                                        | Read bounces and complaints from `mail.suppressions`                                                                                  |
| 0.22.0 | **Runtime.** In development with a dev inbox running, `mail()` is captured instead of sent, even with a token                                | Expected. To send for real in dev, set `POSTBOI_INBOX=off` or `dev: { inbox: false }`                                                 |
| 0.23.0 | `action()` and `remote()` in `postboi/kit` dropped the `fields` wrapper                                                                      | `action({ fields: { to } })` becomes `action({ to })`                                                                                 |
| 0.24.0 | Hook contexts carry `channel`, and global hooks run for every channel                                                                        | Check `ctx.channel === "email"` before reading `subject` and other email fields                                                       |
| 0.25.0 | The browser push client moved from `postboi/push-client` to `postboi/push`                                                                   | `subscribe_push` to `subscribe`, `push_supported()` to `subscribe.supported()`                                                        |
| 0.28.0 | The legacy honeypot field is no longer checked, and `HONEYPOT_LEGACY_FIELD` is gone                                                          | Hand-written forms use `_honey`; the bundled `<Captcha />` already does                                                               |
| 0.34.0 | **Runtime.** A config section's `options` only apply to the provider that section names                                                      | Put each provider's options under its own section, or name the provider there                                                         |
| 0.35.0 | **Runtime.** `sms()` and `whatsapp()` no longer guess a provider from credentials                                                            | Set `POSTBOI_SMS_PROVIDER` / `POSTBOI_WHATSAPP_PROVIDER`, or `provider` in the config section                                         |
| 0.39.0 | Push's `service_worker` option is `sw`                                                                                                       | Rename it, or drop it if the worker is at `/sw.js` or `/service-worker.js`                                                            |
| 0.56.0 | **Runtime.** Posted `_to`, `_cc`, `_bcc` and `_from` are ignored, and options the send passes beat body fields                               | Fix the recipient on the server (`action({ to })`, `default.to`). Only a trusted body should use `form_addressing: true`              |

0.56.0 is the one to check on any site with a public form: a form that used a hidden `_to` now
goes to `default.to`, or fails with "No recipient" if there isn't one. The console says which
field it ignored the first time it happens.
