# Postboi — Multi-channel Plan

The plan for taking postboi from an email library to a multi-channel messaging library:
SMS, push, RCS, WhatsApp and chat, behind one API.

**Status: Phases 0, 1, 3, 4, 5 and 6 shipped** (Phase 6's WhatsApp half in code, its RCS
half as documentation — see the phase for why that's the whole job). Phase 2 (hosted SMS)
remains deliberately unbuilt. The four structural review follow-ups have also landed. This
document is the source of truth for the channel work — read it before starting a phase, and
update it when a decision changes. Reasoning that led to these conclusions lives in this
file's git history.

---

## Decided

- **This is a pivot, not a side feature.** Postboi becomes a multi-channel messaging library
  that happens to have started with email. The channel abstraction _is_ the product, which
  makes the Phase 0 `Transport` split load-bearing rather than tidy-up.
- **Email stays the anchor.** It's the channel we're best at, the one our closest comparable
  doesn't have at all, and the only one needing no approval process.
- **The fan-out function is `send()`, not `notify()`.** `send` has never been exported from
  the package root, so the name is free. The library's whole vocabulary is already
  send-shaped (`SendOptions`, `prepare_send`, `send_batch`, `before.send`), and naming the
  fan-out anything else would mean a `notify()` call firing hooks called `before.send`.
  Rejected: having `send()` sniff `to` and silently dispatch to one channel or many — it
  always takes a channel-keyed `to`.
- **Hooks go channel-generic.** Every hook context carries a `channel`, and `message` widens
  to a union across channels — which breaks existing hooks that read `message.subject`
  without narrowing. **Pre-1.0, so it's a minor bump.** Split across two releases in
  practice: Phase 0 added `channel` (additive, shipped), and the union widens in Phase 1
  when `PreparedSms` exists. So it's still one channel's worth of migration, just announced
  with SMS rather than before it.
- **We ship JavaScript client SDKs, not native ones.** Web Push helpers earn their place;
  Swift/Kotlin/Flutter don't. See [Phase 3](#phase-3--push-and-the-web-sdk).
- **We do not build hosted SMS.** Three independent analyses agree — see
  [Appendix A](#appendix-a--sms-economics).
- **We never charge per contact, and never mark up SMS transport.**

---

## The target API

```ts
import { sms } from "postboi"

await sms({ to: "+447788223344", message: "a text message, what thats mental bro" })
```

```ts
import { push } from "postboi"

await push({ to: subscription, title: "Order shipped", message: "On its way" })
```

```ts
import { send } from "postboi"

// fan-out: every channel gets it, per-channel results, no channel can fail the others
await send({
	to: { email: "ada@example.com", sms: "+447788223344", push: token },
	subject: "Your order shipped",
	message: "Your order shipped",
	body: "<p>Your order shipped</p>",
})

// fallback chain: first success wins, ordered by cost
await send({
	to: { push: token, sms: "+447788223344" },
	channels: ["push", "sms"],
	message: "Your code is 4291",
})
```

Client-side, for Web Push subscription — matching the existing `Captcha` adapter pattern:

```ts
import { subscribe_push } from "postboi/react" // and /svelte, /vue, /astro

const subscription = await subscribe_push({ key: VAPID_PUBLIC_KEY })
await fetch("/api/register-push", { method: "POST", body: JSON.stringify(subscription) })
```

Every one of these keeps what `mail()` already has: zero-config resolution from the
environment, dev-inbox interception, lifecycle hooks, opt-in retries, normalized errors.

---

## Where postboi fits

Postboi is **two products that share one API**, and being explicit about this resolves what
would otherwise be a contradiction in our positioning.

**Layer 1 — the library.** Runs in your process. Resolves providers from your environment
and calls them directly with your own credentials. No postboi infrastructure is involved at
any point. Free, unlimited, every channel.

**Layer 2 — the hosted Postboi provider.** Email transport with real margin, plus the
audience layer (contacts, lists, broadcast). Entirely opt-in, and from the library's point
of view it is _just another provider_ — the same interface as Resend or SES.

The claim that matters, and it holds for both layers:

> **The fan-out always happens in your process. Only transport is optionally ours.**

When you call `send()`, the channel selection, ordering, fallback and per-channel result
handling all execute in your runtime. Whether the email leg then goes to SES, Resend or the
Postboi API is a separate, independent choice. Contrast Knock and Courier, where the fan-out
itself runs on their servers and is metered.

That's why routing can be free: **it costs us nothing, because we aren't running it.**

---

## The competitive set

Multi-channel moves us out of the email-provider comparison and into notification
infrastructure. Three distinct categories, each teaching something different.

### Orchestrators — Knock, Courier, Novu

|             | Charges for                                                     | Numbers                                                      | Transport |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------ | --------- |
| **Knock**   | per notification                                                | Free 10k/mo, then **$250/mo** (50k–250k), $0.005/msg overage | BYO       |
| **Courier** | per notification                                                | Free 10k/mo, then **from $99/mo**                            | BYO       |
| **Novu**    | per **event** — 1 trigger = 1 event regardless of channel count | Cloud tiers; **self-host free**                              | BYO       |

**Bring-your-own-provider is _not_ a differentiator here** — all three are BYO already. They
orchestrate; you supply the keys. What differentiates us is that their orchestration is a
hosted service you pay for per notification, on top of the providers you're already paying.
Ours runs in your process and is free.

**Worth stealing from Novu:** per-_event_ billing is the right shape for multi-channel.
Knock and Courier billing per _notification_ means a three-channel fan-out costs 3×, which
actively penalises the thing they sell. If we ever meter orchestration, meter events.

### Audience-taxers — sent.dm, OneSignal

|               | Charges for            | Numbers                                                                                                     |
| ------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| **sent.dm**   | per **contact/month**  | **$0.015/contact/mo** + carrier fees. SMS/WhatsApp/RCS, **no email**                                        |
| **OneSignal** | per **MAU/subscriber** | Free: unlimited mobile push, 10k web subs, 10k emails/mo. Growth: $19/mo **+ $0.012/MAU** push, email $2/1k |

Both charge for _having_ users rather than for reaching them. That's the clearest line we
have: **you pay for messages, not for having users.**

It is also, per our own infrastructure costing, **not a cost pass-through but value
pricing** — storing a million contacts on D1 is free (see [Pricing](#pricing)).

**sent.dm** does channel-availability detection and cost-optimised routing, which need
hosted per-contact state and live rate cards. We can't and shouldn't fake those. But their
per-contact fee is punishing for transactional senders with large dormant user bases —
exactly postboi's audience — and they have no email channel at all.

**OneSignal** gives away unlimited mobile push forever, and we can't beat free. But the
reason it's free is instructive: **push transport costs nothing per message to anyone.** FCM,
APNs and Web Push are all free, with no carrier or termination fee anywhere. OneSignal isn't
giving away something expensive; they're giving away something free and charging for the
product around it — SDKs, segmentation, journeys, analytics, in-app messaging.

Which means BYO push through postboi is free at **any** scale, with no cliff:

| App size | OneSignal Growth | postboi (BYO) |
| -------- | ---------------- | ------------- |
| 5k MAU   | $0               | £0            |
| 100k MAU | ~**$1,219/mo**   | **£0**        |
| 1M MAU   | ~**$12,000/mo**  | **£0**        |

Be honest about what they give that we won't: client SDKs across every platform,
segmentation, journeys, A/B testing, analytics, in-app messaging. **OneSignal is an
engagement platform that does push; postboi is transactional notification transport.**
Different jobs — the docs should say so rather than claim a win we haven't got.

(Tactical note: OneSignal's email is **$2/1,000 = $0.002/email**. Our hosted tiers work out
at ~$0.0003–0.00045 — **4–7× cheaper**. Anyone consolidating onto them for push gets quoted
that rate for email too.)

### Raw rails — Twilio, Resend, SES, et al.

Not competitors so much as what Layer 1 drives. Our pitch against using them directly is
one API instead of six, cost-ordered fallback, and a dev inbox.

---

## Pricing

### The model

| Layer                                              | Price                     | Why                                                                                                           |
| -------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **The library — all channels, BYO, unlimited**     | **Free, forever**         | Zero marginal cost: it runs in the customer's process. The wedge, unbeatable by anyone carrying hosting costs |
| **Hosted email** (Postboi provider)                | Existing £9/£29/£99 tiers | SES COGS $0.0001 → **60–75% margin**. Where the money is and always was                                       |
| **Audience layer** (contacts, profiles, broadcast) | Bundled into email tiers  | Costs ~nothing on Workers — see below                                                                         |
| **Hosted SMS/RCS**                                 | **Don't build it**        | [Appendix A](#appendix-a--sms-economics)                                                                      |
| **Hosted orchestration**, if ever                  | Per **event**, Novu-style | Never per contact, never per channel                                                                          |

### What infrastructure actually costs us

Cloudflare rates: Workers Paid $5/mo, 10M requests included then $0.30/million. D1: **5 GB
storage included** then $0.75/GB-month, **25 billion rows read/month**, **50 million rows
written/month**.

**Storing contacts is effectively free.** A contact row is a few hundred bytes:

| Contacts | Storage | D1 cost |
| -------- | ------- | ------- |
| 100k     | ~30 MB  | **$0**  |
| 1M       | ~300 MB | **$0**  |
| 10M      | ~3 GB   | **$0**  |

Storage doesn't start billing until roughly **15 million** contacts. A 100k-recipient
broadcast is ~100k reads + ~300k writes + 100k requests ≈ **$0.33** of infrastructure,
against ~£29 of revenue at the current tier — and the read allowance covers ~250,000 such
broadcasts a month.

**Two things do cost, and neither is "having contacts":**

1. **Retained history — storage × time.** Contacts are small; messages aren't. ~1M
   messages/month at ~20 KB is ~20 GB, or **~$15/month for every month retained**, growing
   linearly forever. This is why OneSignal sells data retention as a paid tier. **Retention
   policy is an early decision, not a detail.**
2. **Per-contact recurring compute.** A journey with 500k users ticked hourly is ~360M
   writes/month ≈ **$360/month for one journey**. Behavioural segments mean repeatedly
   scanning event tables. _That_ is what forces per-MAU pricing.

Usefully, that boundary lands exactly on what we've chosen to build versus decline.

### What it looks like for a real app

SaaS, **100k registered users**, **50k notifications/month** (mostly email + push, ~5k SMS
OTPs), UK:

|                            | Platform fee   | Notes                                     |
| -------------------------- | -------------- | ----------------------------------------- |
| sent.dm                    | **~$1,500/mo** | Before a single send. No email channel    |
| Knock                      | **$250/mo**    | On top of your own provider bills         |
| Courier                    | **$99/mo+**    | Same shape                                |
| OneSignal                  | **~$1,219/mo** | Push MAU alone                            |
| **postboi (BYO)**          | **£0**         | Transport paid direct to your providers   |
| **postboi (hosted email)** | **£29/mo**     | Email transport included, SMS BYO at cost |

### The strategic honesty

**This pricing means the multi-channel work earns no direct revenue.** The library stays
free; monetisation remains hosted email. The pivot is a **distribution play** — SMS, push,
RCS and chat make postboi the obvious default for "tell this user something", and a share of
those users take hosted email because it's already configured.

That's legitimate but it sets the success metric: **judge these phases on adoption and
hosted-email conversion, not channel revenue.** There won't be any, by design.

The product claim to build toward: **postboi picks the cheapest rail that reaches the user,
across your own provider accounts, and tells you what it chose.** sent.dm routes but hides
it and taxes your contact list; Knock and Courier orchestrate but ignore cost; Twilio will
never route you to a competitor. Nobody does cost-aware, auditable, cross-vendor selection —
and the in-process model is exactly what lets us give it away.

The spread that justifies it is total, not marginal:

> push **£0** → hosted email **~£0.0003** → RCS/WhatsApp → UK SMS **2.8p**

Routing to push instead of SMS doesn't save a percentage. It saves the entire cost.

---

## What has to change

`ProviderBase` (`src/library/index.ts:472`) is one class doing two jobs. Splitting it is the
enabling move for everything else.

### Channel-agnostic — reusable as-is (~400 lines)

| Member                                                    | Where           |
| --------------------------------------------------------- | --------------- |
| `request()` — timeout, retry, backoff, `on.retry`         | `index.ts:841`  |
| `#should_retry` / `#backoff` / `#sleep`                   | `index.ts:893`  |
| `read_json`                                               | `index.ts:984`  |
| `error_for`                                               | `index.ts:586`  |
| `with_hooks` / `before_send` / `#emit_error` / `#observe` | `index.ts:612`  |
| `normalize_error` / `is_error`                            | `index.ts:693`  |
| `send_batch` (+ `pooled_map` in `utils.ts`)               | `index.ts:709`  |
| `fill_template` / `translate_placeholders`                | `index.ts:727`  |
| `resolve_scheduled_at`                                    | `index.ts:1007` |
| `file_to_base64`                                          | `index.ts:908`  |
| `PostboiError` / `SkipSendError`                          | `index.ts:339`  |

### Email-specific — stays behind (~400 lines)

| Member                                                                                    | Where           |
| ----------------------------------------------------------------------------------------- | --------------- |
| `prepare_send` — to/from/cc/bcc/subject/html/text/unsubscribe                             | `index.ts:1184` |
| `parse_form_data` — the HTML table renderer                                               | `index.ts:1042` |
| `to_form_data`                                                                            | `index.ts:1026` |
| `enforce_captcha`                                                                         | `index.ts:1162` |
| `parse_email_address` / `parse_addresses` / `stringify_address(es)` / `email_name(_list)` | `index.ts:930`  |
| `parse_attachment(s)`                                                                     | `index.ts:914`  |
| `send_data_batch` — `{key}` personalisation per recipient                                 | `index.ts:774`  |
| `cancel`                                                                                  | `index.ts:562`  |

`send_data_batch` is email-specific only because its plumbing is; the idea generalises and
can be lifted if an SMS provider turns out to have a batch endpoint worth using.

### Coupling audit — what does _not_ need touching

- `kit.ts`, `form.ts`, `vite.ts` and `mail.remote.ts` never reference `ProviderBase` or
  `PreparedMessage`. Unaffected.
- Every provider file extends `ProviderBase` and implements three hooks. Keep
  `ProviderBase` exported as an alias of the new `EmailProvider` and **zero provider files
  change**.
- `webhooks/` is entirely separate and unaffected.

---

## Architecture after the split

```
                       ┌───────────────────────────────────────┐
                       │  Transport (channel-agnostic base)    │
                       │  request/retry/timeout · hooks ·      │
                       │  error normalisation · batch fan-out  │
                       └───────────────┬───────────────────────┘
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
    │  EmailProvider   │    │   SmsProvider    │    │  PushProvider    │
    │  (= ProviderBase)│    │                  │    │                  │
    │  prepare_send    │    │  prepare_sms     │    │  prepare_push    │
    │  FormData·captcha│    │  E.164 normalise │    │  token targeting │
    └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
             │                       │                       │
   resend·ses·postmark·…    twilio·puresms·sns·…    webpush·fcm·apns
             │                       │                       │
             ▼                       ▼                       ▼
         mail()                   sms()                   push()
             └───────────────────────┼───────────────────────┘
                                     ▼
                                  send()          ← runs in your process
```

Each channel gets a resolver mirroring `resolve_provider` (`mail.ts:89`): its own `LOADERS`
map, env var (`POSTBOI_SMS_PROVIDER`, `POSTBOI_PUSH_PROVIDER`), defaults, and the same
dev-inbox interception.

---

## Open decisions

1. **Bare numeric `to` for SMS.** `to: 447788223344` reads beautifully but a JS number loses
   the leading `+` and any leading `0` — `07788 223344` arrives as `7788223344`, and nothing
   downstream can tell a UK number from a US one.
   _Proposed: accept it, normalise against a default country (`POSTBOI_SMS_COUNTRY` /
   `default.country`), and throw `PostboiError { code: "ambiguous_number" }` naming both
   fixes when none is set. Strings pass through untouched. Never guess a country._

2. **Package layout.** Phase 1 alone adds 4–6 files to a directory already past 50, and
   `exports.test.ts:32` asserts every non-internal `.ts` there has a `package.json` exports
   entry.
   _Proposed: `src/library/sms/*` and `src/library/push/*`, updating `to_source`
   (`exports.test.ts:11`) for the nesting. Email files stay put._

3. **UK sender ID pre-registration.** Sources conflict: Ofcom declined to mandate
   registration and the MEF registry is voluntary, but at least one provider's compliance
   guide lists the UK as pre-registration required. Probably regulator versus carrier
   practice. **Get a definitive answer from whichever provider we ship before writing it
   into the docs.**

4. **Does `PostboiError` gain a `channel` field?** It carries `provider` today
   (`index.ts:341`) but nothing says _which channel_ failed — and `send()`'s per-channel
   results are exactly where that matters. It's a public class, so adding a readonly field
   later is a change we'd rather not make twice.
   _Proposed: add `channel` in Phase 0, while we're already touching the error path._
   **Decide before Phase 0, not after** — this is the only open decision that does block it.

5. ~~**Which UK-native SMS provider?**~~ **Decided: The SMS Works.** See
   [Appendix B](#appendix-b--uk-sms-provider-evaluation) for the evaluation. The headline
   price gap turned out to be an illusion, so the choice fell to architecture fit.

6. **Release cadence.** Six phases against a repo where every release snapshots the
   versioned docs (`src/lib/content/v*/`) and `scripts/release.sh` is a single scripted path.
   _Proposed: ship each phase as its own minor — 0.24 the `Transport` split (no user-visible
   change, so the hooks break lands quietly and early), 0.25 SMS, and so on. Smaller blast
   radius and real feedback before `send()` locks the fan-out shape._

7. **Dev inbox scope in Phase 1.** The checklist calls this the biggest non-provider chunk,
   but it's really two things: **interception** (a dev send must not reach a real handset —
   safety-critical, non-negotiable) and the **inbox UI tab** (convenience).
   _Proposed: interception ships with Phase 1; SMS falls back to console logging until the
   UI tab lands. Roughly halves Phase 1's riskiest piece without weakening the guarantee._

Also worth confirming, though neither needs deciding now: `postboi/kit` stays **email-only**
(it's FormData/form-action shaped, and there's no coherent SMS form action), and the
generated `Register` types narrow email `from` addresses only — extending them to SMS sender
IDs is a later question, not a Phase 1 one.

Rebranding is mechanical and can happen in one pass whenever: README opener, site tagline
(`src/lib/config/navigation.ts:34`), docs section description, `package.json` keywords
(currently just `["svelte"]`), the shipped agent skill in `skills/`, and `llms.txt`.

---

## Phase 0 — the `Transport` split ✅ **done**

**No user-visible change.** Landed in `ab1b476` and `6ac84c1`.

1. ✅ `src/library/transport.ts` — `abstract class Transport<TResponse, TPrepared>` owns
   `request`/retry/backoff, `read_json`, `error_for`, hook sequencing, `normalize_error`,
   bounded batch fan-out, `fill_template`, `resolve_scheduled_at` and `file_to_base64`.
2. ✅ `src/library/errors.ts` — `PostboiError`, `SkipSendError`, `SpamError` and the guards
   moved to their own module so `transport.ts` and `index.ts` can both reach them without
   importing each other. **`PostboiError` gained `channel`.**
3. ✅ `EmailProvider extends Transport<TResponse, PreparedMessage>` keeps `prepare_send`,
   FormData rendering, captcha and address parsing — exported as `ProviderBase`.
4. ✅ Hook contexts gained `channel`; `Hooks` is now `TransportHooks<PreparedMessage>`.
5. ✅ SigV4 lifted into `src/library/aws.ts`, parameterised by service.

**Two signatures changed, both `protected`:**

- `with_hooks(prepare, core)` — it used to take `SendOptions` and call `prepare_send`
  itself, which tied it to the email options shape. It now takes a prepare callback.
- `run_batch(messages, send, batch)` on `Transport` is the generic form; `send_batch` stays
  on `EmailProvider` as the email-shaped wrapper.

Only `mock.ts`, `smtp.ts` (both override `send`) and `ses.ts` (the signer) needed touching.
**Every other provider file was unchanged**, which was the point of the alias.

**Verified:** 502/502 tests, `bun run lint`, `bun run check` (0 errors), `bun run prepack`
(publint clean). Two test expectations updated — a `toEqual` on the retry-hook context now
carries `channel`, and `exports.test.ts` gained the three new internal modules.

⚠️ **Deviation worth knowing.** The plan said `message` would widen across channels here.
It can't yet — `PreparedSms` doesn't exist, so the union has one member and nothing
observable broke. Hook contexts gaining `channel` is **additive**; the actual breaking
widening lands in Phase 1 when `Hooks` becomes
`TransportHooks<PreparedMessage | PreparedSms>`. That's arguably better — 0.24 ships a
pure refactor, 0.25 ships SMS _and_ the break — but it means **the hooks break is a Phase 1
release note, not a Phase 0 one**.

**Actual effort: well under the 1–2 day estimate**, because the coupling audit held: no
`ProviderBase` references in `kit.ts` / `form.ts` / `vite.ts` / `mail.remote.ts`.

---

## Phase 1 — SMS, bring-your-own provider ✅ **done**

### Types

```ts
/** E.164 string, a bare number (normalised against the default country), or a labelled object. */
export type Phone = string | number | { number: string; name?: string }

export interface SmsOptions {
	to?: Array<Phone> | Phone
	from?: string // purchased number or alphanumeric sender ID
	message: string
	scheduled_at?: Date | string | Duration
	tags?: Array<string>
	idempotency_key?: string
}

export interface PreparedSms {
	to: Array<string> // E.164, normalised
	from?: string
	message: string
	scheduled_at?: Date
	tags?: Array<string>
	idempotency_key?: string
}
```

`SmsProvider extends Transport` with the same three-hook contract as email, plus
`prepare_sms` doing E.164 normalisation, default merging and segment validation.

### Providers

Each ~80 lines, same shape as `resend.ts`.

| Provider                     | Endpoint                                                              | Auth               | Notes                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| **Twilio**                   | `POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json` | Basic (SID:token)  | Form-encoded, not JSON. Scheduling via `ScheduleType=fixed` + `SendAt`, requires `MessagingServiceSid` |
| **PureSMS**                  | REST + API key                                                        | API key            | **UK-native, 2.8p flat**, no tiers or minimum, free sender ID                                          |
| **AWS SNS**                  | `POST https://sns.{region}.amazonaws.com/` (`Action=Publish`)         | SigV4              | Nearly free once `aws.ts` exists                                                                       |
| The SMS Works                | REST + API key/JWT                                                    | key/JWT            | UK-native, charges only for **delivered** — fits our `BatchResult` reporting                           |
| Vonage                       | `POST https://rest.nexmo.com/sms/json` (legacy)                       | key/secret in body | Their Messages API needs an RS256 JWT; start legacy                                                    |
| MessageBird / Plivo / Telnyx | REST                                                                  | key                | Copy-paste once the shape is proven                                                                    |

_Ship Twilio + PureSMS + SNS._ Twilio because everyone's heard of it; a UK-native because
UK traffic is 4–7× US and UK-native is ~1.5× cheaper than Twilio there; SNS because it's
nearly free once Phase 0 step 5 lands.

### Zero-config `sms()`

Mirrors `send_mail` (`mail.ts:182`):

- Own `LOADERS` map keyed off `POSTBOI_SMS_PROVIDER`, falling back to `config.sms?.provider`
- `sms_env_defaults()` alongside `env_defaults` (`env.ts:99`), reading `POSTBOI_SMS_FROM`
  and `POSTBOI_SMS_COUNTRY`
- **Dev-inbox interception preserved.** `resolve_dev_inbox` (`mail.ts:70`) outranking a
  credentialled provider matters _more_ for SMS than email — a stray dev send costs real
  money and reaches a real handset with no undo
- Same missing-credential behaviour: log in development, throw in production

### Onboarding

In the UK this is close to email-grade: alphanumeric sender IDs are **free** (Twilio lists
them at £0 against $2.50/mo for a mobile number), and **registration is not mandated** —
Ofcom explicitly declined in Nov 2025; the MEF registry is voluntary. Sign up → API key →
pick an 11-character sender ID → send.

Caveats, all small: 11 chars GSM-only; **one-way** (nobody can reply to an alphanumeric
sender — fine for OTPs, needs a virtual number for conversational); must be
brand-recognisable; some networks want 1–14 days of pre-registration. The weeks-long pain is
US 10DLC, which isn't our market.

**Discovery is our problem to solve, and the machinery exists.** `registry.ts` already drives
`postboi init` with names, credential URLs and fields. For SMS it should be _opinionated_,
because unlike email the right answer depends on destination:

```
$ bunx postboi init --sms
? Where are you sending?  › United Kingdom
? Provider:
  ❯ PureSMS        2.8p/msg   UK-native · flat rate · no minimum
    The SMS Works  3.1p/msg   UK-native · only charges for delivered
    Twilio        ~4.3p/msg   global · the most examples and docs
? Sender ID (11 chars, what recipients see)  › POSTBOI
```

### Cross-cutting checklist

Every new channel touches more than a provider file. This is the actual cost:

- [ ] `package.json` `exports` entry per module — enforced by `exports.test.ts:32`
- [ ] `registry.ts:33` — `PROVIDERS` gains `channel`, plus a `regions` hint and indicative
      price so `init` can recommend. Prices rot: carry a verified-on date
- [ ] CLI: channel step, SMS `DEFAULT_FIELDS` (`src/cli/providers.ts:19`), sender ID prompt,
      `render_config` (`:41`) writing an `sms:` block
- [ ] `config.ts:27` — `PostboiConfig` gains `sms?` / `push?`; `merge()` (`:84`) deep-merges them
- [ ] **Dev inbox** — `SentMessage` (`mock.ts:16`) and `InboxMessage` (`inbox.ts:25`) are
      email-shaped. Add a `kind` discriminant, extend `Inbox.deliver` (`inbox.ts:55`), give
      the UI a second tab. **The biggest non-provider chunk of Phase 1**
- [ ] Mock provider per channel, for tests and the dev fallback
- [ ] Docs page, `contentSections` entry (`src/lib/config/navigation.ts:34`), `llms.txt`
- [ ] `skills/` — the shipped agent skill describes email only

**Shipped**, including the pieces the checklist called out:

- `sms/phone.ts` — E.164 normalisation and GSM segment counting, not a libphonenumber port
- `sms/provider.ts` — `SmsProvider extends Transport`, same three hooks as email
- The SMS Works, Twilio and AWS SNS, plus an SMS mock
- `sms()` with env resolution, and `postboi init --sms` asking destination first
- Docs at `/sms`, in a new **Channels** nav section
- 45 tests across normalisation, providers, the resolver and dev interception

**Two deviations from the plan, both deliberate:**

1. **Dev interception is stricter than email's.** The plan said to mirror the dev inbox,
   which only intercepts when it's _running_. SMS intercepts on `NODE_ENV=development`
   **always**, because the failure modes aren't comparable — a stray email is embarrassing,
   a stray text costs money and can't be recalled. `dev: { sms: false }` or
   `POSTBOI_SMS_DEV=send` is the way out, and both are opt-in so doing nothing is safe.
2. **The dev-inbox UI tab is not built.** As agreed in open decision 7 — interception is the
   safety guarantee and shipped; SMS logs to the console until the tab lands.

**Effort: well under the ~1 week estimate.**

---

## Phase 2 — SMS on the Postboi provider

**Recommended: don't.** See [Appendix A](#appendix-a--sms-economics). Kept here for
completeness, and because the shape would be:

Code (~1 week in `postboi-app`): `/v1/sms` + `/v1/sms/batch` routes; a `channel` column on
the existing messages table (reusing dashboard views and the LiveFeed DO for free); delivery
receipt ingestion mirroring the SNS bounce path; an `sms` namespace on the provider, with
`lazy_namespace` (`mail.ts:249`) extending to it.

Not code, and strictly blocking: a carrier contract; **10DLC / sender ID registration**;
**STOP/HELP handling, legally mandatory**; per-destination pricing and billing; and fraud
limits — a leaked SMS token spends real money in a way an email token doesn't.

**Effort: 1 week of code behind weeks of compliance, for a business case that doesn't hold.**

---

## Phase 3 — Push, and the web SDK ✅ **done**

Structurally harder than SMS for one reason: **email addresses and phone numbers arrive with
the send; push tokens must be registered and stored first.**

### Web Push

- VAPID (RFC 8292) auth, RFC 8291 `aes128gcm` payload encryption
- WebCrypto only, no dependency: ECDH P-256 shared secret, HKDF, AES-128-GCM. Runs on
  Workers. `pushforge` is a good reference for the byte layout. Payload cap 3993 octets
- Endpoint is per-subscription, so there's no fixed base URL

### FCM (Android)

- `POST https://fcm.googleapis.com/v1/projects/{project_id}/messages:send`
- Auth is an OAuth2 access token from a service-account JWT (RS256) exchanged at
  `https://oauth2.googleapis.com/token`. **Needs a token cache** — the exchange is far too
  slow per-send

### APNs (iOS)

- `POST https://api.push.apple.com/3/device/{token}`. HTTP/2 only; drops HTTP/1.1
- **Not the blocker it looks like.** APNs needs unary HTTP/2, not bidirectional streaming.
  Deployed Workers reach APNs today via `fetch()`; on Node, undici's `allowH2` now defaults
  to `true`. _Verify empirically on the target Node version_ — the default flipped at some
  point. Fallback: `node:http2` behind a runtime check, or proxy via FCM
- **Known gap:** `wrangler dev` on macOS fails APNs while production succeeds
  ([workerd#4841](https://github.com/cloudflare/workerd/issues/4841), open since Aug 2025).
  Doesn't block shipping, but the dev inbox must cover push properly since a Mac can't
  smoke-test it
- Token auth: ES256 JWT from the `.p8` key, refreshed hourly. WebCrypto does ES256
- _Not our issue:_ [workerd#6455](https://github.com/cloudflare/workerd/issues/6455) asks
  for HTTP/2 **bidirectional streaming** (gRPC) — a different capability

### The web SDK

postboi already ships client adapters and they are tiny — `react.ts` 55 lines, `vue.ts` 62,
`Captcha.svelte` 50, `Captcha.astro` 62. A Web Push helper is the same shape: request
permission, register a service worker, `pushManager.subscribe({ userVisibleOnly: true,
applicationServerKey })`, hand back the subscription. Plus a service-worker template for
receiving.

**~2–3 days across all four frameworks**, shipping on the npm pipeline that already exists.
Closer to necessary than optional — the browser API is fiddly enough that everyone gets it
slightly wrong.

**Native mobile SDKs are declined, and the reason is not effort but permanence:**

- A **new release pipeline per platform**. Today it's one command — tag → GitHub Action →
  npm via OIDC trusted publishing (`scripts/release.sh`). Native means SPM _and_ CocoaPods
  _and_ Maven Central (GPG signing, Sonatype staging) _and_ pub.dev, each with its own
  credentials and failure modes
- **Device testing** — push registration can't be meaningfully unit-tested
- **Annual OS churn** — iOS and Android change notification APIs every year, forever
- **A brutal support surface** — "push doesn't arrive on Xiaomi" is a whole genre

**And they aren't required for mobile push to work.** The server already talks to FCM and
APNs; the app registers its token with whatever the mobile team already uses and POSTs it to
the developer's own backend. Our SDK would be convenience for registration, not a
requirement. Web Push is different — there the browser API earns a helper.

Order if mobile pull ever appears: **Expo / React Native next** (JavaScript, same npm
pipeline, serves our actual audience — ~3–5 days), and native Swift/Kotlin/Flutter last at
2–3 weeks _each_ plus permanent maintenance, understood as starting a second product.

### The subscription store

`push()` needs to resolve "user 123" → tokens. Start with **raw tokens passed by the
caller** — simplest, and punts the problem. A `push.subscriptions` namespace on the hosted
provider is the natural home later, alongside `contacts`.

**Shipped**: Web Push (VAPID + `aes128gcm`), FCM, a mock, the browser helpers, and `push()`
wired into `send()`'s cost ordering — where it now sits first, as the genuinely free channel.

**The encryption is verified against the RFC 8291 §5 worked example, byte for byte.** That
mattered more than any other test in this project: Web Push fails _silently_ when key
derivation is wrong — the push service accepts the request and the service worker simply
never fires — so a round-trip test would have proven nothing about whether the constants
were right. `encrypt_payload` takes an optional salt and key pair purely so the published
vector can be reproduced.

`push.expired()` (also `PushProvider.is_expired()`) is a first-class check rather than a status code to match by
hand, because subscriptions expire constantly and normally, and the correct response is to
delete your stored copy — not retry, not alert.

**APNs is not implemented, and doesn't need to be.** Reaching iOS through FCM is one
credential instead of two and avoids the HTTP/2 question entirely. Direct APNs stays open
as a follow-up if someone wants to skip Firebase.

**Effort: a day, against the 1–2 week estimate** — the estimate assumed fighting the
encryption, and the RFC vector meant it was either right or obviously wrong.

---

## Phase 4 — `send()` ✅ **done**

Thin once the channels exist: a fan-out over the per-channel resolvers reusing `pooled_map`,
returning per-channel results rather than rejecting wholesale — an SMS failure must not lose
the email. Two modes:

- **fan-out** (default): every channel in `to`, results keyed by channel
- **fallback chain** (`channels: [...]`): first success wins. **Order by cost-class, not just
  availability** — SMS to Western Europe can be ~100× a push carrying the same words. This is
  the one piece of cost-aware routing a library can honestly do, because the ordering is a
  per-send policy decision rather than something needing live wholesale pricing

Shares `subject` / `message` / `body` across channels with per-channel overrides for where
copy genuinely differs (SMS is 160 chars; email isn't).

**Shipped** with email, SMS and chat; push slots in when Phase 3 lands.

- **Fan-out** runs the channels **concurrently** — they're independent, and one slow
  provider shouldn't hold up the rest.
- **Fallback** runs **sequentially and stops at the first success**, which is the entire
  point: not paying for the next channel once one has worked.
- `channels: "cheapest"` uses the built-in order **push → chat → email → sms**, intersected
  with the channels you actually have an address for — otherwise "cheapest" would try
  everything every time.
- `send()` only rejects when `to` names no reachable channel at all. Otherwise it resolves
  with a per-channel result and `ok` reflecting whether _anything_ got through.
- Every failure carries the channel it came from, filled in where a channel entry point
  threw before a provider existed.

**The template-only path is handled by construction rather than by a special case.** In a
fallback chain any error advances to the next channel, so a WhatsApp send outside its 24-hour
window will hand off rather than fail the send — no template mapping needed at this layer.
Phase 6 only has to make WhatsApp throw the right error.

**Effort: well under the ~2 day estimate**, because the three channels already had identical
zero-config entry points to dispatch to.

---

## Phase 5 — chat channels (no approval needed) ✅ **done**

- **Slack / Discord / Teams incoming webhooks** — one POST each, no auth beyond the URL. A
  couple of hours apiece and the best return in this document
- **Telegram** — `POST https://api.telegram.org/bot{token}/sendMessage` with
  `{ chat_id, text }`. No approval. **But** the recipient must have started a chat with your
  bot and you address them by `chat_id` — the same registered-identity problem as push
  tokens, so plan it alongside the subscription store

**Shipped.** Slack, Discord, Teams and Telegram, plus a mock — later reshaped into the
per-platform `slack()`/`discord()`/`teams()`/`telegram()` (the generic `chat()` left the
public surface: you always know which platform you're posting to, so it survives only as
`send()`'s channel-generic chat leg) — the thinnest
channel yet, since there are no addresses to parse, no encoding to count and no delivery
receipts.

⚠️ **Teams needed rewriting before it was written.** The plan said "incoming webhooks",
meaning Office 365 connectors — **Microsoft disabled those in May 2026**, so a legacy
`office.com/webhook/…` URL no longer delivers at all. The provider targets a **Power
Automate Workflows** webhook and posts an **Adaptive Card**. Workflows still accepts the old
MessageCard shape for migration, but Microsoft's guidance is Adaptive Cards and MessageCard
drops interactive elements. The registry note says so in the provider picker, because a dead
connector URL looks perfectly plausible.

**No development interception here**, unlike SMS — deliberately. Posting to your own Slack
channel while developing is usually the point: it costs nothing, reaches only your team, and
can be deleted. The SMS interception exists because a stray text costs money and can't be
recalled; neither applies.

Telegram sits with the push work rather than the webhook providers in one respect: a
`chat_id` is a **registered identity**, not an address — a bot can't message someone who
hasn't started a chat with it — so it has the same storage problem as a push token.

**Effort: a few hours, as estimated.**

---

## Phase 6 — WhatsApp and RCS (approval-gated) ✅ **done**

**Shipped.** `whatsapp()` with Twilio (`postboi/whatsapp-twilio`) and Meta's Cloud API
(`postboi/whatsapp-meta`) plus a mock, template-first exactly as sketched below — the
24-hour window surfaces as `code: "outside_window"` /
`whatsapp.closed()` (also `WhatsappProvider.is_outside_window()`), and `send()`'s fallback chain advances past it by
construction, as Phase 4 promised. WhatsApp slots between email and SMS in the `"cheapest"`
order. Development interception mirrors SMS (`dev: { whatsapp: false }` /
`POSTBOI_WHATSAPP_DEV=send`), for the same money-and-handset reason. The mock simulates
the window (`outside_window: true` fails free-form, delivers templates).

Two deliberate deviations from the sketch:

- The entry point takes `variables` with **named or numeric keys** — numeric maps to
  Meta's positional `{{1}}` parameters, named to `parameter_name`. Twilio gets both as
  `ContentVariables` JSON either way.
- RCS shipped as **documentation, not code** — see below: within Twilio there is nothing
  to build, and the honest place for "add an RCS sender to your Messaging Service" is the
  SMS docs page, which is where it now lives. The `upgrade: true` cross-provider rail
  selection idea stays unbuilt until real rate data exists to drive it (the pricing table
  below is why a constant would be wrong).

What still needs a human: brand/template approval on either platform, and real-device
smoke tests once an approved sender exists — none of it reachable from code.

### RCS — do this one first

Viable now: Android throughout plus iOS 18.1+ (2024), and Twilio took it generally available
in August 2025 across all accounts. Brand verification is console-side, so the provider is
thin — the same Twilio messaging endpoint with an RCS-capable sender.

**Twilio already auto-upgrades**: add an RCS Sender to a Messaging Service and it routes by
device capability with automatic SMS fallback, **no code change**. So within one provider
there is nothing for us to build.

**Pricing — RCS does _not_ dodge carrier fees.** Every message carries a transport fee _and_
a carrier pass-through. Its wins are structural:

| Type                   | What                                                   | vs SMS                  |
| ---------------------- | ------------------------------------------------------ | ----------------------- |
| **RCS Basic**          | ≤160 chars                                             | ~**parity**             |
| **RCS Single**         | >160 chars, billed as **one message**, not per segment | ~**+20–30%**            |
| **RCS Conversational** | One fee covers **24h unlimited, both directions**      | ~**2×** for the session |

(The US uses per-segment "Rich RCS" and has **no** conversational option — a rare case where
UK/EU is the better market.)

**Win 1 — long messages.** SMS bills per 160-char segment; RCS Single bills once:

| Length | SMS | RCS             | Saving   |
| ------ | --- | --------------- | -------- |
| ≤160   | 1×  | ~1× (Basic)     | parity   |
| 320    | 2×  | ~1.25× (Single) | **~38%** |
| 480    | 3×  | ~1.25× (Single) | **~58%** |

**Win 2 — delivery-only billing**, the edge The SMS Works sells on SMS (~8.9%), standard here.

**Win 3 — conversational sessions.** Break-even is **two messages**; everything after is
free. Cost per _interaction_ collapses.

**Costs:** ~**$700 one-time onboarding per sender** (Twilio); AWS splits it into setup +
**annual** brand vetting + **monthly** maintenance. Rich media is MMS-priced (~2.5×).
**Double-delivery**: if RCS lands after the revocation window but before SMS fallback,
you're billed for both. **UK gotcha:** some carriers suspend a sender after **90 days
without traffic**.

**Honest UK verdict:** Twilio RCS Basic is at parity with Twilio _SMS_ (~4.3p), still above
UK-native SMS at 2.4–2.8p. For a short transactional message, cheap UK SMS still wins. RCS
wins on **length**, **two-way**, and **branding**.

#### Should `sms()` pick the rail automatically?

Within one provider, Twilio already does it. **Our value would be cross-provider**, which no
vendor will do — and there the crossover moves out because RCS's base rate is higher:

| Length | PureSMS (2.8p/seg) | Twilio RCS (~4.3p) | Winner          |
| ------ | ------------------ | ------------------ | --------------- |
| ≤160   | 2.8p               | ~4.3p              | **SMS** by ~35% |
| 320    | 5.6p               | ~5.4p              | wash            |
| 480    | 8.4p               | ~5.4p              | **RCS** by ~36% |

So any rule must read the _configured_ providers' real rates, not a constant.

**The conversational idea has two traps.** Billing mode is set on the **agent at
registration** and applies to all its traffic — a provisioning choice, not a per-send one.
And a session only opens when the **recipient replies**, so a burst of outbound
notifications bills individually.

_Proposed:_ opt-in `sms({ to, message, upgrade: true })`. Length selection is deterministic
so it's safe to automate; conversational pricing isn't, so document it. And **the result
must report which rail delivered** — silent cost optimisation nobody can audit is how you
lose trust the first time a bill looks strange.

**Effort: ~3 days.**

### WhatsApp

Via Twilio with `whatsapp:+44…` prefixed `To`/`From` (reuses the Phase 1 provider almost
entirely, and is the cheaper way in), or Meta's Cloud API directly
(`POST https://graph.facebook.com/v{version}/{phone_number_id}/messages`, Bearer token).

**The constraint that reshapes the API:** a **24-hour customer service window**, opened when
the user last messaged you and reset by each inbound message. Inside it, free-form text.
**Outside it, only pre-approved templates.** Most transactional sends happen outside any
window, so **template-only is the normal case**:

```ts
await whatsapp({
	to: "+447788223344",
	template: "order_shipped", // pre-approved with Meta, by name
	variables: { name: "Ada", tracking: "AB123" },
})
```

Pricing is per delivered template since July 2025, by category and country. Utility
templates and in-window service messages are free today, but **that ends 1 October 2026**.

**Effort: ~1 week**, gated behind template approval.

### Deliberately not doing

- **iMessage** — Apple Messages for Business is approval-gated, enterprise-shaped, no general
  send API
- **Voice / TTS** — a small extension of the Twilio/Vonage providers if ever wanted, but not
  a notification channel in the sense meant here
- **Fax** — genuinely still exists (Documo, Phaxio; Twilio killed theirs in 2021), ~80 lines,
  worth it for the README line and nothing else

---

## Where this could go — the audience layer

The Postboi provider already ships the primitives an engagement platform is built on:

| Already built                                                                            | Where                     |
| ---------------------------------------------------------------------------------------- | ------------------------- |
| `contacts` — one per address, global `data`, search/filter                               | `postboi_provider.ts:550` |
| `lists` + `recipients` — membership, three-state status, double opt-in                   | `:405`, `:481`            |
| **`lists.broadcast()`** — one message to a list, `{key}` templating, unsubscribe headers | `:463`                    |
| `notifications` — recurring digests and `subscribe`-triggered sends                      | `:616`                    |
| `suppressions` — account-wide opt-out                                                    | `:678`                    |
| `messages` — status, reschedule, cancel                                                  | `:385`                    |

Multi-channel turns that into the same thing everywhere:

1. **Delivery profiles** — a contact carries `phone`, `whatsapp` and push tokens alongside
   `email`. This is also our answer to sent.dm's identity resolution
2. **`lists.broadcast()` goes multi-channel** — highest-leverage change here; templating,
   membership, suppression and unsubscribe already work
3. **Per-channel preferences** — not optional ambition: SMS STOP and email unsubscribe are
   **legally required anyway**, so this gets built regardless

All of it sits in the ~free column on Workers, so it bundles into the existing email tiers
and **the "never charge per contact" commitment survives**.

**Declined:** visual journey builders, A/B testing, behavioural analytics, in-app messaging.
Those are the parts that force per-MAU pricing, and they're a different company — different
buyer (growth/marketing, not developers) and different discipline (campaign UX, not delivery
correctness).

**Sequencing:** revisit after Phase 4. An audience layer is only interesting once there's
more than one channel to route between.

---

## Risks

| Risk                                                                               | Mitigation                                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| The `Transport` split churns every provider file                                   | Keep `ProviderBase` as an alias; the existing suite is the regression net               |
| The `hooks.before.send` break lands badly                                          | Do it in Phase 0 with one channel to migrate, not six. Minor bump, changelog it         |
| Bare-number `to` guesses the wrong country                                         | Never guess — throw `ambiguous_number` unless a default country is set                  |
| A dev send reaches a real handset                                                  | Dev-inbox interception is not optional for SMS. Inbox outranks a credentialled provider |
| `send()` ships assuming free-form text, then WhatsApp needs templates              | Design the template path in Phase 4, build it in Phase 6                                |
| Chasing sent.dm's availability/rate-card routing into a library that can't have it | Those need hosted per-contact state. Build on `contacts` or don't fake it               |
| APNs can't be smoke-tested locally on macOS                                        | workerd#4841 — production is fine. Make the dev inbox cover push                        |
| The library sprawls                                                                | Per-channel subdirectories from the start                                               |
| Native SDK scope creep                                                             | JavaScript only. Native is a second product, not an extension                           |

---

## Review follow-ups (structure, not bugs) ✅ **done**

The first full code review confirmed and fixed twelve correctness bugs (see the
`review.test.ts` regression suite). Four structural findings were deferred at the time and
have since **all landed**:

- **One channel-keyed registry** — `CHANNEL_PROVIDERS` maps every `Channel` to its
  provider list (`satisfies Record<Channel, …>`), and `find_channel_provider()` replaced
  the per-channel `find` field on `ChannelResolution`. The per-channel arrays and `find_*`
  functions remain as the public/CLI surface.
- **A shared mock base** — `MockRecorder` (composition, not inheritance: each mock must
  extend its channel's provider base, so there's no free slot in the hierarchy). The
  WhatsApp mock got its implementation for free, which was the point.
- **Per-origin VAPID JWT caching** in webpush — one ECDSA signature per push-service
  origin per ~11 hours, refreshed an hour before the 12-hour expiry.
- **`send()`'s hand-synced channel enumerations** collapsed into one
  `satisfies Record<Channel, …>` descriptor map. Proven immediately: adding `"whatsapp"`
  to `Channel` refused to compile until the registry, `send()` and the hooks union all
  acknowledged the new channel.

## Considered: holding channel credentials (team sync) ✅ **shipped**

The question: `postboi init` already does the heavy lifting for the Postboi token
(device auth, written to env, pushed to your host). For the other channels it collects
credentials and writes them locally, but every teammate repeats the dance. Should the
Postboi provider store these secrets so teams share/sync them?

**Where init stands today:** identical UX up to the point of custody. It prompts, writes
env files, offers gitignore, and offers a push to Vercel/Cloudflare/Netlify/Railway — so
the "heavy lifting" exists, but the secrets only ever live with the user and their host.

**Recommendation: yes, but as CLI-time sync, never runtime fetch.**

- A `postboi env push` / `postboi env pull` pair (or `init --team`) that stores channel
  env vars encrypted against the account, so a teammate's `postboi init` offers
  "pull the team's channel credentials" instead of re-prompting. Dotenv-vault/Doppler
  ergonomics without the extra vendor.
- **Not** a runtime secret fetch. "The fan-out runs in your process, no server in the
  send path" is load-bearing positioning (and uptime maths) — a credential fetch at send
  time would put us back in the path we deliberately left. Sync at CLI time keeps custody
  convenience without touching the send path.
- Costs to accept before building: we become a custodian of third-party secrets
  (encryption at rest, scoped team roles, revocation, audit log, and a story for "Postboi
  got breached" that doesn't include "and so did your Twilio account"). That's real
  surface. Worth it only bundled with the team features that already exist around
  accounts/members — not as a standalone.

**Status: shipped**, ahead of the parked plan, on a direct call to go zero-ceremony:

- `PUT/GET /v1/env` on the Postboi provider, values AES-GCM sealed at rest (key derived
  from the app secret), merge semantics so two teammates pushing different channels never
  clobber each other, `POSTBOI_TOKEN` rejected as a key.
- `postboi init` pushes the credentials it collects (any channel, email included) when a
  token exists; `postboi sync` pulls whatever the local env is missing — local values
  always win. `postboi env` (list/push/pull `--force`/remove) is the explicit surface.
- The hard line held: CLI-time sync only. Nothing in the send path reads the store.
- **Init pulls too**: every init flow fetches the team's synced credentials before
  prompting, and a prompt whose value the team already holds answers itself. A credential
  is typed once, on one machine, ever. (Web Push goes one further: `init --push` skips
  the generate-a-key-pair offer when the team's VAPID pair is already synced — a second
  pair would orphan every subscription collected under the first.)

## Considered: minting credentials via provider OAuth apps

The sweep: for every provider in the registry, can Postboi register an "app" with them so
`init` gets a token via OAuth instead of asking the user to paste one?

| Provider                                                                 | Mechanism                                                 | Verdict                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slack**                                                                | OAuth v2, `incoming-webhook` scope                        | **Yes, and it's ideal** — the OAuth callback hands back a ready-made webhook URL for a channel the user picks on Slack's own consent screen. No token to find, no URL to paste.           |
| **Discord**                                                              | OAuth2, `webhook.incoming` scope                          | **Yes, same shape** — the token exchange response contains a freshly-created webhook with its URL.                                                                                        |
| Twilio (SMS + WhatsApp)                                                  | [Twilio Connect](https://www.twilio.com/docs/iam/connect) | Real but medium-weight: user authorises our Connect app, we get their Account SID and act on their behalf — which changes the custody story (requests run through our credentials). Park. |
| Meta (WhatsApp Cloud API)                                                | Embedded Signup                                           | Exists, but needs a Meta Business app, app review, and a hosted signup flow. The heaviest option for the nichest channel. Park.                                                           |
| Resend / Postmark / SendGrid / Mailgun / Mailjet / Elastic Email / Zepto | none                                                      | No third-party OAuth for API-key minting — dashboard-issued keys only.                                                                                                                    |
| SES / SNS (AWS)                                                          | IAM only                                                  | No sane delegated flow for long-lived keys; anything workable would ask for far more account access than an SMS sender should.                                                            |
| Teams                                                                    | none for Workflows webhooks                               | The webhook URL comes out of Power Automate by hand.                                                                                                                                      |
| Telegram                                                                 | none                                                      | BotFather is a chat conversation; there is no API that creates bots.                                                                                                                      |
| Web Push                                                                 | n/a                                                       | Already solved locally — `init --push` mints the VAPID pair itself, no vendor involved.                                                                                                   |

**Recommendation: build Slack and Discord OAuth, park the rest.** The two that work are
also the two with the friendliest consent UX, and the flow reuses plumbing that already
exists for `POSTBOI_TOKEN` device auth: `init --chat` → browser opens
`postboi.email/connect/slack?device=…` → the app (holding the client id/secret
server-side) forwards to the provider's consent screen → callback stores the webhook URL
against the device code → the CLI polls, writes `SLACK_WEBHOOK_URL`, and team-syncs it.
Needs from an operator before any code: register the Slack app (redirect URL
`postboi.email/connect/slack/callback`, scope `incoming-webhook`) and the Discord
application (scope `webhook.incoming`), then set the client ids/secrets in the app's env.

Until then, every flow does the next-best thing already: it prints the provider's exact
credential page (`resend.com/api-keys`, `console.twilio.com`, BotFather, …) before
prompting, and the prompt names the env var it's filling.

## Upstream things to track

None block shipping — this is the "has it got better yet?" list.

| What                                                | Where                                                                                                                                                                                                                                                                      | Why we care                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| APNs over `fetch()` fails in local workerd on macOS | [workerd#4841](https://github.com/cloudflare/workerd/issues/4841) — open, Aug 2025                                                                                                                                                                                         | Closing it means push can be smoke-tested locally                                   |
| HTTP/2 bidirectional streaming (gRPC) in Workers    | [workerd#6455](https://github.com/cloudflare/workerd/issues/6455) — open, Mar 2026                                                                                                                                                                                         | **Not needed for APNs.** Only if we ever want a gRPC transport                      |
| undici `allowH2` default                            | [nodejs/undici](https://github.com/nodejs/undici) `docs/docs/api/Client.md`                                                                                                                                                                                                | Currently `true`. If it flips, Node-side APNs needs a `node:http2` fallback         |
| UK A2P SMS termination rates                        | [Ofcom](https://www.ofcom.org.uk/phones-and-broadband/mobile-phones/a2p-sms-termination-market)                                                                                                                                                                            | MNO commitments expire **31 Dec 2028**. They set the floor under every UK SMS price |
| UK SIM farm offence                                 | [Crime and Policing Act 2026 guidance](https://www.gov.uk/government/publications/possession-and-supply-of-sim-farms/crime-and-policing-act-2026-guidance-offences-relating-to-the-possession-and-supply-of-sim-farms-and-legitimate-uses-of-multiple-sim-devices-accessi) | 5+ SIMs = SIM farm; offence from **29 Oct 2026**, no business exemption             |
| WhatsApp in-window pricing                          | Meta pricing docs                                                                                                                                                                                                                                                          | Utility templates and service messages become chargeable **1 Oct 2026**             |
| Workers runtime generally                           | [Workers changelog](https://developers.cloudflare.com/workers/platform/changelog/)                                                                                                                                                                                         | Protocol and API support moves without issue-tracker noise                          |

---

## Effort summary

| Phase | Scope                                      | Estimate          | Blocked by                           |
| ----- | ------------------------------------------ | ----------------- | ------------------------------------ |
| 0     | `Transport` split, generic hooks, `aws.ts` | 1–2 days          | —                                    |
| 1     | SMS, BYO providers                         | ~1 week           | Phase 0, decisions 1 & 2             |
| 2     | SMS on the Postboi provider                | ~1 week code      | **Not recommended** — see Appendix A |
| 3     | Push + Web Push SDK                        | 1–2 weeks         | —                                    |
| 4     | `send()`                                   | ~2 days           | Phases 1 & 3                         |
| 5     | Slack / Discord / Teams / Telegram         | hours each        | Phase 0                              |
| 6     | RCS, then WhatsApp                         | ~3 days + ~1 week | Brand approval lead time             |

**Phases 0, 1, 3, 4 and 5 total roughly 3.5 weeks with no external dependency.** That's the
ship-it-first slice — and with email already in place it's a more complete notifications
story on day one than the SMS-only comparables have at all.

Phase 5 is deliberately ordered before the flashier Phase 6: Slack and Telegram cost hours
and make `send()` immediately useful, while WhatsApp and RCS can't send anything until
someone else approves a brand.

---

## Appendix A — SMS economics

Why we don't build hosted SMS. Three independent analyses, all landing in the same place.

### 1. The floor: UK MNO termination

UK networks charge a **termination fee** to deliver each A2P message. It is paid to the
terminating operator, so scale cannot compete it away — it is not aggregator margin.

- Wholesale termination rose **15–75% since 2021**, triggering an Ofcom market review
- Ofcom's **March 2025 consultation proposed a 1.96p cap**
- Ofcom then **accepted voluntary commitments instead of regulating** (Oct/Nov 2025) from
  **BT/EE, Sky, Virgin Media O2, VodafoneThree** — over **90% of A2P sold to aggregators** —
  running **1 Jan 2026 → 31 Dec 2028**, capping maximum standard price, limiting rises to
  once per 12 months with 60 days' notice
- The agreed maxima are **redacted**; market evidence puts the range at **2.00p–2.80p**

### 2. UK retail, and why UK ≠ US

**UK SMS costs roughly 4–7× US SMS.**

| Provider          | Price              | Notes                                                              |
| ----------------- | ------------------ | ------------------------------------------------------------------ |
| **PureSMS**       | **2.8p** + VAT     | UK-native, flat, no tiers or minimum, free sender ID               |
| **Esendex**       | from 2.4p          | UK-native, but £54/mo minimum plan                                 |
| **The SMS Works** | from 3.1p + VAT    | UK-native, **charges only for delivered** (~8.9% saving)           |
| **Twilio**        | **$0.056** (~4.3p) | Their own GB page. Short code $0.0524 + **$1,667/mo** for the code |

US all-in is ~$0.008 (~0.6p): Telnyx $0.004 + $0.0035–0.0045 carrier surcharge; Twilio
$0.0079–0.0083 + $0.003–0.005. Number rental (Twilio UK): local $1.15/mo, mobile $2.50/mo,
**alphanumeric sender ID free**.

UK prices are ex-VAT. USD-priced vendors hand you the FX risk; UK-native bills in GBP. I
could not get hard UK figures from ClickSend or Vonage — their pricing renders client-side.

**Note PureSMS at 2.8p and Esendex from 2.4p are already at or very near termination cost.**

### 3. What we could achieve as the provider

| Route                | Realistic cost/msg | Price of admission                                                          |
| -------------------- | ------------------ | --------------------------------------------------------------------------- |
| Resell a CPaaS       | 2.8p–4.3p          | Nothing — and no better than our customers get                              |
| Wholesale aggregator | ~2.2–2.6p          | **2M SMS/month** minimum, or ~**800k** for micro-aggregator status          |
| Direct MNO SMPP      | ~2.0–2.8p          | Four carrier relationships, SMPP infrastructure, credit-worthy counterparty |

Best case is **~0.6–0.8p gross margin** — ~25% at the very best, before compliance, fraud and
24/7 ops. At the ~800k/month floor we'd commit to **~£22k/month of traffic before a single
customer**, to earn ~£5.6k/month if we filled it. Email is 60–75% margin with no minimum.

**SMS COGS is also ~80× email's** ($0.008 vs $0.0001), so it cannot ride the email tiers —
20,000 SMS on the £9 tier would lose ~$150/month per customer. And it wants **prepaid
credits**, not post-paid metering: AIT/SMS-pumping is 5–40% of international A2P traffic and
cost businesses ~$1.6bn in 2023, so a leaked token on a post-paid account is our bill.

### 4. Routes that don't exist

**No origin arbitrage.** SMS is priced by the country the recipient is in, not where the
account or number sits — Twilio's $0.056 GB rate is what a US account pays to reach a UK
handset. Cross-border long-code sending is provider-restricted and lands as a `+1` nobody can
reply to. And **alphanumeric sender IDs aren't supported in the US or Canada at all**, so a
US-centric setup is _worse_ equipped for UK sending, not cheaper.

**No grey routes.** They bypass commercial A2P agreements by disguising A2P as P2P, cost
operators ~$7.7bn/year, and are met with SMS firewalls doing live traffic classification.
Unreliable delivery, junk DLRs, rewritten sender IDs, eventual cut-off.

**No SIM farms — it's now a criminal offence.** The **Crime and Policing Act 2026** bans
possession or supply of a SIM farm (**5+ physical SIMs** used simultaneously or
interchangeably) from **29 October 2026**, unlimited fine in England & Wales. The good-reason
defences are named and narrow — live broadcasting, freight GPS, on-train Wi-Fi, telecoms
testing — and **"sending SMS to your own customers" is explicitly not among them**, with **no
licence to apply for**. Networks detect device-originated A2P by its signalling signature
anyway, and consumer bundles carry no-A2P fair-use terms.

**EU is worse than the UK.** Netherlands, Belgium and Germany can exceed **$0.09/segment**.
The intra-EU 6c cap is **consumer-only**; business traffic is excluded. France requires
sender ID pre-registration, Spain and Australia were added in 2026, and unregistered traffic
gets _content-filtered_ rather than cleanly rejected — it fails quietly.

### The conclusion

**The termination fee is not a middleman markup — it is the price of the destination network
agreeing to deliver.** Anything genuinely cheaper is, by construction, not-delivery. There is
no legitimate below-floor lane for guaranteed A2P SMS.

So don't try to undercut SMS. **Make it the fallback of last resort behind channels that
don't ride the termination rail** — which is exactly what `send()`'s cost-ordered fallback is
for, and the reason it's the most valuable thing in this plan for a UK/EU sender.

---

## Appendix B — UK SMS provider evaluation

Phase 1 ships Twilio (global, familiar), AWS SNS (near-free once `aws.ts` exists) and one
UK-native provider. This is the sweep behind that UK choice.

### The criterion that eliminated most of the field

A library is adopted by people starting at zero. **Any provider requiring a monthly
subscription or a large minimum is disqualified**, however good its headline rate — a
developer trying `sms()` for the first time must not hit a £54/month gate.

That single test splits the market cleanly, and it isn't visible from the headline prices
everyone quotes.

### Pay-as-you-go — genuinely usable from zero

| Provider          | Effective UK rate                             | Commercials                                                      | API                                                                           |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **The SMS Works** | **~2.82p** (3.1p less ~8.9% delivery refunds) | PAYG, no minimum, credits never expire, **50 free test credits** | Excellent — see below                                                         |
| **PureSMS**       | **2.8p** flat                                 | PAYG, no minimum, no monthly                                     | Good, but white-labelled and error handling undocumented                      |
| **ClickSend**     | ~3.5–4p (~$0.045)                             | PAYG, $20 minimum top-up, free inbound                           | Decent and global, but UK rate is unpublished and it's ~30% pricier           |
| **Twilio**        | ~4.3p ($0.056)                                | PAYG                                                             | Already shipping as the global option                                         |
| **FireText**      | 4.0p (1,000 tier)                             | Credits, no expiry                                               | Documented errors, webhooks, ISO 27001 + ICO registered. Simply too expensive |
| **TextAnywhere**  | 4.9p                                          | Credits **that expire**                                          | Ruled out on price _and_ expiry                                               |

### Subscription — disqualified regardless of headline rate

| Provider      | Entry               | **Effective rate**                                  |
| ------------- | ------------------- | --------------------------------------------------- |
| **VoodooSMS** | £54/mo → 500 msgs   | **10.8p** (£143/2,500 = 5.72p; £468/10,000 = 4.68p) |
| **Esendex**   | £54/mo minimum plan | "from 2.4p", but gated behind the plan              |

**The advertised sub-2p UK rates are a mirage.** VoodooSMS is quoted around 1.74–1.8p in
comparison articles, which sits _below_ the 2.00–2.80p MNO termination range in
[Appendix A](#appendix-a--sms-economics) — that alone should have been a flag. It's a
bespoke enterprise-volume rate; entry pricing is **~4× The SMS Works**.

Note also that **VoodooSMS and Esendex are both Commify UK Limited** — the same parent and
the same £54/mo entry structure. Two apparently independent options are one commercial
decision.

### The two real contenders

|                   | **The SMS Works**                                                                                   | **PureSMS**                                            |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Base URL          | `api.thesmsworks.co.uk/v1`                                                                          | `connect-api.divergent.cloud`                          |
| Operator          | **Their own platform**                                                                              | **Divergent Connect** — PureSMS is a white-label brand |
| Auth              | Long-lived JWT in `Authorization`                                                                   | `X-Api-Key` header                                     |
| Send              | `POST /message/send`                                                                                | `POST /sms/send`                                       |
| Batch             | **`/batch/send`** (same message, 5k), **`/batch/any`** (unique personalised, 5k), `/batch/schedule` | `POST /sms/send/bulk` (array of messages)              |
| Delivery receipts | Webhook POST, optional **basic auth**                                                               | Webhook POST, **HMAC-SHA256 signatures**               |
| Errors            | **Documented codes, permanent/temporary classification, reason codes**                              | **Not documented on the developer page**               |
| SDKs              | C#, Go, Java, Node, PHP, Python, Ruby                                                               | .NET, Node, community PHP                              |
| Getting started   | **50 free test credits**                                                                            | Free account, no card                                  |

### Decision: **The SMS Works**

It is both the **cheapest genuinely pay-as-you-go UK option** and the best API. Specifically:

1. **`/batch/any` is a direct architectural fit.** "Unique personalised messages to up to
   5,000 recipients" is precisely what `send_data_batch` (`index.ts:774`) does with `{key}`
   templating — it maps straight onto `build_batch_request` with no impedance.
2. **Documented error codes feed two required methods.** `parse_error` is mandatory for
   every provider, and their **permanent/temporary classification** can drive
   `#should_retry` properly instead of falling back to bare HTTP status. PureSMS's error
   documentation is absent — we'd be reverse-engineering the one method we can't get wrong.
3. **Delivery-only billing matches our reporting model** and makes DLR handling
   load-bearing rather than decorative.
4. **No reseller layer.** PureSMS is a brand on Divergent Connect, so docs span two sites
   and a supplier change would break us invisibly.
5. **Direct UK carrier connection.** Independent testing groups Esendex, FireText,
   VoodooSMS and The SMS Works at **5–15s delivery**, against 10–30s for international
   platforms routing into the UK.
6. **50 free test credits** — the provider can be built and tested immediately.

**Trade-off accepted:** PureSMS has **HMAC-SHA256 webhook signatures** where The SMS Works
offers only optional basic auth. That's genuinely weaker, and it stings because
`webhooks/crypto.ts` already implements HMAC for other providers. Basic auth over HTTPS
plus the `?token=…` pattern used elsewhere in `webhooks/` is workable, but say so in the
docs rather than glossing it.

**Unverified:** their volume tiers aren't published ("more than that? talk to us"), so
high-volume rates need a conversation. Not a Phase 1 blocker.

### Follow-ups worth noting

- **PureSMS** stays on the list — `X-Api-Key`, flat pricing, ~80 lines once the
  `SmsProvider` shape is proven.
- **Esendex v2 is multi-channel**: `POST https://api.esendex.co.uk/v2/messages` takes a
  `channel` parameter for **SMS, WhatsApp and RCS**. One vendor covering three of our
  channels is genuinely interesting for Phase 6 — the £54/mo minimum is what rules it out
  of Phase 1, not the technology.
- **Grey routing is a live concern in this market.** VoodooSMS advertises "100% UK White
  Routes — Guaranteed", which is a vendor thinking it needs to say so. Worth asking any
  future provider directly, and worth a line in the docs about why the cheapest quote isn't
  always the cheapest outcome.
