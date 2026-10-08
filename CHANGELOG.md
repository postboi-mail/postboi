# Changelog

Changes to the `postboi` package, which is the SDK and the `postboi` CLI, newest first.
Before 1.0 a breaking change ships as a minor version, so read the Breaking list of every
minor you pass when you upgrade. To move a site across many versions at once, start with
"Upgrading postboi" in `skills/postboi/references/migration.md`, which maps the 0.0.x API
onto today's.

Versions before 0.7.0 are untagged; their sections come from the release commits.

## Unreleased

## 0.64.0

### Added

- `postboi views publish <file.html>` hosts an email as a sandboxed web page for its "View in browser" link, whichever provider sends it. It reads the email's Liquid and sorts each variable: static `--context` data (a `.json` file or a module's default export), public typed params (`--public week:integer`, or an enum inferred when the template indexes context by it, like `body[week]`; free text is refused), private fields that come through the sender's data feed, and the sender's own system variables (unsubscribe links, OneSignal's `subscription.*`), whose element it names for `data-web-hide`. It prints the link in the sender's merge syntax, URL-encoded (`--provider onesignal`, `braze`, `iterable`, `customerio`, `klaviyo`, `mailchimp`, `sendgrid` or `none`, guessed from the file when left out), and the OneSignal Data Feed, Braze Connected Content or Iterable Data Feed to set up, minting a feed key on first use. `--write` puts the link into the element marked `data-postboi-view-link` or the anchor reading "View in browser", and adds `data-web-hide` (asking first, `--yes` to skip). Re-publishing reuses the last version's choices, and a `views` section in `postboi.config.ts` (typed as `ViewConfig`) keeps them in the repo.
- `postboi views` lists them, `views open <slug> [--param k=v] [--data <json>]` opens the page as a reader sees it, `views delete <slug>`, `views keys [rotate]` and `views feed-key`.
- `views` from `postboi`: `views.publish()`, `views.url(slug, data?, { expires })` and `views.seal(slug, data)`. Reader data (a JSON object, up to 4096 bytes) is sealed with AES-GCM under `POSTBOI_VIEW_KEY` with no request (it runs in Workers too), or by Postboi when the key isn't set. `postboi sync` writes `POSTBOI_VIEW_KEY` (and `POSTBOI_VIEW_URL`) when the account has them, and refreshes them after a rotation.
- `mail({ view: { name, data } })`, with any provider, fills `{{ postboi.web_url }}` and `%postboi_web_url%` in the html and text with the reader's link to a published view. `mail({ web_version: true })` on the Postboi provider hosts the message as sent and fills the same placeholders on the server, and says so on the console when neither part has a placeholder to fill (`web_version_unused`). Every other provider refuses `web_version` with a `web_version_unsupported` error instead of sending the placeholder as text.

## 0.63.0

- **Agent mailboxes: `postboi/mailbox`.** An email address an AI agent keeps, at agentboi.email
  or on your own receiving domain. `mailbox()` opens `POSTBOI_MAILBOX_KEY`, or makes a mailbox:
  your team's with `POSTBOI_TOKEN`, or one of its own that receives at once and sends once a
  person opens its `claim_url`. `watch()` and `wait()` long-poll its mail; every message carries
  `trust` (`owner`, `thread`, `stranger` or `suspect`), `reply_text` (what they wrote, without the
  quoted thread), `thread_id`, `code` and `link`. `reply()` answers in the thread, `send()` writes
  a new message, `threads()` and `thread()` read conversations, `rotate()` makes a new key.
- **`postboi mailbox`** in the CLI: `new`, `watch`, `wait`, `read`, `reply`, `send`, `threads`,
  `key`, `ls` and `rm`, with `--trust`, `--exec`, `--json` and the inbox command's exit codes. Like
  `postboi inbox` it needs no `POSTBOI_TOKEN`.
- **`in_reply_to` on `mail()`** (Postboi provider): the `in_…` id of mail your team received. The
  server writes the In-Reply-To and References headers from it and files the send in that
  conversation. Ignored by other providers.

## 0.62.0

### Breaking

- `postboi/kit` needs SvelteKit 3 (`@sveltejs/kit` `^3.0.0`). SvelteKit 2 is no longer supported.

### Fixed

- `<Captcha />` works inside a SvelteKit 3 remote form. SvelteKit 3 scopes every remote form field name to its form and rejects any field that isn't, so the honeypot and the Turnstile token made each submission fail with `form_field_unbound`. The component now gives both the form's scope, including the token input Turnstile adds later. Field names of a `.for(key)` instance are scoped to the base form, which it follows too.

## 0.61.1

### Fixed

- `--help` (or `-h`) after any account command, such as `postboi testing run --help`, prints that command's help instead of being read as a file name or an id.

## 0.61.0

### Added

- `postboi testing run <file.html>` takes built HTML to real-client screenshots on disk in one command: it pastes into a test run, waits until every capture has settled, saves them to `screenshots/<series>/<group>/<client>.<ext>` with no timestamps (so a re-run overwrites and diffs), and prints each client as new, changed, unchanged or reused, the report's verdict, renders used and the dashboard link. `--series` defaults to the file name, `--clients`, `--set <name>` or `--all` (split past the per-run cap into one series), `--fresh`, `--out`, `--no-wait`, `--share`, `--json`, `--yes` (an order of more than ten renders asks first on a terminal, and one that exceeds what is left says how many clients will be skipped). Exits 1 on an error report or a failed capture.
- `postboi testing download <id>` collects an existing run's screenshots, waiting for pending ones. `postboi testing sets` lists saved client sets, with `sets save <name> --clients a,b` and `sets delete <name>`; `postboi testing share <id> [--revoke]` makes or takes down a read-only link. `testing add` takes `--set` and `--html <file>` (paste instead of send), and `testing clients` shows platform, OS and dark mode with the renders left.
- `hosted_test()` takes `set` and `fresh`, and the run it answers carries the server's team-scoped `url`, `series_id`, a `screenshots` summary, `renders`, `share_url` and full previews (`id`, `url`, `thumbnail_url`, client metadata, `reused`, `previous`). `wait({ screenshots: true })` waits until every capture has settled, `capture(preview)` fetches one image as a `Response` (no file system, so it runs in Workers), and `share()` makes the read-only link. `mail({ test })` takes `set` and `fresh` too. `client` and `name` stay on every preview.
- Webhooks: the Postboi provider's `testing.received` and `testing.completed` normalize to `test_received` and `test_completed`, with the run in `event.test`; `mock_request` and `mock_event` build both. `WebhookEventType` gains both members, so an exhaustive `switch` over it needs two more cases.

- `postboi migrate resend` moves a Resend account over in one command: domains registered with their DNS records printed, audiences as lists with contacts imported without re-confirmation, webhooks re-registered at the same URLs with Postboi's event names. `--dry-run` reads and writes nothing (with `--json`, the plan is the document); running it twice skips what is already here, and one refusal (a domain another account owns, a webhook URL Postboi won't take) goes on its own row while the rest still moves, exit 1 at the end.
- `mail.recipients.add()` takes `status: "unsubscribed"` (per row or for the call), so an opt-out brought over from another provider lands unsubscribed and is never mailed on the way.
- `mail.messages.get()` returns `delivered_at` and `outcomes`: the lifecycle after a send left, in the receiving server's own words (the `250` on a delivery, why SES was still trying on a `delayed` row, the `550` behind a bounce).

