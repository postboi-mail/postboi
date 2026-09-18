# Setting up and migrating — the orderings that matter

Read from SKILL.md's account section. Both sequences below exist because a step done out of
order costs something real: a code migration blocked on DNS, a re-confirmation email to an
entire imported list, an old provider still sending into a domain the new one just verified.

## Fresh project playbook

`init --agent` (no human needed) → `whoami` → wire the code → **hand the user the claim URL** → optionally `domains add`, user clicks the setup link, `domains check` → only once **verified**, set `default.from` to the custom domain → `webhooks add` + `sync` if the app reacts to delivery events. When the human is present and wants to sign in now, plain `init` (interactive) does that instead and skips the sandbox.

Until a domain verifies, sends come from the account's shared `send.postboi.email` address. That works immediately, so **never block the code migration on DNS** — and never block wiring the code on the claim either: sandboxed sends prove the integration end to end (they're in the message log), and in dev the [dev inbox](https://docs.postboi.app/raw/dev-inbox) captures everything locally anyway.

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

   **Critical on double-opt-in lists:** pass `?status=subscribed` (or per-row `"status": "subscribed"`) for already-confirmed subscribers — those rows get **no** confirmation email. Omitting it re-confirms the entire imported base.

5. Swap the sending code (see [Migrating existing email code](#migrating-existing-email-code-to-postboi)), and flip `default.from` once the domain is verified.
6. `webhooks add` + `sync`; port suppress-on-bounce logic to the normalized events.
7. Verify end-to-end: `messages` shows delivery statuses, `webhooks deliveries <id>` shows the event feed.
