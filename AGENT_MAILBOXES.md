# Postboi agent mailboxes: the plan

An email address an agent owns. It receives, it reads, it replies, it starts
conversations when it is allowed to, and a person can see every one of those things and
stop any of them. Postboi's version is **agentboi.email**: the mailbox that stays, beside
tempboi.email, the one that goes.

**Status: Phases 0 and 1 built, October 2026.** `agentboi.email` is registered. The
mailbox that receives, reads, replies and sends is in both repos on
`claude/agent-mailboxes-planning-y0p3hu`. A second round on
`claude/postboi-agent-mail-gaps-8n9qvh` added folders, labels, search, drafts, review,
forward, attachments and a local `postboi mcp`; jev's mailbox rubric and the hosted MCP
server are still to come. [Round three](#round-three-an-identity-not-only-an-inbox) is the
next round: optional key expiry is implemented on `feature/agent-key-expiry`, pending
deployment. Workload exchange, leases, hard limits, account inventory and teardown remain
planned. [Built so far](#built-so-far) says what shipped and where it parted from the
plan below, and [Before launch](#before-launch) lists the zone and SES steps that only a
person with the Cloudflare and AWS consoles can take. This document is the source of truth
for the mailbox work in both repos: read it before starting a phase, and update it when a
decision changes. The research it rests on is summarised in
[Appendix A](#appendix-a--the-field-in-october-2026), with links; the codebase facts in
[What we already have](#what-we-already-have) were read from the code the week this was
written.

## Built so far

**postboi-app**, migration 0091:

- `agentboi.email` is a third site on the Worker, fenced by host the way tempboi.email is
  (`$library/agentboi`, `reroute`, `handle`). It has its own page (make a mailbox in one
  press, the key said once), `llms.txt`, `robots.txt` and `sitemap.xml`, and no cookie
  banner, Analytics or service worker.
- `/v1/mailboxes`: create (anonymous, or with a team key), list, get, rename, delete,
  rotate the key, `messages` with an `after` cursor and `wait`, `wait` with a timeout,
  one message, its raw `.eml`, its attachments (served `sandbox`), reply, send, threads
  and one thread. In `openapi.json` under a Mailboxes tag.
- Mail arrives through Email Routing at `/v1/inbound` (an `AGENT_DOMAIN` branch before any
  account lookup, refusing an unknown, deleted, suspended or oversized mailbox at SMTP
  time) and through SES on a team's own `reply.<domain>` (`/v1/sns/inbound`). Both file it
  with `ingest_inbound`, so it is a row in the team's Received log with its thread, and
  `email.received` webhooks carry `mailbox`, `trust`, `reply_text` and `codes`.
- Sending goes through `/v1/send`'s own gates (paused account, quota, the unverified
  daily cap, rate) and `deliver`, threaded with `In-Reply-To` and `References`, logged in
  the Sent log, and reviewed by jev on the agentboi lane while the account is young.
  `/v1/send` learned `in_reply_to` (an inbound id) for any team send.
- Dashboard: **Mailboxes** under the team (whole-team members), to make, rename, rotate
  and delete, with the key shown once. In the sidebar and the palette.
- The audit log names a mailbox's actions as `Mailbox <address>`.

**postboi (SDK)**:

- `postboi/mailbox`: `mailbox()` resolves from `POSTBOI_MAILBOX_KEY` or makes one, plus
  `mailbox.create`, `mailbox.open` and `mailbox.list` (team key). A `Mailbox` has `wait`,
  `list`, `read`, `watch`, `reply`, `send`, `threads`, `thread`, `info`, `rename`,
  `rotate` and `delete`. The long-poll helpers moved into `long_poll.ts`, shared with
  `postboi/inbox`. `src/testing/fake_agentboi.ts` is a fake server for tests.
- `mail()` and the Postboi provider take `in_reply_to`.
- `postboi mailbox new|ls|watch|wait|read|reply|send|threads|key|rm`, remembering keys in
  `~/.config/postboi/mailboxes.json` (mode 0600).
- Docs: `mailbox.svx`, the navigation and products entries, `agents.svx`, `compare.svx`,
  the CLI reference and the skill. Three lines under `## Unreleased`.

### Where it parted from the plan

- **The key is `mb_…` and lives on the mailbox row, not in `api_keys`.** A mailbox key
  can then never pass `api_auth` anywhere else: every other route answers 401 by
  construction rather than by a scope check somebody has to remember. A team's `pb_` key
  opens every mailbox of the team; a client workspace key opens none yet.
- **An unclaimed mailbox receives and does not send at all.** There is no `owner` field
  and no write-to-the-owner allowance yet. A send is refused with the code `unclaimed` and
  the account's claim link, which is the same claim flow `init --agent` already uses, so
  the agent can hand the link to a person. Open decision 5 is settled that way for now.
- **What only a mailbox needs is a side table**, `mailbox_messages` (seq, tag, trust,
  reply_text, codes, links, raw_key), keyed on the inbound row and deleted with it. The
  Received log's table and writes are untouched. `messages` gained nothing: a send from a
  mailbox is an ordinary row with the mailbox's address as its From.
- **No `mailbox.*` webhook events.** `email.received` carries the mailbox fields, so a
  team's existing endpoint hears agent mail without subscribing to anything new.
- **Trust is `owner`, `thread`, `stranger` or `suspect`.** `known` waits for the
  allowlist. `owner` is a whole-team member's address with DMARC passing; `suspect` is
  jev's junk verdict, an SES spam fail or a DMARC fail. jev's agent-aimed rubric is still
  Phase 3.
- **No mailbox count on any plan.** An idle mailbox is one row; what costs anything
  (received mail, its storage, an agent holding a long poll) grows with use. What a burst
  of new addresses does cost is agentboi.email's name on the disposable-domain lists, so
  Free may make 10 a UTC day (`DAILY_MAILBOX_LIMIT`, deleted ones counted, 429
  `mailbox_rate_limited`), a paid plan has no limit, a plan the table doesn't name is held
  to Free's number, and an unclaimed account (an `init --agent` key holds one) makes 3 in
  its whole life. The day's fiftieth on any plan is an operator alert and nothing more.
  Storage has no allowance yet beyond the existing message caps; if one is needed it is a
  storage allowance, not a count.
- **Deleting a team retires its agentboi.email addresses** (migration 0092), so an
  address that was one agent's is never another team's, even once the rows are gone.
- **"support" is reserved** on the shared namespace, so the examples say `orders`.
- **Not built in Phase 1**: the Members → Agents view, Admin → Mailboxes, the claim page on agentboi.email (the existing
  claim link is used), `init --agent --mailbox`, `sync` typing mailbox names, and the
  disclosure footer.

### Round two: folders, drafts, review and MCP

Measured against Resend's Inboxes (folders, read state, labels, search, drafts, forward and an
MCP server), which agentboi had none of. Both repos, branch
`claude/postboi-agent-mail-gaps-8n9qvh`.

- **Threads have a folder, a read state and labels.** `inbox`, `archive`, `spam`, `trash`,
  and `sent` for a conversation the mailbox started that nobody has answered. New mail marks
  a thread unread and brings it back from the archive or `sent`, and leaves spam and trash
  where a person put them. `GET …/threads` filters on `folder`, `label`, `unread` and `q`
  (subject, sender, recipients and text); `PATCH …/threads/:thread` moves, marks and labels.
  Labels are per mailbox (50, five colours), and naming one that doesn't exist makes it.
- **Review replaces the held queue's policy object, for now.** A mailbox's `review` is
  `none`, `new` or `all`, set only with the team's key. Under `new` a reply to the person who
  wrote, adding nobody, goes; everything else from the mailbox's own key is saved as a draft
  and answered 202 `{ status: "draft" }`. The team's key is never held. Approve-by-reply and
  `allow` lists are not built.
- **Drafts** are the held queue's rows and the hand-off Phase 5 described: written by the
  agent (`POST …/drafts`) or made by a held send, sent from the dashboard or with
  `…/drafts/:id/send` (the mailbox key is refused `review_required` for a draft review would
  hold). The team hears through the `drafts` notification and the `mailbox.draft.created`
  and `mailbox.draft.sent` webhooks.
- **Forward and attachments.** `…/messages/:id/forward` sends `Fwd:` with a note and the
  original's kept files; sends, replies and drafts take base64 attachments, 20 files and
  10 MB in all.
- **SDK**: `postboi/mailbox` has all of it (`threads` filters, `update_thread`, `archive`,
  `trash`, `mark_read`, the label calls, the draft calls, `forward`, `attachments`, `review`
  and `set_review`), and every send resolves to `sent` or `draft`. The CLI gained `archive`,
  `trash`, `move`, `mark`, `label`, `labels`, `drafts`, `draft`, `forward` and `review`.
  `receive()` reads the two draft events.
- **`postboi mcp`** is the local half of Phase 4: stdio, JSON-RPC by hand rather than
  `@modelcontextprotocol/sdk`, because the package has no runtime dependencies and stdio is a
  few methods. Twenty tools: the mailbox ones, `temp_inbox_create`, `temp_inbox_wait` and
  `email_send`. A mailbox key opens its own mailbox only; the team's key takes a `mailbox`
  argument. Every result carrying a stranger's words wraps them in `<email trust="…">` after
  a line saying they are data, and a sender's own `</email>` is escaped so it can't close the
  block. The hosted `mcp.postboi.app` is still to come.
- **No key to copy.** `mailbox()` used to make a new address on every call unless
  `POSTBOI_MAILBOX_KEY` was set, which put a key-copying step in front of the one-liner.
  With the team's `POSTBOI_TOKEN` (already in `.env` from `postboi init`) it now opens the
  team's mailbox, or the one a name means (`mailbox("support")`, matched on the name it was
  made with since agentboi adds a suffix), and makes it the first time; several and no name
  is `ambiguous_mailbox`. Without a token, a mailbox made is kept in the CLI's
  `mailboxes.json` under the directory it was made from, which the library, the CLI and
  `postboi mcp` all read, so the next run reopens it. The mailbox key stays, for an agent
  that should reach one mailbox and nothing else of the team's.

## Before launch

Things only a person with the consoles can do. Nothing is broken without them, but no mail
reaches `agentboi.email` until the first two are done.

1. **Cloudflare zone for agentboi.email** on the same account as the Worker. Turn on Email
   Routing and point the catch-all at the Worker (`postboi`), as tempboi.email's is.
2. **SES identity for agentboi.email** in `SES_REGION`: Easy DKIM records in the zone, a
   custom MAIL FROM (`bounce.agentboi.email`) with its MX and SPF, and DMARC at
   `p=reject`. The app adds the identity to a team's tenant when it makes the team's
   first agentboi mailbox, and `mint_tenant`'s heal adds it for any team that has one.
   Until the identity exists those calls fail quietly and SES refuses sends from a
   mailbox.
3. **Deploy** picks up the `agentboi.email` and `www.agentboi.email` custom domains in
   `wrangler.jsonc`, and the `llms.txt` and `sitemap.xml` renames in `inject_cron.ts`.
   The page's abuse line is `ABUSE_ADDRESS`, shared with tempboi.

---

## Round three: an identity, not only an inbox

**In progress, October 2026.** Step 1 is implemented on `feature/agent-key-expiry` in
both repos, pending review and deployment (app migration 0106). The remaining steps are
planned. Written against Builder.io's
[Why are we still handing AI agents API keys?](https://www.builder.io/blog/ai-agent-identity),
which is the clearest statement yet of what the agent-identity threads ask for.

### What the post asks for

Agents run on their owner's credentials, so to every service they _are_ the owner, and a
long-lived key works from anywhere for whoever holds it until somebody notices. Its
examples are all one shape: a key copied into `.env`, CI, a gateway and an agent shell,
then leaked from one of them (Railway, LiteLLM, a $15,400 Gemini bill, METR's $600,000 of
credits on a key with no cap). What it wants instead:

- the agent has its **own** email, accounts and a card with a hard limit, so revoking it
  never touches the person;
- credentials are **short-lived and per task**, made at the start of a job and revoked at
  the end, and ideally **keyless**: OIDC workload identity, a platform vouching for the
  job as GitHub Actions does for AWS, Vertex and now OpenAI and Anthropic;
- **limits the agent can't raise** replace approval prompts, which people approve 93% of
  the time and then switch off;
- **teardown** comes in the box.

And: "nothing that bundles inbox, accounts, card, and teardown for a solo developer". The
enterprise answers (Microsoft, Okta, Google, AWS) are for companies with an IdP.

### Where we already answer it

The inbox is ours: an address in one call with no account, an `mb_…` key that opens one
mailbox and nothing else by construction, trust labels on what arrives, the review gate
and drafts, codes and links read out on arrival (`OTP-Token` believed first), the audit
log naming the mailbox as the actor, and tempboi for the address that should go.

### Where we are the thing it complains about

Before this round, Postboi's own credentials were long-lived keys:

- `pb_…` had no expiry and has two scopes, account and client workspace (`api_keys.ts`).
- `mb_…` could be rotated and had no expiry (`mailbox_api.ts`, `mint_key`).
- `postboi init` authorises the device in the browser properly (`/api/cli/start`, `/poll`)
  and then writes a permanent `pb_` key into `.env`, which is the copy the post's breaches
  start from. CI then gets the same key as a secret.
- The local `postboi mcp` reads that key from the environment, so an MCP client's config
  carries it too.

A mailbox key is also worth more than it looks. **The mailbox is the recovery channel for
every account the agent signs up for**, so whoever reads it can reset all of them. An
agent that only needs one sign-in code shouldn't hold a key that reads password resets.

### The order

Ship the following slices separately. Expiry comes first; shared revocation and a basic
disable switch come before any new way to mint credentials. The account inventory comes
after the access controls and hosted MCP.

#### 1. Keys that end

- **Optional expiry on both kinds of key.** `api_keys.expires_at` and
  `mailboxes.key_expires_at`, NULL being never, so existing keys keep working. Set at mint
  or rotation (dashboard and `postboi mailbox new|key --ttl`), expose the expiry in the API
  and SDK, and show it on the dashboard. Expired credentials answer 401 `key_expired`;
  unknown, revoked or rotated credentials keep their existing errors. An expiry equal
  to now is expired. Expiry gates access through both direct mailbox routes and mailbox
  discovery, and applies to client workspace keys too.
- **Rotation is no extension.** An expiring mailbox key may rotate itself, but the new key
  cannot outlive the old one. Omission preserves the deadline. Only the team can remove
  or extend it. A mailbox created with an expiring team key inherits at most that key's
  deadline. Expiry does not delete a mailbox or stop incoming mail.
- **Leave local sign-in unchanged for this slice.** The current device flow is a
  single-use exchange with browser approval, not a refresh protocol. Keep `init`'s
  existing behavior until renewal is implemented. The later default should be an expiring
  local key with explicit interactive renewal. Unattended renewal needs a separate,
  revocable refresh credential stored in the OS credential store, rotation and reuse
  detection, and a credential resolver SDK processes can use; rewriting `.env` does not
  update a running process.
- **Acceptance:** migration preserves existing keys; live, boundary-expired, revoked and
  rotated keys are distinguished correctly; the team's key still opens a mailbox whose
  own key expired; invalid TTLs are refused without rotating or creating anything; an
  agent cannot extend its access by rotating or creating a child mailbox.

#### 2. Shared credentials, revocation and an agent disable switch

The existing mailbox has one key hash. Exchanges and leases must add credentials beside
it, never replace that hash or accidentally acquire the team's authority.

- Define one authorization context: team, mailbox, capabilities, credential id, issuer
  trust rule or parent credential, expiry and revocation state. Preserve the structural
  fence that mailbox credentials cannot authenticate to general team endpoints.
- Store derived credentials separately, hashed, with explicit lineage. A child cannot
  outlive or exceed its parent. Check the current mailbox state and parent/trust-rule
  revocation on use, so revocation cannot leave a previously issued child working.
- Bring forward the **basic disable switch** from the Members → Agents view. Disabling
  cuts off primary keys, leases, OAuth grants and sends without deleting the address or
  touching the team. Re-enabling must not resurrect revoked credentials.
- Define a lifecycle table covering rotation, expiry, parent revocation, trust-rule removal,
  disable and teardown, including outstanding long polls and sends already in progress.
  Recheck before releasing newly arrived credentials and before delivery.
- Test the same lifecycle through every authorization path. Keep durable audit records
  after credential secrets and expired credential rows are purged.

#### 3. No permanent key in CI

- `POST /v1/auth/token` exchanges a platform OIDC token for an independent, short-lived
  credential (one hour by default). Use RFC 8693 request and response fields, including
  `subject_token`, `subject_token_type`, `access_token`, `token_type` and `expires_in`.
- **A team trusts a workload, not a provider.** `trusted_workloads` records issuer,
  audience, an exact subject or explicitly constrained pattern, and its grant. Start
  with GitHub Actions and exact repository/branch subjects. Prefer stable repository
  and owner ids as additional constraints where available, so a rename or reclaimed
  repository name cannot inherit trust. Define fork, pull-request, environment and
  reusable-workflow behavior before supporting them.
- Maintain a server-owned allowlist of issuers, algorithms and fixed discovery/JWKS
  locations. Never fetch a caller-supplied issuer, `jku` or `x5u`. Verify the signature,
  exact issuer, intended audience, subject, `iat`, `exp` and `nbf` when present, with
  bounded skew and maximum lifetimes. Bound JWKS caching and refresh on unknown `kid`.
  Rate-limit exchange and test rejected algorithms, wrong claims and key rotation.
- Issued credentials name the trust rule in their lineage. Removing the rule revokes
  existing credentials as well as preventing new exchanges. One-mailbox grants use the
  mailbox authorization path and keep review and limits; they never become team keys.
- The SDK obtains and exchanges GitHub's runner token with `id-token: write` and no
  `POSTBOI_TOKEN`, and caches by issuer, audience, team, workload and grant until shortly
  before expiry. `postboi init` can configure the workflow and trust rule.
- Add Vercel next after verifying its current token contract and Marketplace requirements
  against primary documentation. The Builder.io post's 30 November/January claim is
  unverified and does not establish a Postboi deadline. Cloudflare and GCP are later
  adapters, subject to verifying what workload identity each runtime actually supplies.

#### 4. Leases: a credential for one job

- `POST /v1/mailboxes/:id/leases` accepts `ttl`, `can`, optional sender domains and a job
  label. Cap TTL at a day and the parent's expiry. A lease cannot mint another lease.
  Capabilities are `codes`, `read`, `reply` and `send`, with explicit implications.
- **`codes` grants authentication material.** It includes codes and verification links,
  which may also permit password resets and account recovery. It is less access than
  reading bodies, but does not promise to distinguish login from reset credentials.
  The consent and docs must state this.
- Sender-domain restrictions use authenticated, aligned sender identity, with exact
  domain/subdomain semantics. A forged From header is insufficient. Enforce filtering
  and field projection server-side across wait, lists, single messages, threads, search,
  raw mail, attachments, drafts, account inventory and MCP. Unneeded endpoints are denied;
  a client-side filter is never an access control.
- `await using lease = await box.lease({ ttl: "1h", can: ["codes"] })` revokes on normal
  scope exit; server expiry is the backstop for crashes and lost connections. A long poll
  cannot return credentials after the lease expires or is revoked. `postboi mailbox lease`
  prints a credential for a shell.
- `postboi mcp --lease codes` uses the lease for tool execution. Keep any parent
  credential outside the agent's environment and tool surface; document that an agent
  holding the parent can still mint broader access.
- Store and audit each lease and its parent. Purge expired secrets/rows on a defined
  schedule while preserving audit identity.

#### 5. Limits the agent can't raise

- Per mailbox: `sends_per_day`, `new_recipients_per_day` and `recipient_domains`.
  NULL means unrestricted domains; an empty allowlist means no recipients. Only the team
  or dashboard changes them. No new defaults on existing claimed mailboxes.
- Refuse an over-limit send with 429 `mailbox_limit` before creating a held draft.
  Domain refusals identify the policy and have no fictional reset time.
- **Atomic reservations, not count-then-send.** The Sent log remains the accounting
  evidence, but concurrent requests need a conditional reservation committed with the
  send's idempotency identity. Define failures, retries, ambiguous delivery and midnight
  boundaries so retries cannot double count and parallel sends cannot overspend.
- Enforce again at the shared delivery boundary, including draft approval, forwards,
  dashboard sends, scheduled delivery and general send routes that can use the mailbox's
  From address. Review approval cannot bypass a limit.
- Count all To, CC and BCC recipients. Define normalization, distinctness and what makes
  a recipient new (suggested: never successfully contacted by that mailbox before).
  Reserve new-recipient slots atomically too.
- A limit reached tells the team once per UTC day through a `limits` notification.
  Money remains later: until a mailbox can buy anything, sends are the useful unit.
- Acceptance includes racing sends at the last slot, repeated idempotency keys, a held
  draft approved after limits change, CC/BCC domain bypasses and ambiguous send outcomes.

#### 6. Hosted MCP signed in with OAuth

- Host `mcp.postboi.app` using better-auth's supported authorization-server capabilities,
  verifying the deployed version and plugin support first. Each consent names the team,
  mailbox, capabilities and authentication-material access.
- Implement the applicable MCP authorization discovery and protected-resource metadata,
  authorization code flow with PKCE, strict redirect URI validation, resource/audience
  binding and explicit token lifetimes. Decide whether dynamic client registration is
  needed and bound registration abuse rather than treating registration as trusted.
- OAuth access and refresh grants share credential lineage, mailbox disable and
  revocation semantics. Rotate refresh tokens and detect reuse. Test cross-client,
  cross-resource and cross-mailbox token rejection and consent revocation.
- Complete Members → Agents as the view of credentials, leases, trust rules, limits,
  consent and audit. The basic disable switch already shipped in step 2.

#### 7. Inferred account inventory and teardown

- `mailbox_accounts` records **evidence of a possible account**, not proof of signup or
  a complete register. Use welcome, verification, reset and receipt mail; keep the source
  message, authenticated sender, service identity, first/last seen, signal and confidence.
  Support correction, dismissal and merging. Sender organisational domain alone is not
  a reliable service id: shared mail providers and several services on one domain exist.
- Start with rules in `file_into_mailbox`; use jev only with content checks enabled.
  An unfamiliar reset is an activity signal, not proof of takeover, and does not change
  sender trust. Show the inventory's limitations in the Accounts tab, SDK and MCP tool.
- Keep service home/account-management links separate from message-carried verification,
  recovery and unsubscribe URLs. Those URLs can be credentials; restrict their exposure,
  define retention and redact them from ordinary logs and inventory exports.
- `POST /v1/mailboxes/:id/teardown` (team or dashboard) disables access, revokes primary
  and derived credentials and OAuth grants, removes mailbox trust grants, retires the
  address, and returns an inventory snapshot of what may remain to close elsewhere.
  Capture the snapshot before deletion and make retries safe, with a retrievable result
  if the first response is lost. Define queued sends and retention explicitly.
- Never follow unsubscribe or verification links automatically. Never claim to close
  an external account. `postboi mailbox rm --teardown` prints the safe checklist.

#### Smaller

- Text-message codes on the team's own Twilio number can file into a mailbox later
  (CHANNELS.md). This inherits authentication-material access rules.
- Sign our own `OTP-Token` on mail we send, and settle the disclosure footer/header
  decision when writing those headers.

### What we stay out of

The card and payments, browser sessions and "Sign in with Google", and a general identity
provider. Our ground is the channels an identity is verified and reached through.

### Decisions for implementation

1. `codes` includes verification links and is explicitly authentication-material access.
2. Store issued credentials with expiry and lineage so they can be revoked and audited.
3. The inventory may be on by default with clear provenance and correction, but cannot
   claim completeness or infer account ownership from email alone.
4. Existing claimed mailboxes keep their current unrestricted limits. Suggest limits
   when creating one.
5. Start with optional expiry. Local renewal, workload exchange, leases and OAuth remain
   planned until their own acceptance checks pass.

---

## Decided

- **The brand is agentboi.email.** It is the third site on the Worker, fenced by hostname
  exactly as tempboi.email is, with the same mascot family and the same house style.
  tempboi is the throwaway, agentboi is the address an agent keeps. Registered on
  7 October 2026; `agentboi.com` is taken.
- **A mailbox is a colleague with a narrow desk, not a key with everything.** It holds the
  grant shape a limited member holds today (`scope_kind: email` over its own address,
  `can_send` from its policy, no areas), so the Sent log, the sender predicate, delivery's
  recheck, `may_hear`, the Members page and the audit log all already know what to do with
  it. Its key opens that mailbox and nothing else. Resend's Inboxes run on the team key;
  AgentMail scopes keys per inbox; nobody puts the agent in the members table beside the
  people and in the audit log with them.
- **Born receiving, earns sending.** `POST agentboi.email` gives an address with no account,
  the way tempboi does. Until a person claims it, it receives everything and may write to
  **one address, its owner**, which is how it asks to be claimed. Claimed, it joins the
  owner's team and sends under that team's reputation: the SES tenant, the warm-up ramp and
  jev's review of young senders, all of which exist. This is the unclaimed-account flow
  `init --agent` already runs (migration 0039), with an address attached.
- **An agent can answer anyone, and asks before it starts a conversation.** The default
  policy after claiming is `reply: free, new: hold`: a reply inside a thread the other side
  began goes out, a message to a new recipient waits in the mailbox's held queue until the
  owner approves it. Approval is a push, a line in the dashboard, or **a reply to the email
  that asked**. Nobody ships approval as part of the mailbox; everyone writes a knowledge-base
  article saying "CC a human".
- **Received mail is free, is not counted against sending, and is kept for the life of the
  mailbox** within a storage allowance. Resend counts received mail against the transactional
  quota and keeps it 30 days; Bird keeps 30 days. Inbound is already free and unmetered here.
- **Every message says who is talking.** `trust` on every received message: `owner`,
  `thread` (a reply to something we sent), `known` (on the allowlist), `stranger`, and
  `suspect` when jev's new rubric reads it as instructions aimed at an agent. The quoted
  reply is stripped into `reply_text`. We cannot stop prompt injection; we can make sure the
  agent never mistakes a stranger for its owner.
- **Threads are first class on the wire, and the headers are right.** `thread_id` on every
  message, `In-Reply-To` and `References` written by us on every reply, and `/v1/send`
  learns `in_reply_to` so an API send joins the thread the dashboard already draws.
- **Transport is long polls, webhooks, push and MCP, in that order of newness.** The long
  poll is tempboi's `/wait`, because it gets through the proxies in front of agent sandboxes
  and CI. A hosted MCP server is the one surface Postboi has none of and every competitor
  leads with; it is a phase of its own and covers tempboi and sending too.
- **Subdomains only, never the apex.** A team's mailboxes may live at `reply.<domain>`
  today and at a label of their choosing later (`agents.acme.com`). The apex would mean
  taking over their real mail, which this product does not do and says so.
- **No IMAP, no SMTP, no calendar.** Workers do not accept inbound TCP, and an agent that
  wants IMAP wants a mail client, not an API. An `.ics` attachment is parsed into a
  structured `invite` instead, later.
- **We never charge per received message, and never per mailbox.** No plan counts
  mailboxes; Free is limited to 10 new ones a day to keep farms off the shared domain.

---

## The one-line story

> Give an agent an email address in one call. It reads its mail as JSON, answers in the
> thread, and asks you before it writes to anyone new.

Resend's is "the inbox for agents" (shared inboxes, triage, drafts, assign). AgentMail's is
"the first email provider built for AI agents" (inbox as the primitive, identity on top).
Ours is the colleague: an address that behaves the way a new member of staff would, with a
manager who can see the log.

---

## What the others shipped

The detail and the links are in [Appendix A](#appendix-a--the-field-in-october-2026). The
shape, for the comparison:

|                                  | Resend Inboxes (private beta)       | AgentMail                             | Bird Agent Mailboxes          | Nylas Agent Accounts        | Cloudflare Email Service    | **agentboi.email (planned)**                              |
| -------------------------------- | ----------------------------------- | ------------------------------------- | ----------------------------- | --------------------------- | --------------------------- | --------------------------------------------------------- |
| Address with no account, no DNS  | No: your verified domain only       | Yes, `@agentmail.to`                  | Yes, `abc123@inbox.ai`        | Yes, `@appslug.nylas.email` | No: your zone               | **Yes, `name-k3f9@agentboi.email`, one `POST`**           |
| Own domain                       | Required                            | MX + SPF + DKIM + DMARC               | Paid plans                    | Yes                         | Yes                         | **`reply.<domain>` today, own label later, never apex**   |
| Threads                          | Yes                                 | Yes                                   | Yes                           | `thread_id` on webhook      | No, you build it            | **Yes, the Received log's own `thread_id`**               |
| Threading headers documented     | No (`message_id: null` in examples) | Yes                                   | Not seen                      | Yes                         | HMAC reply addresses        | **Yes, written by us on every reply**                     |
| Reply in thread from the mailbox | Yes                                 | Yes                                   | Yes                           | Yes                         | Yes                         | **Yes, `/v1/send` with `in_reply_to`**                    |
| Long poll / wait for a message   | No                                  | No (WebSockets)                       | Not seen                      | No                          | No                          | **Yes, tempboi's `/wait`, 90s, cursor-safe**              |
| Code and link extraction         | No                                  | No                                    | No                            | CLI command                 | No                          | **Yes, on arrival, as today**                             |
| Per-mailbox key                  | No, team key                        | Yes, inbox and pod keys               | `mailbox` scope on a team key | Grant per account           | Worker binding              | **Yes, and the mailbox is a scoped member**               |
| Approval before a send           | Drafts, a person sends              | KB article: CC a human                | Not seen                      | No                          | No                          | **Held queue, approve by push, dashboard or reply**       |
| Who-is-talking on inbound        | No                                  | Allow and block lists                 | Spam / blocked folders        | No                          | No                          | **`trust` on every message, jev-read, quoted text split** |
| Reputation isolation             | Team domain                         | Shared pool, no warm-up               | Shared                        | Shared                      | Published IP ranges, shared | **Own domain for agent mail, SES tenant per team, ramp**  |
| Audit of what the agent did      | Dashboard activity                  | Pod metrics                           | Not seen                      | Not seen                    | Your logs                   | **The team's audit log, agent beside the people**         |
| Received mail counted as sends   | Yes                                 | Monthly message quota                 | Not seen                      | Monthly quota               | Inbound free                | **No, free and unmetered**                                |
| Retention                        | 30 days on Free                     | Storage per plan, 24h expiry optional | 30 days                       | Storage per plan            | Yours                       | **Life of the mailbox, storage per plan**                 |
| MCP                              | Remote only, beta                   | Remote, 37 tools, OAuth               | Full toolset                  | No                          | Email MCP server            | **Phase 4: local `postboi mcp` and hosted**               |
| Price                            | Not announced                       | $0 / $20 / $200                       | Free for generated addresses  | Free tier, paid unpublished | 3,000 then $0.35 per 1,000  | **No per-mailbox price or count; Free makes 10 a day**    |

### What nobody does well yet, which is the opening

From the research, the gaps every thread complains about and no vendor closes:

1. **Approval as part of the product.** Human-in-the-loop is drafts (Resend) or a knowledge
   base article (AgentMail). Nobody has a hold queue with approve or deny by push or by
   reply, and an audit of who approved.
2. **Inbound safety as a product.** One small vendor scans for injection. Nobody labels a
   message with who it is from in trust terms, or quarantines a stranger's instructions.
3. **Long poll plus extraction plus identity in one place.** Lumbox and MailSlurp have the
   wait and the OTP primitives, AgentMail and Nylas have the identity and the threads;
   nobody has all three with published limits. We have the first two in production.
4. **Deliverability for low-volume irregular senders.** Everyone shares a pool; none
   publishes per-tenant isolation or warm-up for agent cadence. We already run a tenant per
   team and a 7-day ramp.
5. **Recipient-side trust.** No header or convention says "an agent sent this, for this
   person". It is an open decision below; it is not where the product leads.

---

## What we already have

Nearly every piece exists, built for something else. The feature is mostly joining them.

| Piece                                       | Where                                                                                              | What it gives the mailbox                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A second site on the Worker, fenced by host | `src/library/tempboi.ts`, `hooks.ts` `reroute`, `hooks.server.ts`, `wrangler.jsonc`                | agentboi.email is the same shape with a different host list and route table                            |
| Mail arriving with no account lookup        | `/v1/inbound` branches on `TEMP_DOMAIN` before `account_for_key`                                   | `AGENT_DOMAIN` branches the same way                                                                   |
| Receiving on a team's own domain            | SES on `reply.<domain>` → `/v1/sns/inbound`, already files into a temp inbox when one matches      | Files into a mailbox when one matches, same test                                                       |
| Unclaimed accounts                          | Migration 0039, `POST /api/cli/provision`, `claim_code`, `sandbox_payload`, `UNCLAIMED_TTL_DAYS`   | An unclaimed mailbox is an unclaimed account with an address; claiming is the existing `/claim/<code>` |
| Threads                                     | `inbound_messages.thread_id`, `reference_ids`, `ingest_inbound`'s In-Reply-To and References match | Every mailbox message already has a thread                                                             |
| A reply that threads                        | The Received page's `reply` action: `reply_from`, `reply_references`, `thread_id` on the send      | Lift it into `/v1/send` as `in_reply_to`                                                               |
| Sending from an inbound subdomain           | `domains.verified()` includes active `inbound_domain`s, so `from_error` passes                     | `agent@reply.acme.com` can send today                                                                  |
| Sender-scoped members                       | `member_message_access` (`scope_kind: email`), `message_account_for`, `sender_predicate`, `allows` | The mailbox's scope, computed from its row rather than stored in that table                            |
| Long polling                                | LiveFeed `x-live-wait`, tempboi's `messages?wait=` (25s) and `/wait` (90s), cursor by seq          | The mailbox API is the inbox API with a `mbx_` in place of a `tmp_`                                    |
| Codes and links                             | `extract_codes`, `extract_links` in `temp_ingest.ts`                                               | Run on every mailbox message                                                                           |
| Sender face and BIMI                        | `sender_face.ts`                                                                                   | The dashboard's thread view wears it                                                                   |
| Content judgement                           | jev: `review_inbound` (junk), `jev_rules.ts` question sets, `review` JSON stored raw               | A third question set: is this mail addressed to an agent and trying to steer it                        |
| A send that waits                           | Scheduled rows: `queue_response`, `queue_retry`, the dispatcher's due-loop                         | A held send is a scheduled row with no time and an approval                                            |
| Telling a person                            | `notify()`, the catalogue in `notify_events`, push and email                                       | One new event, `approvals`                                                                             |
| Webhooks                                    | `webhook_rules.ts` catalogue, standard-webhooks signing, 6 attempts                                | `mailbox.received`, `mailbox.sent`, `mailbox.held`, `mailbox.approved`                                 |
| The audit log                               | `audit_request.ts` writes every action and API call                                                | The agent's doings, with the agent named as the actor                                                  |
| Push to a browser                           | `temp_push.ts`                                                                                     | Follow a mailbox from the extension or the page                                                        |
| The SDK's inbox                             | `postboi/inbox`: `Inbox`, `Mail`, `wait`, `watch`, `attach`, `await using`                         | `postboi/mailbox` extends the same classes                                                             |
| The CLI's inbox                             | `postboi inbox new                                                                                 | watch                                                                                                  | wait | read | ls  | rm`, `--exec`, `--forward`, `--env` | `postboi mailbox` with the same verbs plus `reply`, `send`, `approve` |
| The agent on-ramp                           | `init --agent`, `AGENT_PROMPT`, `skills/postboi`, `/llms.txt`, `agents.svx`                        | `init --agent` also mints the mailbox; the skill gets a mailbox section                                |

What does not exist, and is the work: a `mailboxes` table and its policy, a mailbox-scoped
key, `in_reply_to` on `/v1/send`, `thread_id` on API sends, a cursor and a long poll on the
team's received API, attachment download over the API, the held queue and approvals, jev's
third rubric, a Mailboxes page, an agentboi.email site, `postboi/mailbox`, `postboi
mailbox`, and an MCP server anywhere.

---

## The target API

### One call, no account

```bash
curl -X POST agentboi.email -d owner=you@acme.com
```

```
orders-k3f9@agentboi.email
key:    pb_…            # opens this mailbox and nothing else
claim:  https://agentboi.email/claim/8f2k…   # also emailed to you@acme.com
until claimed: receives anything, writes only to you@acme.com, 10 a day
```

`owner` is optional. Without it the mailbox can receive and cannot send at all, and it is
purged with its account after `UNCLAIMED_TTL_DAYS` of nobody claiming it. With it, the
mailbox's first act can be to email its owner the claim link itself, which is the whole
onboarding: the agent asks to be hired.

### In code

```ts
import { mailbox } from "postboi/mailbox"

// create or attach by name under POSTBOI_TOKEN (a team key), or attach by a mailbox key
const box = await mailbox("support")

for await (const mail of box.watch()) {
	if (mail.trust === "suspect") continue // jev read it as instructions aimed at an agent
	const answer = await agent.run(mail.reply_text, { thread: mail.thread_id })
	await box.reply(mail, { body: answer }) // In-Reply-To and References are ours to write
}

// a new conversation: held until the owner approves, unless the policy says otherwise
const { id, status } = await box.send({ to: "ada@example.com", subject: "Hello", body: "…" })
// status: "sent" | "held" | "refused"
```

`mailbox()` returns a `Mailbox`, which is tempboi's `Inbox` with `send`, `reply`,
`threads`, `thread(id)`, `held`, `policy()` and `attachments`. `Mail` grows `thread_id`,
`trust`, `reply_text`, `attachments[].url`, and keeps `code`, `codes`, `link`, `links`,
`auth`. `temp()` is unchanged: a temp inbox is a mailbox with a lifetime and no sending, and
the two share one wire shape and one client.

### From the terminal

```bash
bunx postboi mailbox new support --owner you@acme.com   # prints the address and the claim link
bunx postboi mailbox watch support                      # each mail as it lands
bunx postboi mailbox wait support --code                # the one-time code and nothing else
bunx postboi mailbox reply <id> --body "On it."         # threads correctly
bunx postboi mailbox held                               # what is waiting on a person
bunx postboi mailbox approve <id>                       # the owner's key only
```

The same `--exec`, `--forward`, `--json` and `--env` the inbox commands have, because an
agent in a sandbox reaches for the CLI before it reaches for an SDK, and a CLI costs it
fewer tokens than an MCP tool schema.

### Over MCP

```json
{ "mcpServers": { "postboi": { "command": "npx", "args": ["postboi", "mcp"] } } }
```

or the hosted `https://mcp.postboi.app/mcp` with a key. A dozen tools, not forty:
`mailbox_create`, `mailbox_wait`, `mailbox_read`, `mailbox_threads`, `mailbox_reply`,
`mailbox_send`, `mailbox_held`, `mailbox_approve`, `temp_inbox_create`, `temp_inbox_wait`,
`email_send`, `message_get`. Every tool result that carries a stranger's text wraps it in a
data boundary and names its `trust`, because the MCP surface is where an injected
instruction would otherwise read as one.

---

## How it works

### The ladder of trust

A mailbox climbs three rungs, and each rung is something that already exists:

| Rung           | How you get there                                                | Receive  | Send                                                                                       | Lives                                                           |
| -------------- | ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **Unclaimed**  | `POST agentboi.email`, no account                                | Anything | To `owner` only, 10 a day, plain text footer saying what it is. Nothing without an `owner` | In an unclaimed account; purged after `UNCLAIMED_TTL_DAYS` idle |
| **Claimed**    | A person opens the claim link, signs in, picks a team            | Anything | Under the policy: replies free, new recipients held, on the team's quota and ramp          | In the team, for good                                           |
| **Own domain** | The team adds `support@reply.acme.com` (or its own label, later) | Anything | As claimed, from their own domain's reputation                                             | In the team                                                     |

Unclaimed sending to one address is the piece that makes "no account" safe. Every HN thread
about agent email is the same complaint: an address nobody vouched for, sending to anybody.
Here the only person an unclaimed agent can write to is the person who gave it its address,
and the only thing worth saying is "claim me". AgentMail's onboarding ramp is the nearest
thing (a human's email, OTP, then 3 recipients in an hour); ours reuses the account claim
that already gates `init --agent`, so there is one notion of "a human has vouched" in the
system rather than two.

After the claim, sends from the mailbox are ordinary team sends: `/v1/send` with the
mailbox key, `from` the mailbox's address, counted against the plan, metered, suppressed,
ramped (`WARMUP_DAILY`, `UNVERIFIED_DAILY` where it applies) and reviewed by jev on the
shared lane in a young account, exactly as a composer send is. Nothing new is written for
reputation; the mailbox inherits the team's.

### A mailbox is a colleague

The row is `mailboxes` (below), and the key is an `api_keys` row with `scope_kind:
'mailbox'` and `mailbox_id`, minted with the mailbox and rotatable. When `bearer_account`
meets one, it resolves a **mailbox session**: the account, plus a scope of exactly the
shape `message_account_for` hands a limited member (`scope_kind: "email"`, `scope_value:
[address]`, `can_send` from the policy, no areas). Everything downstream of that scope
already works: the sender predicate on reads, `from` checks on sends, delivery's recheck,
`may_hear` for notifications. Client workspace keys are refused on the mailbox routes as
they are on `/v1/inboxes`; a mailbox in a client space is Later.

What the team sees:

- **Members** lists mailboxes under **Agents**, beside the people, with their address, the
  sentence `describe_access` would say ("Reads and sends as support@…"), when they last
  acted, and Revoke. Revoking revokes the key; the mailbox keeps receiving until deleted.
- **The audit log** writes the agent as the actor (`mailbox_id` on `audit_events`, read
  back as "support@agentboi.email (agent)"), so "what did the agent do on Tuesday" is a
  filter on a page that exists.
- **The Sent log and the Received log** show its mail as they show anyone's; the thread view
  is the Received page's.

### Threads and replies, on the wire

- Every received message has `thread_id` already. The mailbox API exposes
  `GET …/threads` (cursor, folder, `q`), `GET …/threads/:id` (the merged inbound and sent
  rows the dashboard's thread view already builds), and `thread_id` on every message.
- **`/v1/send` learns `in_reply_to: "<inbound id>"`** (and `mailbox: "<id or address>"`).
  The route resolves the inbound row, scoped to the account and the mailbox, writes
  `In-Reply-To` and `References` from `reply_references`, defaults `to` to the sender's
  Reply-To or From, defaults `subject` to `Re: …`, sets `from` to the address the mail
  arrived at, and **passes `thread_id` to `messages.log`**, which `/v1/send` never did.
  That closes the gap where an API reply with hand-written headers never joined the
  dashboard's thread. The SDK's `SendOptions` gets `in_reply_to` the same day.
- Postboi writes the headers, never the agent. Resend's docs leave threading undocumented and
  show `message_id: null`; that is the detail an agent gets wrong on its own.

### The held queue

Every mailbox has a `policy`:

```ts
{
	reply: "free" | "hold",          // inside a thread the other side began
	new: "free" | "hold" | "never",  // a recipient this mailbox has never written to
	allow: string[],                 // addresses and @domains that are always free
	daily_cap: number,               // sends a day, under the team's own caps
	footer: boolean,                 // the one-line disclosure under its mail
}
```

Defaults after claiming: `reply: "free"`, `new: "hold"`, `allow: [owner]`, `daily_cap:
100`, `footer: true`. The owner loosens it on the Mailboxes page or over the API.

A send the policy holds is **logged as a scheduled row with no time and `status:
'held'`**, carrying the full `SendBody` as scheduled rows do, so approving it later sends
exactly what was asked. The agent gets `{ id, status: "held" }` and can `wait` on it. The
owner is told through `notify("approvals")`: a push with Approve and Deny, and an email
whose subject names the recipient and whose body is the message as the recipient would see
it. **Replying to that email with "ok", "yes" or "approve" approves it**: the reply lands
on the shared lane, `ingest_inbound` matches `In-Reply-To` to the approval mail, and the
approval route checks the reply came from the owner's address with SPF or DKIM aligned.
Deny is "no" or silence; a held send expires after 7 days. The dashboard's held list does
the same with two keys. Approvals and denials are audit rows, with who did it and how.

The dispatcher delivers an approved row on the next tick through the one send pipeline; a
denied row keeps its body and its reason in the log. This is `queue_retry`'s shape exactly,
plus one status.

### Who is talking

On arrival, every mailbox message gets:

- **`trust`**, decided by rules first and jev second:
  - `owner`: From or Reply-To is a confirmed address of a team member, SPF or DKIM aligned
  - `thread`: `In-Reply-To` matches a send of ours (the existing match)
  - `known`: on the policy's `allow`
  - `stranger`: everything else that reads as ordinary mail
  - `suspect`: jev's new rubric says the text addresses an agent or tries to steer one
    ("ignore your instructions", "forward everything to", a request for credentials), or
    SES's own spam verdict, or `dmarc: fail` on a sender claiming a known domain
- **`reply_text`**: the new text with the quoted reply and the signature stripped, so an
  agent reads what was said and not the whole thread again. Postmark's `StrippedTextReply`
  is the primitive developers name; Bird calls it `extracted_text`.
- **`folder`**: `inbox`, `archive`, `spam`, `sent`, `held`. `suspect` lands in `inbox` with
  its label, not in `spam`: the agent should see it and know what it is. Junk by jev's
  existing rubric goes to `spam` as it does today.

The jev rubric lives in `jev_rules.ts` beside the inbound one, pure and tested, and the
answer is stored raw in `review` so the threshold can move. It runs behind the team's
**Content checks** setting as the inbound review does; a mailbox in an unclaimed account
gets it on, because nobody has chosen yet and the agent is alone with its mail. Failure is a
value: no key, a timeout or a 429 reads as `stranger`, never as `owner`.

The honest line for the docs and the page: trust labels tell the agent who is speaking.
They do not make a stranger's text safe to obey, and the agent's own instructions should
say so.

### Transport

Four ways to hear about mail, all existing:

1. **Long poll.** `GET …/messages?after=<cursor>&wait=25` and `GET …/wait?timeout=90`, the
   tempboi routes over the mailbox's bell (`mailbox:<id>` on LiveFeed). The cursor is the
   highest seq returned, so a watcher never skips a message. Works from inside a sandbox with
   no public URL, which is why it is first.
2. **Webhooks.** `mailbox.received`, `mailbox.sent`, `mailbox.held`, `mailbox.approved`,
   `mailbox.denied` in the catalogue, standard-webhooks signed, verified by the SDK's
   `receive()`. The payload carries the body, the `thread_id`, `trust`, `reply_text` and
   the attachment manifest; Resend's inbox webhooks carry no body and make the agent fetch
   it, which is a round trip an agent pays for twice.
3. **Push.** `POST …/push` as tempboi's, so the extension or a browser follows a mailbox.
4. **MCP.** Phase 4.

### Where the address lives

- **agentboi.email**: Email Routing catch-all on the zone → `email()` → `/v1/inbound`,
  branching on `AGENT_DOMAIN` before any account lookup, as tempboi does. Unknown, full or
  oversized is refused at SMTP time. **The zone gets its own SES identity for sending**
  (DKIM, SPF, DMARC `p=reject`), so agent mail never shares `send.postboi.email`'s
  reputation with customers' transactional mail, and vice versa.
- **`reply.<domain>`**: works today for receive and send. A team creates
  `support@reply.acme.com` and the SES inbound path files into the mailbox when one matches,
  as it does for a team temp inbox.
- **A label of their own** (`agents.acme.com`, `ai.acme.com`): Phase 5. `inbound_subdomain`
  hardcodes `reply`, `domains.inbound_domain` is single-valued with a UNIQUE index, and SES
  wants an identity per subdomain. It is a domains-model change and deserves its own slice.
- **Never the apex.** The MX would take over their real mail. The page says so, in one line,
  and offers the subdomain.

### Reputation

An agent's cadence is irregular and low-volume, which is the worst shape for a shared pool
and the reason Cloudflare's launch thread filled with "agent mail is spam by definition".
The answer is already in the product: a tenant per team at SES (bounce and complaint rates
measured per team, auto-pause per team), the warm-up ramp, the unverified-domain daily cap,
jev's review of young senders on the shared lane, suppression on every bounce and complaint.
Add to that: unclaimed mailboxes write to one address; a claimed one asks before new
recipients; the agent domain's DKIM is its own. Nothing here is new machinery.

### The dashboard

- **Messages → Mailboxes**: the list (address, name, trust of the last message, held count,
  key prefix, last seen), New mailbox (on agentboi.email or a verified `reply.` domain), and
  one mailbox's page with four tabs: **Threads** (the Received page's thread view, filtered
  to the address, folders down the side), **Held** (approve and deny, the message as the
  recipient would see it), **Policy** (the five fields above, as a sentence where it can be:
  "Replies go out; new conversations wait for you"), and **Key** (rotate, the `mailbox()`
  line, the CLI line, the MCP snippet).
- **Members → Agents**, as above.
- **Audit**: a What filter for the agent's doings and a Who row per mailbox.
- A new area `mailboxes` in `AREAS`, `edit` meaning managing them; Received's area covers
  reading. Owners and whole-team members have it; a limited member gets it by grant.

### agentboi.email, the site

The house style and tempboi's bones: the poster headline with the hot word, the drawn slip
with an address on it, Boi leaning on the card. The card is the `POST` and the key, the
terminal strip is the `mailbox` command, the FAQ is the API, `/llms.txt` is the whole thing
for an agent, `/claim/<code>` is the claim page, and `/<local>` with the key after the `#` is
a reader for an unclaimed mailbox so a person can look before they claim. A claimed mailbox
lives in the dashboard, and the reader redirects there.

No cookie banner, no Analytics, no service worker, as on tempboi.

### Pricing

**Settled October 2026: no count.** Mailboxes are not a line item and not a plan limit.

| Cost               | Grows with                             | Size                                                     |
| ------------------ | -------------------------------------- | -------------------------------------------------------- |
| An idle mailbox    | Nothing                                | One D1 row                                               |
| A received message | Mail volume                            | A Worker request, a few D1 writes, the raw message in R2 |
| Kept mail          | Storage over time                      | R2 at about $0.015 a GB-month                            |
| An agent watching  | Hours with a long poll open            | Up to about $4 a month for one mailbox watched all day   |
| Content checks     | Received volume, when the team opts in | jev, billed on input tokens                              |
| Sending            | Sends                                  | Already the plan's quota                                 |

None of that grows with how many mailboxes a team has, so counting them would charge for
the wrong thing, and "never per mailbox" beats every competitor that bills per inbox. The
one cost a count would guard is the shared domain's reputation against account farms,
and a creation rate does that better: Free may make 10 a day, a paid plan has no limit,
and 50 in a day on any plan alerts the operators. If storage starts to matter, a storage
allowance per plan is the lever.

Unclaimed mailboxes are free and rate-limited per IP as provisioning is
(`PROVISION_DAILY_IP_LIMIT`), one mailbox per unclaimed account.

---

## Data model

The sketch below was the plan. What shipped is `migrations/0091_mailboxes.sql`: a
`mailboxes` table with the key hash on it, and `mailbox_messages` beside
`inbound_messages`. The held-queue and thread-state columns are still Phase 2 and later.

```sql
-- 008x_mailboxes.sql
CREATE TABLE mailboxes (
	id TEXT PRIMARY KEY,                 -- mbx_…
	account_id TEXT NOT NULL REFERENCES accounts(id),   -- an unclaimed account until claimed
	address TEXT NOT NULL UNIQUE,        -- lowercase, untagged; plus-tags file here
	name TEXT,                           -- what the team calls it
	owner_email TEXT,                    -- the one address an unclaimed mailbox may write to
	policy TEXT NOT NULL,                -- JSON, see above
	folder_counts TEXT,                  -- JSON cache for the list page
	message_count INTEGER NOT NULL DEFAULT 0,   -- the seq allocator, as temp_inboxes
	storage_bytes INTEGER NOT NULL DEFAULT 0,
	last_seen_at TEXT,
	created_at TEXT NOT NULL,
	deleted_at TEXT
);

ALTER TABLE api_keys ADD COLUMN mailbox_id TEXT REFERENCES mailboxes(id);
-- scope_kind gains 'mailbox' beside 'account' and 'client'

ALTER TABLE inbound_messages ADD COLUMN mailbox_id TEXT;
ALTER TABLE inbound_messages ADD COLUMN seq INTEGER;          -- per mailbox, the cursor
ALTER TABLE inbound_messages ADD COLUMN trust TEXT;           -- owner|thread|known|stranger|suspect
ALTER TABLE inbound_messages ADD COLUMN reply_text TEXT;
ALTER TABLE inbound_messages ADD COLUMN codes TEXT;           -- JSON, as temp_messages
ALTER TABLE inbound_messages ADD COLUMN links TEXT;
ALTER TABLE inbound_messages ADD COLUMN raw_key TEXT;         -- R2, the .eml, as temp_messages
CREATE UNIQUE INDEX inbound_mailbox_seq ON inbound_messages (mailbox_id, seq) WHERE mailbox_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN mailbox_id TEXT;              -- a send from a mailbox
-- messages.status gains 'held'; approval columns:
ALTER TABLE messages ADD COLUMN held_reason TEXT;             -- new_recipient|policy_never|daily_cap
ALTER TABLE messages ADD COLUMN approved_at TEXT;
ALTER TABLE messages ADD COLUMN approved_by TEXT;             -- user id, or 'reply:<inbound id>'
ALTER TABLE messages ADD COLUMN denied_at TEXT;

CREATE TABLE mailbox_threads (
	mailbox_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	folder TEXT NOT NULL DEFAULT 'inbox',
	labels TEXT,                          -- JSON string array
	read_at TEXT,
	last_at TEXT NOT NULL,
	PRIMARY KEY (mailbox_id, thread_id)
);

ALTER TABLE audit_events ADD COLUMN mailbox_id TEXT;
```

Why messages live in `inbound_messages` and `messages` rather than tables of their own: the
thread view, the Received and Sent logs, exports, webhooks, `notify`, the audit log, the
sender predicate and jev all read those two tables. A mailbox message is a team message
with a `mailbox_id`. tempboi's `temp_messages` stays separate because a temp inbox has no
account and nothing of the team's should see it; a claimed mailbox is the opposite. The
columns tempboi has that `inbound_messages` lacks (`seq`, `codes`, `links`, `raw_key`) move
across, and `temp_ingest.ts`'s extractors are called from `ingest_inbound` when a mailbox
matched.

Bodies keep the existing caps in D1 and the raw message goes to R2 so nothing is lost;
attachments are already in R2 through `store_attachments`, and the mailbox API grows the
download endpoint the team's `/v1/inbound` never had (served `sandbox`, as tempboi's).

---

## Phases

### Phase 0: the ground (days)

Built, except the zone and SES steps in [Before launch](#before-launch).

- Register `agentboi.email`. Zone on Cloudflare: Email Routing catch-all to the Worker, an
  SES identity in the sending region with DKIM, SPF, DMARC `p=reject`, `custom_domain`
  entries in `wrangler.jsonc` for the apex and `www`, the `llms.txt` and `sitemap.xml`
  renames in `inject_cron.ts`.
- `src/library/agentboi.ts` (client-safe: hosts, route table, `AGENT_DOMAIN`, the key
  prefix stays `pb_` since it is an API key), `reroute` and `handle` additions.
- Decide the two open pricing numbers below and write the page's tier data.

### Phase 1: a mailbox that receives, reads and replies (app ~2 weeks, SDK ~4 days)

Built, with the changes in [Where it parted from the plan](#where-it-parted-from-the-plan).
The list below is the original plan, kept for what is still to do.

**postboi-app**

- Migration above (mailboxes, key scope, the inbound columns, `thread_id` on API sends).
- `POST agentboi.email` and `POST /v1/mailboxes`: no bearer mints an unclaimed account
  through `provision_unclaimed` plus the mailbox and its key; a team bearer creates in the
  team, on agentboi.email or a verified `reply.` domain (`own_domain`'s test).
- `/v1/inbound` branches on `AGENT_DOMAIN`; `/v1/sns/inbound` files into a matching
  mailbox; `ingest_inbound` sets `mailbox_id`, `seq`, `codes`, `links`, `raw_key`,
  `reply_text`, rule-based `trust` (jev's rubric is Phase 3), and rings `mailbox:<id>`.
- The mailbox API: `GET /v1/mailboxes`, `GET|PATCH|DELETE /v1/mailboxes/:id`,
  `…/messages` with `after`, `wait`, `folder`, `from`, `subject`, `…/wait`,
  `…/messages/:id`, `…/messages/:id/raw`, `…/messages/:id/attachments/:n`, `…/threads`,
  `…/threads/:id`, `PATCH …/threads/:id` (folder, labels, read), `…/keys/rotate`. The
  tempboi routes are the template; most of the handlers are shared.
- Mailbox sessions in `api_auth.ts`; the scope through `message_account_for`.
- `/v1/send`: `mailbox` and `in_reply_to`; `thread_id` to `messages.log`; unclaimed
  sending to `owner_email` only, with the footer; the policy's `new: never` refused with a
  sentence. (Holding is Phase 2; Phase 1's `new` default is `free` for claimed mailboxes
  and the page says Phase 2 is coming. Or ship Phase 1 and 2 together: see decisions.)
- Webhooks `mailbox.received`, `mailbox.sent`.
- Dashboard: Mailboxes list and page with Threads and Key tabs; Members → Agents; audit
  actor.
- agentboi.email: the page, the claim page, the reader, `/llms.txt`.
- Admin: live mailboxes, delete, as Temp inboxes.

**postboi (SDK)**

- `postboi/mailbox`: `mailbox()`, `Mailbox extends Inbox`, `Mail` widened; `SendOptions`
  gains `in_reply_to` and `mailbox`; `receive()` learns the new events; `WebhookEvent`
  gains `thread_id`, `trust`, `reply_text`, `attachments`.
- `postboi mailbox new|ls|watch|wait|read|reply|send|rm|key`; `init --agent --mailbox`
  mints one with the project; `sync` types mailbox names.
- Docs: `mailbox.svx` (new), `agents.svx` gains "Have an address", `temp-inbox.svx` points
  across, `compare.svx` rows, `rest-api.svx`, the skill's Receiving section, `products.ts`.
- CHANGELOG `## Unreleased`. Minor bump.

### Phase 2: the held queue (app ~1 week, SDK ~2 days)

- `policy` enforced in `/v1/send`: `held` rows, `held_reason`, the `approvals` event in
  the notifications catalogue, the approval email (a `letter`, with the message framed as
  the recipient sees it), approve-by-reply through `ingest_inbound`, the dashboard's Held
  tab and Policy tab, `POST /v1/mailboxes/:id/held/:msg/approve|deny` for the owner's key,
  `GET …/held` for the agent, `mailbox.held|approved|denied` webhooks, audit rows.
- SDK: `box.send` returns `status`, `box.held()`, `box.approve(id)` (team key only),
  `postboi mailbox held|approve|deny`.

### Phase 3: who is talking (app ~1 week)

- jev's third rubric in `jev_rules.ts`, `review_mailbox` beside `review_inbound`, `suspect`
  written from it, the Content checks copy. SES spam verdict and DMARC alignment folded into
  the rule layer. `reply_text` quality pass against a corpus of real replies (Gmail, Outlook,
  Apple Mail quoting styles), tested directly.
- `trust` in the thread view as a label with the sentence behind it (a `Tip`).
- The disclosure footer and header (open decision 4).

### Phase 4: MCP (SDK ~1 week, app ~3 days)

- `postboi mcp` in the SDK: stdio, `@modelcontextprotocol/sdk`, the dozen tools above, keyed
  by `POSTBOI_TOKEN` or a mailbox key, with tempboi and sending alongside mailboxes so one
  server covers "email for agents" whole. Tool results wrap third-party text and name
  `trust`.
- Hosted `mcp.postboi.app/mcp` on the Worker: streamable HTTP, Bearer key now, OAuth later.
  Plugin manifests for Claude Code, Cursor and Codex; `agents.svx` and the skill point at
  it; `/llms.txt` lists the tools.

### Phase 5: their own label, and the rest (later)

- `agents.<domain>`: `inbound_subdomain` takes a label, `inbound_domain` becomes a table, an
  SES identity per subdomain, the Domains page offers it.
- Agent-to-agent: two agentboi addresses deliver internally, instantly, with no SES hop.
- Drafts for hand-off: a held row an agent writes for a person to edit and send, which is the
  Received page's scheduled reply with no time.
- `.ics` into `invite`; attachment text extraction for PDFs; labels in the API beyond
  folders; mailboxes in client workspaces; money budgets per mailbox on paid plans.

**Effort, whole:** about 5 weeks in `postboi-app` and 2.5 in the SDK across Phases 0 to 4.
Nothing external blocks Phase 1 beyond the domain and the zone.

---

## Risks

| Risk                                                            | Mitigation                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent mail hurts customers' deliverability                      | Its own domain and DKIM, a tenant per team, the ramp, held new recipients, unclaimed writes to one address. Review the tenant metrics after launch |
| Free unclaimed mailboxes as a spam receiving service            | Same per-IP limits as provisioning, `MESSAGE_CAP`-style caps, purge on `UNCLAIMED_TTL_DAYS`, `abuse@` on the page, operators' Admin list           |
| Prompt injection through the mailbox reads as a Postboi failure | `trust` and `suspect` are labels, said plainly as labels; the skill and the MCP tool descriptions tell the agent what to do with a stranger's text |
| Approve-by-reply is spoofed                                     | Owner's address, SPF or DKIM aligned, `In-Reply-To` to the exact approval mail, one-use, audit row. Push and dashboard are the stronger paths      |
| `inbound_messages` grows columns for a subset of rows           | NULL for team mail; partial indexes; the alternative (a third messages table) forks every reader                                                   |
| D1 body caps lose content                                       | The raw `.eml` in R2 for every mailbox message, `…/raw` to fetch it                                                                                |
| Email Routing's 25 MB and `/v1/inbound`'s request size          | Refuse oversized at SMTP as tempboi does; the page says the cap                                                                                    |
| Long polls on LiveFeed at scale                                 | One DO per mailbox bell as tempboi; 25s and 90s caps hold; webhooks for anything busy                                                              |
| Resend ships GA with a price before Phase 1 lands               | Ship Phase 1 with Phase 2's default in place of a bare "free" new-send; the held queue is the story, the inbox is table stakes                     |

---

## Open decisions

1. **Phase 1 and 2 together or apart?** Apart ships an address sooner; together ships the
   story. Lean: together, with Phase 1's dashboard trimmed, because a claimed mailbox that
   can write to anyone on day one is the thing every competitor is criticised for.
2. **Mailbox counts and storage per plan.** Settled: no count, a daily creation limit on
   Free (see Pricing). A storage allowance is still open, and only if storage turns out to
   matter.
3. **Does a mailbox in an unclaimed account share tempboi's `temp_messages` until claimed?**
   No: it is an unclaimed _account_, so its mail is team mail from the first message and
   nothing moves on claim. Confirm `inbound_messages.account_id` on an unclaimed account
   causes no reader trouble (the Received page is never reached unclaimed).
4. **Disclosure.** A footer line on every send from a mailbox (`Sent by an agent for
   acme.com. Reply to reach a person.`), on by default and switchable per policy, plus a
   header. No header is standard; the IETF drafts are individual and unadopted. Lean: the
   footer on, the header as `X-Agent-Mailbox: <address>` and nothing cleverer until a
   convention exists.
5. **Should an unclaimed mailbox with no `owner` exist at all?** It can only receive, which
   is tempboi with a longer life. Lean: yes, because the agent may not know its owner's
   address yet, but it purges at `UNCLAIMED_TTL_DAYS` like any unclaimed account.
6. **OAuth on the hosted MCP server.** Bearer key first. OAuth means better-auth as an
   authorization server for third-party clients, which is its own slice.
7. **`reply_text` by rules or by jev.** Rules first (quote markers, `On … wrote:`,
   signature delimiters), jev where rules fail, since a wrong strip is worse than none.

---

## Where the work lives

- **postboi-app**: `src/library/agentboi.ts`, `src/library/server/mailboxes.ts` (rows),
  `mailbox_rules.ts` (pure: policy, trust rules, address minting, caps),
  `mailbox_api.ts` (shared with `temp_api.ts` where the handlers are the same),
  `routes/v1/mailboxes/**`, `routes/agentboi/**`, the `/v1/inbound` and `/v1/sns/inbound`
  branches, `ingest_inbound`, `/v1/send`, `api_auth.ts`, `jev_rules.ts`, `notify_events`,
  `webhook_rules.ts`, `member_scope.ts` (the area), `audit_events`, the dashboard pages
  under `messages/mailboxes`, Members → Agents, Admin → Mailboxes, the migration.
- **postboi**: `src/library/mailbox.ts` (export `postboi/mailbox`), `src/library/temp_inbox.ts`
  widened, `src/cli/mailbox.ts`, `src/cli/mcp.ts`, `SendOptions`, `webhooks/postboi.ts`,
  `skills/postboi/SKILL.md`, `src/site/content/docs/mailbox.svx` and the pages named above,
  `src/site/config/products.ts`, `CHANGELOG.md`.

---

## Appendix A: the field in October 2026

Read from vendor docs, pricing pages and public threads on 6 October 2026. Where a page did
not say something, this says so.

### Resend Inboxes

- Resend's name is **Inboxes**, "the inbox for agents". "Agent Mailboxes" is Bird's name
  for its own launch. Private beta: every reference page says "Inboxes are currently in
  private beta and only available to a limited number of users. The response shape might
  change before GA." Early access through Settings → Labs.
  https://resend.com/products/inboxes, https://resend.com/docs/api-reference/inboxes/create-inbox
- No blog post or changelog entry as of 6 October. Preview SDKs on npm:
  `resend@6.28.0-preview-inboxes.0` on 10 September 2026, `6.32.1-preview-inboxes.2` on
  6 October; `resend-cli@2.22.0-preview-inboxes.4` on 6 October.
- Shape: `POST /inboxes` with `email_address` **on one of your verified domains**, `name`,
  `from_name`, `forwarding: true` to get a Resend receiving address without an MX record.
  Threads with folders (`inbox|archive|spam|sent|trash`), labels with a fixed colour set,
  drafts (create, send, 409 when already sent), reply and forward endpoints that send from
  the inbox address. Assignment and notes are dashboard-only (seen in webhooks, no API).
  https://resend.com/docs/api-reference/inboxes/list-inboxes
- 14 webhook events (`inbox.*`, `inbox.thread.*`, `inbox.email.received|sent`,
  `inbox.draft.*`); `inbox.email.received` carries the email "without `html` or `text`.
  Fetch the body with Retrieve Thread Email." https://resend.com/docs/webhooks/inboxes/email-received
- Not documented: threading headers (reply examples show `"message_id": null`), attachment
  download for inbox emails, attachments on outbound replies, per-inbox keys, price,
  retention beyond the pricing page's "30-day data retention" on Free, and "Each received
  email counts towards your transactional emails quota". https://resend.com/pricing
- MCP: hosted `https://mcp.resend.com/mcp`; the Inboxes tools are "only available on the
  remote MCP server, not the local `resend-mcp` package". https://resend.com/docs/mcp-server
- Related, and older: Receiving (November 2025, `<id>.resend.app` or MX, `email.received`,
  30-day retention) https://resend.com/blog/inbound-emails; the Agent Email Inbox skill
  (webhook patterns over Receiving, five security levels, manual `In-Reply-To`)
  https://resend.com/docs/agent-email-inbox-skill
- Criticism seen: a deferral issue citing "private beta with a preview SDK, an API that may
  change before GA, and no published pricing, retention, delete semantics or storage region"
  https://github.com/jikig-ai/soleur/issues/9459; comparison pages noting received mail
  counting against the quota and shared per-team rate limiting
  https://mails.ai/vs/resend, https://openmail.sh/compare/resend-alternative

### Bird Agent Mailboxes

- Durable addresses for agents; free plans get generated addresses like `abc123@inbox.ai`,
  paid plans custom handles or domains; threads with "quote-stripped `extracted_text`",
  placement labels inbox/archive/spam/blocked, REST, SDKs, CLI, MCP (`email_mailboxes_*`,
  `email_threads_*`); a `mailbox` scope on the API key; "30-day retention window"; "No mail
  server to run, no domain to verify". https://bird.com/changelog/agent-mailboxes

### AgentMail

- YC S25, $6M seed (General Catalyst, March 2026), OpenClaw's official email plugin;
  "an identity layer for AI agents"; SOC 2 Type II.
  https://techcrunch.com/2026/03/10/agentmail-raises-6m-to-build-an-email-service-for-ai-agents/
- Inboxes (default `@agentmail.to`, metadata, `client_id`), threads, messages, drafts,
  reply-all, forward, raw MIME, attachment download, labels, semantic search; pods for
  tenant isolation with pod- and inbox-scoped keys, read-only and whitelist keys; Svix
  webhooks; WebSockets "no public URL or ngrok"; hosted MCP with 37 tools; SDKs, CLI,
  LangChain, ADK, Vercel; IMAP/SMTP; calendar; optional 24-hour expiry (enterprise).
  https://docs.agentmail.to/llms.txt, https://docs.agentmail.to/documentation/core-concepts/pods.md
- Agent onboarding: `agent.sign_up()` with a human's email, restricted to that human at 10
  a day until OTP `verify()`, then "3 distinct recipients in the first hour, 5 in the first
  day, 10 in the first week". AgentID is an OIDC provider keyed on the inbox, launched
  6 October 2026. https://docs.agentmail.to/agent-onboarding.md, https://www.agentid.com/
- Pricing: Free $0 (3 inboxes, 3,000 a month, 100 a day), Developer $20 (10 inboxes),
  Startup $200 (150 inboxes), Enterprise. Rate limits unpublished. https://www.agentmail.to/pricing
- Criticism: HN launch thread on spam and reputation ("you have no idea about email
  reputation"), unsolicited mail from AgentMail-domain agents, injection; reviews naming the
  $20 to $200 cliff, no OTP wait primitive, no injection scanning.
  https://news.ycombinator.com/item?id=46812608, https://news.ycombinator.com/item?id=48225596

### Nylas Agent Accounts

- GA 17 June 2026. A hosted mailbox and calendar per agent through the same `/messages` and
  `/events` endpoints as human-connected accounts; `localpart@appslug.nylas.email` or your
  domain; IMAP/SMTP via app password; `thread_id` on `message.created`; CLI OTP extraction.
  Free: 3 accounts, 3,000 a month, 200 sends a day. Paid pricing unpublished.
  https://www.nylas.com/blog/introducing-nylas-agent-accounts/

### Cloudflare Email Service

- "Email for agents", sending in public beta 16 April 2026. Routing free; sending 3,000 a
  month then $0.35 per 1,000 on Workers Paid; `env.EMAIL.send()`, Agents SDK `onEmail`,
  an Email MCP server, `wrangler email send` pitched as cheaper in tokens than MCP; HMAC-signed
  reply addresses route replies to the agent instance. No inbox object, no threads, you build
  storage. HN: "agent-produced emails are by definition spam", published IP ranges make
  blanket blocking trivial. https://blog.cloudflare.com/email-for-agents/,
  https://news.ycombinator.com/item?id=47792593

### The long tail

- **Mailtrap Agent Inbox**: hosted address, JSON webhook, in-thread reply, 20 replies total
  until a custom domain, MCP. https://mailtrap.io/agent-inbox/
- **inbound.new**: receive-first, unlimited mailboxes per domain, correct In-Reply-To and
  References, `inboundctl`; $9 to $79. https://inbound.new/
- **MailSlurp**: remote MCP with roles (`AGENT_READ_ONLY`, `DRAFT_ONLY`, `RESPONDER`,
  `SUPPORT`, `INBOX_MANAGER`), a supervised workspace with review queues, `POST
  /emails/{id}/codes`. https://www.mailslurp.com/docs/agents/
- **Lumbox**: OTP to JSON, blocking `/otp` and `/wait`, 104 MCP tools; $0 / $9 / $29 / $99.
  https://lumbox.co
- **Dead Simple Email**: own MTAs, injection scanning on inbound, attachment to text.
  https://deadsimple.email
- **Robotomail**, **Atomic Mail Agentic** (proof-of-work self-registration, JMAP),
  **Composio** and **Arcade** (a human's Gmail with approval policies), Google's Gmail MCP
  (drafts, no send), Claude's Gmail connector (send with per-message approval).

### What developers ask for, in their words

Identity and trust on the agent's domain; Gmail bans for OAuth-driven agents (the biggest
driver towards agent-owned inboxes); correct threading and reply isolation; OTP and
magic-link extraction with a blocking wait; human-in-the-loop as drafts, CC or allowlists;
spend caps and recipient ramps; "how do they guard against prompt injection" on every
thread; long polls or sockets from sandboxes; read-only and draft-only keys and per-agent
activity logs. Standards: MCP is the integration surface; A2A is not an email transport;
Web Bot Auth is HTTP only; no adopted header says "an agent sent this".