### Fixed

- `postboi testing delete` (and any account command the API answers with 204) no longer reports "Unexpected empty response from the API." after it worked.
- The dev inbox's "Photograph in real clients" still explains a skipped client ("Out of renders") on servers that report it as a note rather than a failed capture row.

## 0.60.0

### Added

- `mail.lists.broadcast()` sends a list a text: `channel: "sms"` with `text`, or `channel: "whatsapp"` with an approved `template`, to every subscribed contact with a `phone`, through the team's own synced provider.

## 0.59.0

### Added

- Managed push: with `POSTBOI_PUSH_PROVIDER=postboi`, Postboi keeps your Web Push subscriptions and their VAPID key, so `push()` can send to a person (`to: { user: "123" }`) or a public list (`to: { list: "new-posts" }`) and answers `{ sent, expired, failed }`. Expired browsers are cleaned up on Postboi's side. `POSTBOI_TOKEN` alone never selects it.
- `push.handler(who)` returns the `POST` and `DELETE` route handlers that file a browser under the signed-in user, for any framework whose handlers carry a `Request` (SvelteKit, Next, Astro, Remix, Hono, Workers).
- `push.subscriptions.add`, `.remove`, `.list` and `.import`, the rows managed push holds, for Express and for moving an existing table across.
- `subscription({ list })` from `postboi/push` follows a public list straight from the page, with no route of your own.
- `receive()` from `postboi/push/sw` needs no options with managed push: a rotated subscription is re-filed with Postboi, which moves the old one's person and lists onto it.
- `postboi/push/postboi` exports the managed push provider class, `PostboiPush`.
- `bunx postboi init --push` offers managed push on a Postboi account: it switches it on (bringing the VAPID pair already in your env, so existing subscribers keep working), writes `POSTBOI_PUSH_PROVIDER=postboi`, and writes the route for SvelteKit, Next or Astro.
- `bunx postboi vapid --export` prints the pair managed push holds, private key included, so leaving keeps your subscribers.
- `bunx postboi sync` bakes managed push into the package when `POSTBOI_PUSH_PROVIDER=postboi`, along with the account's own VAPID public key.

### Changed

- `PushTarget` also takes `{ user }` and `{ list }`. Every provider but `postboi` and the mock refuses one with `invalid_target`. A custom push provider that reads `message.to` as a subscription or a string now has a third case to narrow away.
- The page and the service worker remember the endpoint they last filed (in IndexedDB), so a rotation on a browser that doesn't say which subscription it replaced still sends `old_endpoint`. The worker `init --push` writes does the same.
- `push.expired(error)` is false for an error from the Postboi provider: its 404 is the API answering (no such list), never a push service saying a device is gone.

## 0.58.1

### Added

- `field.all(name)` in a resolver: every non-blank value of a field posted more than once, or `[]`.

### Fixed

- A reply-to that isn't an address (a visitor's typo, say) is dropped with a one-time warning instead of failing the whole send at the provider.

## 0.58.0

### Added

- A resolver gets `field(name)`: one text field, trimmed, or `undefined` when missing or blank, so a missing field no longer becomes the string "null" (#108).

### Changed

- `remote()` renders a `true` checkbox as "Yes" and leaves `false` out of the email and the stored fields, instead of "true" / "false" (#108).

### Fixed

- A server-built HTML send that names a `form` is no longer captcha-gated by the API: it now carries `captcha_local`, since no widget token could come with it (#107).
- The development console fallback with no provider configured no longer demands a `from`; it uses a placeholder, as the dev inbox does (#107).
- `attachments: []` is treated as no attachments (#107).
- `postboi doctor` flags a `<Captcha />` import when no captcha key exists anywhere, and sees a BetterAuth `signIn.magicLink(…)` call split across lines (#109).
- A special form field whose plain value happens to be valid base64 (`_subject=Help`, `_form=Jobs`) is no longer decoded into garbage. A value is decoded only when it comes out as readable text (#110).

## 0.57.0

### Breaking

- A posted `_form` now only picks a form the account already has; it goes out as `form_posted` and never creates one. Create the form first, or pass `form_addressing: true` when your own code builds the body (#98).
- Every FormData or form-fields send is now flagged `form: true`, with or without a captcha, so managed captcha gates it. A send whose captcha was settled locally (its own Turnstile secret, or `captcha: { turnstile: false }`) also carries `captcha_local` (#98).

### Added

- `form: true`, to file a send as a form submission without naming one and ignore any posted `_form` (#98).
- `action()` and `remote()` take a resolver, `({ event, data }) => options | fail(…)`, in place of the options object. A `_` field it reads never reaches the email (#104).
- `remote(schema, …)` takes a Standard Schema and keeps `_honey`/`_captcha` through SvelteKit's validation; a resolver's `after()` result is merged into the form's result (#105).
- `parse_form`, `decode_special`, `SPECIAL_FIELDS`, `FORM_ADDRESSING`, `HONEYPOT_FIELDS` and `CAPTCHA_FIELDS` from the package root (#106).
- A one-time warning when a form arrives with no captcha token although a captcha key is baked in (#105).

### Fixed

- The dev inbox no longer demands a `from` when the Postboi provider is configured (#99).
- A plain `mail()` in a SvelteKit action or remote function fills in the visitor's IP for Turnstile, via `postboi/kit` or the `postboi()` Vite plugin (#103).
- `postboi/kit` imports under `bun test` and plain Node without mocking `$app/server`; only `remote()` needs SvelteKit (#103).
- A blank string for `to`, `cc`, `bcc`, `from`, `reply_to`, `subject` or `form` counts as unset and falls through to the post or `default.*` (#104).

## 0.56.0

### Breaking

- A FormData or form-fields body's `_to`, `_cc`, `_bcc` and `_from` are now ignored (with a one-time `console.warn`); pass `form_addressing: true` on the send if your own code builds the body and relies on them (#96).
- Options passed to the send now beat fields in the body, so a posted `_subject`, `_reply_to` or `_form` no longer overrides a `subject`, `reply_to` or `form` the server passed; an option passed as `undefined` still falls through to the body (#96).

### Added

- `form_addressing` send option, to let a trusted body's `_to`, `_cc`, `_bcc` and `_from` address the send (#96).

### Fixed

- `action({ to })` and any send that fixes its recipient can no longer be redirected by a visitor adding `_to` (or `_cc`, `_bcc`, `_from`) to a public form (#96).

## 0.55.0

### Added

- A hidden `_form` field in a FormData body sets the send's `form`, so one form route can file each submission under its own Postboi form (#95).

## 0.54.3

### Fixed

- Error messages, warnings and CLI output no longer use em dashes; the wording is otherwise unchanged, so code that matches on message text may need updating (#91).

## 0.54.2

No SDK changes.

## 0.54.1

### Fixed

- `temp()` and `temp.attach()` read `POSTBOI_TOKEN`, `POSTBOI_INBOX`, `POSTBOI_INBOX_TOKEN` and `POSTBOI_INBOX_URL` the same way `mail()` does, from `.env`, `.dev.vars` and Worker bindings as well as `process.env` (#88).

## 0.54.0

### Added

- `postboi/inbox`: `temp()` makes a throwaway inbox with `wait`, `watch`, `list`, `read`, `extend` and `delete`, plus `temp.attach()`, `InboxError` and `InboxTimeoutError` (#87).
- `postboi inbox` CLI (`new`, `watch`, `wait`, `read`, `open`, `ls`, `rm`, `extend`), which needs no `POSTBOI_TOKEN`; `wait --code` prints just the code, and `watch` takes `--json`, `--forward <url>` and `--exec <cmd>` (#87).
- `npx tempboi`, a separate package that runs `postboi inbox` under a short name and is published at the same version (#87).

### Fixed

- `form` accepts any string again, since the API creates a form on first use; names from `postboi sync` are kept as editor suggestions rather than a closed list (#86).

## 0.53.1

No SDK changes.

## 0.53.0

### Added

- `footnote` send option on the Postboi provider: a line of small print under the message for one send (#84).

## 0.52.1

No SDK changes.

## 0.52.0

### Added

- `letterhead`, `shell` and `style` can be set once in `default` in `postboi.config.ts`; a send that names one still wins (#82).
- `POSTBOI_LETTERHEAD`, `POSTBOI_SHELL` and `POSTBOI_STYLE` environment variables, which win over the config file; a value that is neither yes nor no is warned about and ignored (#82).
- `postboi doctor` warns when a Convex project has a `postboi.config` file that nothing imports, since that runtime never reads it (#82).

### Fixed

- The Postboi provider re-reads environment defaults on each send, so the first send in a Worker isolate no longer ignores `POSTBOI_FROM` and the new look variables (#82).
- "No sender address provided" now carries the same missing-config hint as "No recipient address provided" (#82).

## 0.51.0

### Added

- `letterhead`, `shell`, `style` and `preheader` send options on the Postboi provider, for the team letterhead, the designed email shell, the styled or plain cut, and the inbox preview line (#81).
- `LetterheadOption`, `ShellOption`, `StyleOption`, `PreheaderOption` and `EmailStyle` types; each is `never` when the generated types name another provider (#81).

## 0.50.0

### Breaking

- `postboi init` without `--agent` and without a terminal now exits 2 before its first prompt instead of ending on "Cancelled"; scripts that piped answers into it should use `postboi init --agent` (#79).

### Added

- `--json` on every account command prints the API's response and nothing else on stdout; failures print `{ "error": { "message", "code" } }` on stderr (#72).
- CLI failures carry a code: the API's own, `http_<status>` when the body had none, or `no_token` and `unreachable` for local failures (#72).
- `postboi send`, `postboi messages <id>` and `postboi messages cancel <id>` (#73).
- `postboi doctor` checks the config, token, account, sending address, webhook secrets and agent skill, names a fix for each, and exits 1 on a failure (#74).
- `postboi forms`, `notifications`, `lists send`, `testing`, `domains inbound` and `webhooks rotate` (#75).
- `postboi exports` (`add`, `run`, `pause`, `resume`, `delete`, `download`) and `mail.exports.download()`, which returns `{ filename, type, bytes, text() }` (#79).
- `list` is accepted as the bare listing on every noun that lists (#79).
- `postboi skill` and `init` also install the skill to `.agents/skills`, install its `references/`, and add a short pointer to an existing `AGENTS.md` (never creating one) (#76).

## 0.49.1

### Added

- `form` send option: files a submission under a Postboi form by name or `form_…` id, and FormData sends carry their fields as data (#71).
- `postboi sync` writes form names into the generated types, and `form` is a type error when the project sends through another provider (#71).
- `mail.forms.all()` and `mail.exports` (`all`, `get`, `create`, `update`, `run`, `delete`) for scheduled exports (#71).
- Postboi provider webhook events and `messages.get` include `form: { id, name }` and `fields` for form submissions (#71).

## 0.49.0

### Added

- Six email providers: Netcore (`postboi/netcore`), Klaviyo (`postboi/klaviyo`), HubSpot (`postboi/hubspot`), OneSignal (`postboi/onesignal`), Alibaba Cloud Direct Mail (`postboi/alibaba`) and Yandex Cloud Postbox (`postboi/yandex`) (#68).
- `receive()` adapter for The SMS Works delivery reports and replies, with a texted STOP read as `unsubscribed`, verified by `SMSWORKS_WEBHOOK_SECRET` (#62).
- `ReceiveOptions.provider` accepts SMS provider keys, and zero-config `receive()` falls back to `POSTBOI_SMS_PROVIDER` when it pushes webhooks (#62).

## 0.48.0

### Added

- PureSMS provider (`postboi/puresms`) with single, bulk and scheduled sends and cancel (#66).

### Fixed

- `sms()` with an empty recipient list (`[]` or `", "`) throws `no_recipient` instead of sending a request with nobody on it (#66).

## 0.47.0

### Added

- `postboi/push/expo`: `subscribe()`, `unsubscribe()`, `subscription()` and a `usePush` hook for Expo and React Native apps (#63).
- Expo push provider (`postboi/expo`), with `receipts(ids)`, selected by `POSTBOI_PUSH_PROVIDER=expo` (#63).

## 0.46.0

### Added

- Sixteen email providers: Loops, MailChannels, SMTP2GO, SocketLabs, Azure Communication Services, Gmail, Maileroo, AhaSend, Postal, Customer.io, Infobip, SendPulse, Iterable, JetEmail, Lettr and Primitive (#64).
- `receive()` adapters for Loops, AhaSend, Customer.io, SocketLabs, SMTP2GO, Postal, Infobip, SendPulse and Azure, including the SocketLabs and Event Grid validation handshakes (#64).
- `receive()` adapter for Meta's WhatsApp Cloud API (`meta`), verified with `X-Hub-Signature-256`; inbound opt-outs arrive as `unsubscribed` and other replies as `received` (#65).
- `handshake()` export, and `webhook()` answers Meta's GET verification challenge using `META_WEBHOOK_VERIFY_TOKEN` (#65).
- Zero-config `receive()` falls back to `POSTBOI_WHATSAPP_PROVIDER` when no email provider is configured (#65).

### Fixed

- `mail()` can load Mailjet and Elastic Email, which were registered but missing from its loaders (#64).
- Attachments with no known type are sent as `application/octet-stream` for every provider (#64).
- SMTP messages escape quotes in attachment filenames, encode non-ASCII filenames per RFC 2231, and fold long non-ASCII subjects within the line limit (#64).
- A Svix-style webhook secret that isn't base64 is reported as a misconfiguration (`missing_secret`) instead of a bad signature (#64).

## 0.45.0

### Breaking

- `Suppression` is now a union narrowed on `channel`: email rows carry `email`, SMS and WhatsApp rows carry `phone`, so check `row.channel === "email"` before reading `row.email` (#61).

### Added

- Sequenzy provider (`postboi/sequenzy`), with a `receive()` adapter (#60).
- `is_opt_out()` and `OPT_OUT_KEYWORDS` exports, for recognising a texted STOP (#61).
- Twilio `poll()` reports an inbound opt-out keyword as an `unsubscribed` event with `channel` and `phone` (#61).
- Contacts carry a `phone`, and `contacts.update` takes `phone: null` to clear it (#61).
- `suppressions.all({ channel })`, and `suppressions.add` and `remove` take `{ phone, channel? }` as well as an email; exported `SuppressionChannel` and `SuppressionTarget` (#61).
- CLI: `postboi suppressions add|remove` take a phone number with `--channel`, and `postboi contacts add` takes `--phone` (#61).

## 0.44.0

### Added

- Lettermint (`postboi/lettermint`) and Unosend (`postboi/unosend`) providers, each with a `receive()` adapter (#59).

## 0.43.0

### Added

- `BatchRecipient.index`, the recipient's position in the original `to` array (#58).

### Fixed

- Postboi provider batch sends carry an idempotency key per recipient (`<key>:<index>`), so a retried batch no longer sends every message twice; a key too long to take the suffix is refused before sending (#58).

## 0.42.0

### Added

- Twilio `poll()` adapter for SMS and WhatsApp delivery receipts (#57).
- `WebhookEvent` gains `channel` and `phone`; text-message events put the number in `phone` and leave `email` unset (#57).
- The Postboi provider's webhook adapter handles `sms.*` and `whatsapp.*` events (#57).
- `mock_request` and `mock_poll` take a `channel` option (#57).

## 0.41.0

### Added

- `postboi/inspect`: `analyze()` checks email HTML offline (Gmail clipping, plain-text part, unsubscribe headers, alt text, `lang`, dead links, image sizes, subject, message size) against a client support matrix built from Can I email data, and `check_links()` fetches the links it found (#53).
- `postboi inspect <file.html>` runs the same analysis in CI, one finding per line, exiting 1 on warnings or errors; `--links`, `--json` and `-` for stdin (#53).
- `mail({ test: "name" })` sends the email to a hosted test run instead of a person and returns the finished report; `to`, `cc` and `bcc` are a type error on a test send and `clients` picks screenshot clients (#53).
- `hosted_test()` from `postboi/inspect` drives hosted testing runs from code, and `HostedTest` is exported as a type from the root (#53).
- The dev inbox gets a Report tab with the analysis for each captured message, plus real-client screenshots when `POSTBOI_TOKEN` is set (#53).

## 0.40.0

### Added

- `poll()` in `postboi/webhooks` fetches delivery events for providers that don't send webhooks: Microsoft 365 (message trace), Cloudflare Email Service (queue pull) and SMTP (POP3 bounce mailbox) (#52).
- `parse_dsn()`, `mock_poll()`, `POLL_MODULES` and `POLL_FIELDS` in `postboi/webhooks` (#52).
- The Microsoft 365 provider sets the Message-ID itself and returns it from `send()` as `message_id`, so polled events match their sends; it retries once without it if the tenant rejects the property (#52).
- A `postboi/registry` export, and a `send_via` option on the Postboi provider for relaying a send through another provider's credentials synced to the account (#52).
- `postboi sync` moves the new `POP3_*` and `CLOUDFLARE_QUEUE_ID` credentials (#52).

### Fixed

- `receive()` for SMTP, Microsoft 365 or Cloudflare now tells you to use `poll()` instead of only saying webhooks aren't supported (#52).

## 0.39.0

### Breaking

- The service worker path option is now `sw`, not `service_worker`, on `subscribe()`, `subscription()`, `usePush` and `use_push`; rename it, or drop it if your worker is at `/sw.js` or `/service-worker.js` (#48).

### Added

- `subscribe()` reuses a registered service worker, otherwise tries `/sw.js` then `/service-worker.js`, so SvelteKit's built worker is found with no option; the tried paths are exported as `WORKER_PATHS` (#48).
- `postboi init --push` follows `kit.files.serviceWorker` to a custom worker source, and leaves the path out of its page snippet when the worker is at a conventional URL (#48).

## 0.38.0

### Added

- `postboi init --agent` sets up without any prompts or sign-in: it provisions a claimable Postboi project, writes the token to `.env`, and ends by printing the claim URL for a human to open (#47).
- Interactive `postboi init` offers to add a custom sending domain, prefilled from what the project already says about its own domain (#47).
- `postboi whoami` shows whether a project is unclaimed or sandboxed, with the claim link (#47).
- The Postboi provider logs one line per instance when a send comes back sandboxed, with the claim URL, and its send response carries `sandbox` and `claim_url` (#47).

## 0.37.1

### Fixed

- Bundlers targeting non-Node platforms (Convex, Workers) no longer fail with "Could not resolve node:https" when the dev inbox lookup is bundled (#46).

## 0.37.0

### Added

- `receive()` from `postboi/push/sw` accepts `key` as a function, called only when a subscription rotation needs the VAPID public key (#45).
- `receive()` takes a `click` option that replaces the default notification click handling, called with the notification's data and the action pressed (#45).

## 0.36.0

### Added

- `receive()` from `postboi/push/sw` registers the `push`, `notificationclick` and `pushsubscriptionchange` handlers, so a rotated subscription is re-filed with your server (sent with `old_endpoint`) before a notification is lost (#41).
- `postboi init --push` writes or finds your service worker: SvelteKit gets the `postboi/push/sw` import, other frameworks get a `public/sw.js` with the handlers written out (#41).
- `PushPayload` type (exported from the root) for the JSON a Web Push worker receives, and `subscription_json()` from `postboi/push` (#41).

## 0.35.0

### Breaking

- `sms()` and `whatsapp()` no longer pick a provider from credentials alone; set `POSTBOI_SMS_PROVIDER` / `POSTBOI_WHATSAPP_PROVIDER` or `provider` in the config section (`postboi init --sms` / `--whatsapp` already write it) (#40).

### Fixed

- `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` set for Twilio Voice or Verify no longer make `sms()` send a billable text through Twilio (#40).

## 0.34.0

### Breaking

- `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL` and `TELEGRAM_BOT_TOKEN` no longer select the chat provider on their own for `send()`; set `POSTBOI_CHAT_PROVIDER` or `chat.provider` (the `slack()`, `discord()` and other platform functions are unaffected) (#39).
- `options` in `postboi.config.ts` now only apply to the provider that section names (or to any provider when it names none), so options written for one provider are no longer used by another picked through `POSTBOI_PROVIDER`, a platform function or inference (#39).

### Fixed

- A config file naming one provider no longer hands its `api_key` or `webhook_url` to a different provider chosen elsewhere, which had sent a Mailgun key to Resend and a Slack webhook URL to Discord; the missing-credential error now says whose options were skipped (#39).

## 0.33.1

### Fixed

- `sms()` no longer picks Amazon SNS just because `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set for something else; well-known third-party credentials (AWS, SMTP, Cloudflare) never select a provider on their own (#36).

## 0.33.0

### Added

- `sms()`, `whatsapp()`, `push()` and chat use the one provider whose credentials are fully set when no provider is named, so a VAPID key trio no longer needs `POSTBOI_PUSH_PROVIDER=webpush` (#34).

## 0.32.0

### Added

- `generate_vapid_keys()` is exported from `postboi/webpush` (#33).
- `postboi vapid` prints a new VAPID key pair to stdout, for storing in a secret manager instead of `.env` (#33).
- `postboi skill` installs the agent skill into an existing project (#33).

## 0.31.0

### Breaking

- `push_controller` in `postboi/push` is renamed `subscription`, and its types `PushController` and `PushControllerOptions` are now `PushSubscriptionStore` and `SubscriptionOptions` (#30).
- The `svelte` peer dependency is now `^5.7.0` (#30).

### Added

- `postboi/svelte` exports a runes-based `subscription()` for the push toggle, whose `on`, `busy`, `supported` and `reason` are plain reactive properties; `import Captcha from "postboi/svelte"` still works (#30).
- `toggle()` on `subscription()`, `usePush` and `use_push` subscribes or unsubscribes depending on the current state, and the store gains `supported`, `on`, `busy` and `reason` getters (#30).

### Fixed

- A failed unsubscribe no longer leaves the push toggle stuck on `busy`, and a failed rollback no longer hides the `register_failed` reason (#30).
- A click on `toggle()` that arrives before the first state read no longer registers a second subscription (#30).
- The `<Captcha>` components no longer pull server-side `node:fs` code into the browser bundle (#30).

## 0.30.0

### Breaking

- `usePush` in `postboi/vue` is renamed `use_push` (`postboi/react` keeps `usePush`) (#29).

### Added

- `postboi sync` and `postboi init --push` bake `VAPID_PUBLIC_KEY` into the package, so `key` is optional on `subscribe()`, `push_controller` and `usePush`; with no key at all `subscribe()` throws `missing_key` (#29).

## 0.29.0

### Added

- `webhook()` in `postboi/webhooks` turns a handler into a complete webhook endpoint for any framework that hands you a `Request` or an object with `.request` (#25).
- `webhook.node()` is Express and Node `(req, res)` middleware that reads the raw body itself, so a body parser can't break signature checks (#28).
- `push_controller` in `postboi/push`, with `usePush` in `postboi/react` and `postboi/vue`, handles a push on/off toggle and removes the browser subscription if registering it with your server fails (#27).

## 0.28.0

### Breaking

- `HONEYPOT_LEGACY_FIELD` is removed and the `🍯` honeypot field is no longer checked; forms must use `_honey` (`HONEYPOT_FIELD`), which every bundled `<Captcha>` renders (#23).
- The Web Push provider throws `invalid_subject` at construction when the VAPID `subject` is not a `mailto:` URI, an `https:` URL or a bare email address; change an `http:` subject to `https:` or `mailto:` (#21).

### Added

- `subscribe.current()` returns this browser's existing push subscription, or `null`, without prompting (#22).

### Fixed

- A bare email address as the VAPID subject is turned into a `mailto:` URI instead of getting a 401 from the push service (#21).
- `Captcha.astro` renders the `_honey` field like the other components (#23).
- The Postboi provider's default API base, the captcha loader and the CLI now use `postboi.app` directly instead of going through a redirect (#19).

## 0.27.1

### Added

- Dev inbox: POOM.EXE shows the rest of the Postboi mark's faces in its status bar, and typing `iddqd` toggles god mode (#16).

### Fixed

- Dev inbox: POOM.EXE's shotgun rests on its idle frame, and the status bar hint clips instead of wrapping in a narrow window (#16).

## 0.27.0

### Added

- `postboi dev --demo` seeds every channel (texts, WhatsApp, chat, push) plus a scheduled and a cancelled send, not just mail.
- Dev inbox: each capture shows the platform it went out on ("Slack", not "Chat") in its own column, the phone handset scrolls and has Snake, and there is a POOM.EXE game on the desktop.

## 0.26.0

### Added

- APNs push provider at `postboi/apns`, which sends straight to Apple with a `.p8` key over HTTP/2 and no Firebase (#13).
- Huawei Push Kit provider at `postboi/hms`, for Huawei phones that FCM cannot reach (#13).
- `push.expired()` now recognises dead device tokens from APNs and Huawei, which are normalised to the `expired_subscription` code (#13).
- `postboi init --push` finds an `AuthKey_<KEYID>.p8` in `~/Downloads` or the project, fills `APNS_KEY_ID` from its name, and checks the APNs credentials before saving them (#13).

## 0.25.0

### Breaking

- The browser push client moved from `postboi/push-client` (and the push re-exports in `postboi/react` and `postboi/vue`) to `postboi/push`; rename `subscribe_push()` to `subscribe()`, `unsubscribe_push()` to `unsubscribe()`, `push_supported()` to `subscribe.supported()`, `push_permission()` to `subscribe.permission()`, and read `error.reason` with `subscribe.reason(error)` (#15).

### Added

- `bluesky()` posts to your own Bluesky feed on the chat channel, with `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD` (#12).
- `postboi sync` reads your approved WhatsApp templates from Meta or Twilio, so `template` autocompletes and `variables` is typed and required when the template has placeholders (#14).
- `whatsapp()` takes `header` and `buttons` for placeholders in a template's header and button URLs (#14).
- Twilio WhatsApp sends accept a template name as well as a `ContentSid`, using the name map `postboi sync` writes (#14).
- `WHATSAPP_BUSINESS_ACCOUNT_ID` (optional) lets `postboi sync` list Meta templates (#14).

### Fixed

- The Meta WhatsApp provider dropped placeholders in a template's header or buttons, so Meta rejected the send (#14).

## 0.24.0

### Breaking

- Hook contexts now carry `channel`, and `ctx.message` is a union across every channel; narrow with `if (ctx.channel === "email")` before reading email fields like `subject` in `before.send`, `after.send` and `on.error`, since global config hooks now run for SMS, WhatsApp, push and chat sends too (#11).

### Added

- `sms()` sends texts through The SMS Works (`postboi/smsworks`), Twilio (`postboi/twilio`) or Amazon SNS (`postboi/sns`), with E.164 normalisation and segment counting (#11).
- `whatsapp()` sends through Twilio (`postboi/whatsapp-twilio`) or Meta's Cloud API (`postboi/whatsapp-meta`), and `whatsapp.closed(error)` spots a send outside the 24 hour window (#11).
- `push()` sends through Web Push (`postboi/webpush`) or FCM (`postboi/fcm`), with `subscribe_push()` from `postboi/push-client` in the browser and `push.expired(error)` for token cleanup (#11).
- `slack()`, `discord()`, `teams()` and `telegram()` post to chat, each with its own import (`postboi/slack` and so on) (#11).
- `send()` fans a message out to several channels, or walks a fallback chain with `channels: "cheapest"` and stops at the first success (#11).
- `postboi.config` takes `sms`, `chat`, `whatsapp` and `push` sections, and mock providers ship for each channel (`postboi/sms-mock`, `postboi/chat-mock`, `postboi/push-mock`, `postboi/whatsapp-mock`) (#11).
- `Transport` is exported as the channel-agnostic provider base, with `SmsProvider`, `ChatProvider`, `PushProvider` and `WhatsappProvider`; `ProviderBase` stays as an alias of `EmailProvider` (#11).
- In development, texts and WhatsApp messages are captured by the dev inbox or logged instead of sent, and every channel shows up in the dev inbox (#11).
- `postboi init` pulls the team's synced credentials from your Postboi account before prompting, and `postboi init --chat` connects Slack or Discord in the browser and writes the webhook to `.env` (#11).
- Webhooks: a `received` event for replies to the Postboi provider's sending address, with the sender in `email`, the answered send in `message_id` and the reply in `body` (#9).
- `mock_event("received")` and `mock_request({ type: "received" })` for testing inbound handlers (#9).

## 0.23.0

### Breaking

- `action()` and `remote()` in `postboi/kit` no longer take a `fields` object; move its contents up a level, so `action({ fields: { to: "team@example.com" } })` becomes `action({ to: "team@example.com" })` (`status` stays alongside), and use `ActionFields` where you typed `Omit<ActionOptions, "status">`.

## 0.22.0

### Breaking

- With `NODE_ENV=development` and a dev inbox running (the `postboi/vite` plugin or `postboi dev`), `mail()` and `cancel()` capture mail in the inbox instead of sending it, even with a token set; set `dev: { inbox: false }` in `postboi.config`, `POSTBOI_INBOX=off`, or `postboi({ inbox: false })` to send for real (#8).

### Added

- A local dev inbox at `/__postboi`, served by the `postboi/vite` plugin on the dev server's own port, or standalone with `postboi dev` for Express, Hono, Next.js and `wrangler dev` (#8).
- `postboi dev --demo` seeds sample mail, and `--no-sound` / `--no-intro` (or `postboi({ inbox: { sounds: false, intro: false } })`) set the inbox's starting state (#8).
- `POSTBOI_INBOX` names the inbox port by hand, or switches it off (#8).
- The mock provider captures `scheduled_at` and takes `sink` and `on_cancel` options (#8).

## 0.21.0

### Breaking

- With `NODE_ENV=development` and no provider or `POSTBOI_TOKEN`, `mail()` now prints the message to the console and resolves instead of throwing `no_provider`; outside development it still throws.

### Added

- The mock provider takes `log: true` to print each captured message, and `mail()` turns it on whenever it resolves the mock itself, including `provider: "mock"`.

## 0.20.9

### Fixed

- `postboi init` adds `postboi()` to a Vite `plugins` array without a comment and in the array's existing layout, instead of mangling a one-line array.

## 0.20.8

### Added

- `postboi sync` warns when `postboi.config` sets anything needed at send time but `vite.config` is missing the `postboi()` plugin.

## 0.20.7

### Added

- `postboi init` adds the `postboi()` plugin from `postboi/vite` to Vite projects, falling back to the `optimizeDeps` exclude when it can't place the plugin safely.

### Fixed

- The "No recipient address provided" error now says when no `postboi.config` was loaded and how to get it into a deployed build.

## 0.20.6

### Fixed

- The mock provider no longer fails with `captcha_misconfigured` when a form with `<Captcha />` sends a Turnstile token and no secret is set.

## 0.20.5

### Added

- `CaptchaOptions` takes `remoteip`, sent to Turnstile's siteverify, and `postboi/kit`'s `action()` and `remote()` fill it from the request.

### Fixed

- A partial captcha override such as `{ turnstile: {} }` discarded a configured secret and skipped Turnstile; overrides now merge field by field.

## 0.20.4

### Fixed

- `html_to_text` ends a line at each table cell, so the plain-text part of a FormData email no longer runs labels and values together.

## 0.20.3

### Added

- `escape_lines` is exported for hand-built HTML bodies whose values may contain newlines.

### Fixed

- Line breaks in submitted FormData values render as `<br>` instead of collapsing onto one line.

## 0.20.2

### Added

- `escape_html` is exported from the package root.

### Fixed

- The FormData email table escapes submitted field names and values, so a contact form can no longer inject live HTML into the email.

## 0.20.1

### Fixed

- Sends no longer fail with "Unsupported scheme (cloudflare)" on isolate runtimes such as Convex; the `cloudflare:workers` import only runs on Workers.

## 0.20.0

### Added

- `postboi/postboi` subpath export for the Postboi provider, matching every other provider.

### Fixed

- The zero-config `mail()` bundles on non-Node platforms; SES and SMTP load Node built-ins lazily and throw `node_required` at send time where they can't run.

## 0.19.0

### Breaking

- `RecipientStatus` is now `"subscribed" | "pending" | "unsubscribed"`; `"bounced"` and `"complained"` are gone, and a bounce or complaint shows up in `mail.suppressions` instead, so drop those cases from any status checks.
- Recipients are backed by contacts: a recipient's `name` and `data` belong to the contact and are shared across every list it's on (last write wins), no longer stored per list.

### Added

- `mail.contacts` with `add`, `get`, `update`, `remove`, `all` (with a `search` option) and `lists`, plus the `Contact`, `ContactDetails`, `ContactInput`, `Membership` and `MembershipStatus` types.
- `mail.recipients.all(list)` returns every recipient on a list with their status.
- CLI: `postboi contacts` lists, adds, shows and removes contacts.

## 0.18.0

### Breaking

- The Postboi provider's methods moved into namespaces on the instance and on `mail`: `add_recipients` to `recipients.add`, `set_recipient_status` to `recipients.set_status`, `remove_recipient` to `recipients.remove`, `lists()` to `lists.all`, `list` to `lists.get`, `create_list` / `update_list` / `rename_list` / `delete_list` to `lists.create` / `lists.update` / `lists.rename` / `lists.delete`, `broadcast` to `lists.broadcast`, `notifications` / `create_notification` / `update_notification` / `delete_notification` to `notifications.all` / `create` / `update` / `delete`, `suppressions` / `suppress` / `unsuppress` to `suppressions.all` / `add` / `remove`, and `message` / `reschedule` to `messages.get` / `messages.reschedule`.
- The standalone `add_recipients` export is gone from `postboi` and `postboi/kit`; use `mail.recipients.add(list, recipients)` with `mail` imported from `postboi`.

### Added

- The zero-config `mail` carries the Postboi namespaces too (`mail.recipients`, `mail.lists`, `mail.notifications`, `mail.suppressions`, `mail.messages`), so nothing needs constructing to manage lists.
- Cloudflare `.dev.vars` and `.dev.vars.local` are read in dev, so a Worker's `POSTBOI_TOKEN` is found under `vite dev`.
- CLI: `postboi send-address` shows the account's default send address, or sets it when given one.

## 0.17.0

### Added

- On Cloudflare Workers, `mail()` and every provider read `POSTBOI_TOKEN`, `TURNSTILE_SECRET_KEY` and the other settings from bindings, with nothing passed in.
- `postboi/vite` plugin that bundles `postboi.config` into the server build and carries the `postboi/remote` `optimizeDeps` exclude.

## 0.16.0

### Added

- CLI resource commands over the REST API: `whoami`, `lists`, `recipients`, `domains`, `webhooks`, `members`, `messages` and `suppressions`, with `domains add` printing the DNS records and a Domain Connect link.
- The installed agent skill is a symlink into `node_modules/postboi`, so upgrading the package updates it (falls back to a copy where symlinks don't work).

## 0.15.0

### Added

- `postboi/remote`, a zero-config SvelteKit remote-function mail form to spread onto `<form {...mail}>`, and `remote()` in `postboi/kit` to build your own.
- The default honeypot field is now `_honey`, which remote forms accept; the old `🍯` name is still checked, and is exported as `HONEYPOT_LEGACY_FIELD`.
- The Turnstile token is also read from `_captcha` (`TURNSTILE_REMOTE_FIELD`), for remote forms.
- `postboi init` excludes `postboi/remote` from Vite prebundling in SvelteKit projects.

## 0.14.4

### Added

- `add_recipients` takes an optional `{ status }` (`"subscribed"` or `"pending"`) on the Postboi provider.
- `set_recipient_status(list, email, status)` changes a list recipient's status without removing them, for example to unsubscribe someone.
- `list()` recipient rows carry a `status`, typed as `RecipientStatus`, which is exported from the package root.

## 0.14.3

### Added

- Every Postboi provider list method (`list`, `rename_list`, `delete_list`, `add_recipients`, `remove_recipient`, `broadcast`) accepts a list name or a list id.
- `update_list(list, { name, confirmation })` and `create_list(name, { confirmation })` configure double opt-in, as a boolean shorthand or `{ enabled, default_status, subject, body, from }`.
- List notifications: `notifications(list)`, `create_notification`, `update_notification` and `delete_notification`, with schedule shorthands `"daily"`, `"weekly"`, `"monthly"` and `"subscribe"` (fires on each new signup).
- `add_recipients` returns `{ added, updated, pending }` counts.
- Every `from` field on the list, broadcast and notification methods is typed `FromAddress`, so `bunx postboi sync` narrows it to your account's senders.

## 0.14.2

### Added

- `add_recipients` is exported zero-config from `postboi` and `postboi/kit`, takes a list name (an unknown name creates the list) or id, and accepts recipients in the same shapes as `to`. Other providers reject it with code `lists_not_supported`.
- `postboi init` reuses a `POSTBOI_TOKEN` that still authenticates instead of running device auth again, only rewrites webhook secrets when they changed, and skips the env file prompts when nothing changed, so re-running it is a safe way to revisit defaults.

## 0.14.1

### Fixed

- SvelteKit no longer fails a build with "Invalid export" on routes that import `postboi/kit`: the Postboi provider class now lives in its own module, so bundlers stop merging the package root into route entry chunks. The public API is unchanged.

## 0.14.0

### Added

- The npm package ships an agent skill (`skills/postboi/SKILL.md`) that teaches AI coding agents the SDK.
- `postboi init` offers to install the skill into `.claude/skills/postboi/SKILL.md`, and `postboi sync` refreshes an installed copy when it drifts from the bundled one.

## 0.13.0

### Added

- Postboi provider account API: `message(id)`, `reschedule(id, scheduled_at)`, `lists()`, `create_list(name)`, `list(id)`, `rename_list(id, name)`, `delete_list(id)`, `add_recipients(id, recipients)`, `remove_recipient(id, email)`, `broadcast(id, options)`, `suppressions()`, `suppress(email)` and `unsuppress(email)`.
- The Postboi provider forwards `idempotency_key` as an `Idempotency-Key` header.
- Personalized batch sends (`to` array plus `data`) on the Postboi provider go out as one request to `/v1/send/batch`.

## 0.12.0

### Breaking

- `auto_text` now defaults to `true`, so every HTML send also carries a plain-text part derived from the HTML. Pass `auto_text: false` to a provider, or set it in `postboi.config.ts`, to keep sending HTML only.

### Added

- `tracking: { opens, clicks }` per send, mapped to native per-message tracking on Postmark, SendGrid, Mailgun, Mandrill, SparkPost, Mailjet, Elastic Email, ZeptoMail and the Postboi provider. Only the flags you set are sent.
- `unsubscribe_url` sets the RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers on any provider that accepts custom headers. Headers you pass yourself win.
- `cancel(id)` for scheduled sends on the Postboi provider, Resend and Brevo, plus a zero-config `cancel` from `postboi` and `postboi/kit`. Other providers reject with code `cancel_not_supported`.
- `postboi/webhooks`: `receive(request)` verifies an incoming provider webhook and normalizes it into one `WebhookEvent` shape (delivered, opened, clicked, bounced, complained and more), with adapters for every provider that emits events.
- `mock_event` and `mock_request` build correctly signed webhook requests for tests, and `parse_user_agent` reports the mail client, OS and device of an open or click.
- `webhook(handler)` in `postboi/kit` verifies, normalizes and calls your handler once per event, answering with the status codes providers expect.
- Webhook secrets such as `POSTBOI_WEBHOOK_SECRET` or `RESEND_WEBHOOK_SECRET` may hold several comma or space separated secrets, so one handler can serve several endpoints and survive a rotation.
- `postboi init` prompts for each provider's `<PROVIDER>_WEBHOOK_SECRET`, writes `POSTBOI_WEBHOOK_SECRET` for Postboi accounts, and `postboi sync` refreshes it when it changes.

## 0.11.0

### Breaking

- The `CloudOptions` type is now `PostboiOptions`. Rename the import; the options themselves (`token`, `base_url`, plus the common ones) are unchanged.

## 0.10.0

### Breaking

- FormData and form-field bodies are spam-checked before sending. A filled `🍯` honeypot field throws `SpamError` (a `SkipSendError`, and `postboi/kit` answers `{ success: true }`); with `TURNSTILE_SECRET_KEY` set, a missing or invalid `cf-turnstile-response` token throws code `captcha_failed`; a token with no secret configured throws `captcha_misconfigured`. Set `captcha: { honeypot: false, turnstile: false }` per send, per provider or in `postboi.config.ts` to opt out.

### Added

- `captcha` option (`honeypot`, `turnstile`, `key`) on sends, providers and `postboi.config.ts`, plus `SpamError`, `is_spam`, `CaptchaOptions`, `HONEYPOT_FIELD` and `TURNSTILE_FIELD` exports.
- Managed captcha on the Postboi provider: with no local Turnstile secret, the form's token travels with the send and Postboi verifies it, so no Cloudflare account or keys are needed.
- `<Captcha />` components from `postboi/svelte`, `postboi/react`, `postboi/vue` and `postboi/astro`, which drop inside a native `<form>` and add the honeypot and the invisible captcha. Shared helpers live in `postboi/form`.
- `captcha_key` export: the publishable key `bunx postboi sync` bakes into the installed package from `postboi.config.ts`, so tokenless CI builds keep the captcha. `postboi init` writes the key into the config.

## 0.9.6

### Added

- `postboi/maizzle`: `maizzle(template, props, config)` renders a Maizzle template to an HTML string you can pass straight to `body`. Requires the optional peer `@maizzle/framework`. (#5)

## 0.9.5

### Added

- `body` accepts a promise, so `mail({ body: request.formData() })` works without awaiting first. (#2)
- `body` accepts a plain object of fields (the new `FormFields` type), such as Express's `req.body`. (#2)
- `scheduled_at` accepts a relative `Duration` such as `{ days: 1, hours: 5 }`; months and years are calendar aware. (#2)
- The `postboi init` default-from prompt hints the `Name <email>` form. (#2)

## 0.9.4

### Fixed

- A `postboi.config` file that is found but fails to import now logs a warning (with a hint about TypeScript config on older Node) instead of being ignored silently.

## 0.9.3

### Fixed

- `postboi init` removes stale `POSTBOI_FROM` style default vars that older versions wrote to the env file, since env beats config and they silently overrode `default.from`.
- `mail()` warns once when `POSTBOI_FROM` shadows a different `default.from` in `postboi.config`.

## 0.9.2

### Fixed

- `postboi init` no longer writes `POSTBOI_FROM`; the default from you pick goes into `postboi.config`, and `POSTBOI_FROM` stays available as a manual per-environment override.

## 0.9.1

### Fixed

- `postboi init` refuses a default from at a domain that isn't on your Postboi account and asks again (pending domains are accepted with a warning).
- `postboi init` no longer writes `POSTBOI_FROM` when you choose your own default from, which used to override it.

## 0.9.0

### Added

- Typed `from` addresses on the Postboi provider: `bunx postboi sync` writes a `Register` augmentation into `node_modules/postboi` that narrows `from` (the new `FromAddress` type) to your account's addresses. Without it, `from` stays any `Email`.
- `postboi sync` command to regenerate those types.
- `postboi init` lists your domains with their verification status, warns about a default from on a pending or unknown domain, adds a `prepare` script that runs `postboi sync`, and installs postboi without asking.
- The generated config file uses the project's extension (`.ts`, `.js` or `.mjs`).

## 0.8.0

### Added

- `postboi init` on a Postboi account prompts for default fields and writes them to `postboi.config.ts`.

## 0.7.0

### Added

- `postboi init` leads with a Postboi account: it authorizes in the browser (device auth against postboi.email) and writes `POSTBOI_TOKEN`, and the bring-your-own-provider flow stays available.
- `mail()` sends through the Postboi provider when `POSTBOI_TOKEN` is set and no provider is configured, and `provider: "postboi"` is accepted in config.
- `from` is optional on the Postboi provider; the API uses the account's sending address when it's omitted.
- The Postboi provider's default API URL is `https://postboi.email` (`POSTBOI_API_URL` or `base_url` still override it).

## 0.6.1

### Added

- `postboi init` installs postboi as a devDependency in frameworks that bundle server code (SvelteKit, Nuxt, SolidStart, TanStack Start, Analog).

### Fixed

- The Postboi provider's default API URL moved from `api.postboi.uilo.co` to `api.postboi.email`.

## 0.6.0

### Breaking

- The project config file is now `postboi.config.{ts,mts,js,mjs}` and `postboi.settings.*` is no longer read: rename the file. The `PostboiSettings` type is now `PostboiConfig`, and a named `settings` export in the file must become `config` (a default export still works). `config()` and `configure()` keep their names.

## 0.5.0

### Added

- `options` in the config file holds non-secret provider constructor options (such as a Mailgun `domain` or SES `region`) for the zero-config `mail()`; the matching env var still wins.
- `provider: "mock"` is accepted in config as a credential-free local default.
- `postboi init` writes the provider, defaults and non-secret options to a committed `postboi.settings.ts` and keeps only secrets in the env file.

## 0.4.0

### Added

- New providers: `postboi/microsoft365` (Graph), `postboi/smtp` (any SMTP server, no dependencies), `postboi/mailjet` and `postboi/elasticemail`.
- Personalized batch sends: `send({ to: [...], data: { [address]: vars }, subject, body })` (and the same on `mail()`) fills `{name}` placeholders per recipient, uses native batch endpoints where the provider has one, and returns one `BatchResult` per recipient. `data` keys are type-checked against a literal `to`.

### Fixed

- The `postboi` binary is no longer stripped from the package on publish.

## 0.3.1

### Added

- `provider` in `postboi.settings.ts` is typed against the known provider keys, so a typo is a type error.

## 0.3.0

### Added

- `postboi/ses`: Amazon SES v2 provider, signed with SigV4 and no AWS SDK.
- `scheduled_at` (a `Date` or date string) on sends, forwarded to Resend, Brevo, SendGrid, Mailgun and the Postboi provider and ignored elsewhere. An invalid date throws a `PostboiError`.

## 0.2.0

### Breaking

- The zero-config top-level `send()` is now `mail()` in both `postboi` and `postboi/kit` (`export const actions = { default: mail }`). The `.send()` method on provider instances is unchanged.

### Added

- Zero-config sending reads `.env` and `.env.local` as a fallback, so it works in SvelteKit dev where env vars don't reach `process.env`.
- `postboi init` detects the deploy host from the SvelteKit adapter, supports Railway, and skips the env push with a warning when the host's CLI isn't installed.

## 0.1.0

### Breaking

- `postboi/zepto` takes `api_key` instead of `token`: `new Postboi({ api_key: ZEPTO_TOKEN })`.
- `default_from` and `default_to` are replaced by one `default` object: `new Postboi({ api_key, default: { from, to } })`, which also takes `cc`, `bcc` and `reply_to`.
- Every failure (provider error, HTTP error, timeout, network, missing `to` or `from`) throws a `PostboiError` with `message`, `code`, `status`, `provider` and `raw`, instead of the raw ZeptoMail JSON or a plain `Error`. Replace `error.error.message` with `error.message` and `error.error.code` with `error.code`; the original body is on `error.raw`.
- `mail.is_error(e)` now checks for a `PostboiError` rather than the ZeptoMail error shape; a standalone `is_error(e)` is also exported.
- Custom providers extending `ProviderBase` implement `build_request`, `parse_response` and optionally `parse_error` instead of overriding `send(options, defaults)`, and `prepare_send` takes one argument.
- The package root `postboi` now default-exports the hosted Postboi provider (reading `POSTBOI_TOKEN`) and re-exports the core types and classes.

### Added

- Providers for Resend, Postmark, SendGrid, Mailgun, Brevo, MailerSend, SparkPost, Mandrill, Plunk, Mailtrap, MailPace, Scaleway and Cloudflare Email Service, each at its own `postboi/<name>` entry point, plus a `postboi/mock` test provider.
- The hosted Postboi provider as the default export of `postboi`, configured by `POSTBOI_TOKEN` and optionally `POSTBOI_API_URL` or `base_url`.
- Zero-config top-level `send()` that dispatches to the provider named by `POSTBOI_PROVIDER` (or config) and reads `POSTBOI_FROM`, `POSTBOI_TO`, `POSTBOI_CC`, `POSTBOI_BCC` and `POSTBOI_REPLY_TO` as defaults.
- `send(array, { concurrency })` for bulk sends, which never rejects and returns one `BatchResult` per message.
- `text`, `headers`, `tags` and `idempotency_key` send options.
- `timeout` (30 seconds by default), opt-in `retries` with `retry_delay` backoff, and `auto_text` provider options.
- Lifecycle hooks `before.send`, `after.send`, `on.error` and `on.retry`, and `SkipSendError` to cancel a send from `before.send`.
- `postboi/kit` for SvelteKit form actions: a ready-made `send` action and `action(provider, { status, fields })`.
- Global config in `postboi.settings.ts` via `config()` or `configure()`.
- `postboi init` CLI: picks a provider, writes credentials to the project's env file, can push them to Vercel, Cloudflare or Netlify, and installs postboi.
- No runtime dependencies (radashi was dropped).

### Fixed

- The `formatter` send option is now applied when rendering FormData; it was accepted but ignored before.

## 0.0.x

The 0.0.x releases (0.0.1 to 0.0.7) shipped a single ZeptoMail sender at `postboi/zepto`: `new Postboi({ token, default_from, default_to })` with `send({ to, from, reply_to, cc, bcc, subject, body, formatter, attachments })`.
A FormData `body` was rendered into an HTML table (special `_to`, `_from`, `_subject`, `_reply_to`, `_cc`, `_bcc` fields, `fieldset→field` grouping, file inputs as attachments), and failures threw ZeptoMail's error JSON, checked with `mail.is_error(e)`.
The package root exported only the shared types and `ProviderBase`. An early 0.0.x release dropped the `zeptomail` npm dependency for plain `fetch`, and 0.0.7 added a `default` export condition so the package works outside Svelte.
