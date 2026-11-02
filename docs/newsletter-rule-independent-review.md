# SDK automation review

What this change does: The SDK and CLI expose the newsletter rule lifecycle through the application's REST contract. The local inbox rehearses paused drafts, review, explicit enable, future tag/signup trigger intents, bounded execution and capture without a hosted provider.

Reviewer: code_review agent. This is an independent review of integration_review's SDK changes in the separate `postboi` worktree. The reviewer authored the corresponding application automation routes, which still need root's independent approval. The reviewer changed no SDK application files and added only `src/library/newsletter_rule_review.test.ts`.

## Must fix, resolved

1. **Repeated variables could exhaust the local inbox's memory** (`src/library/newsletter_template.ts`, `src/library/newsletter_dev.ts`).
   - What this is: A local automation fills reader fields into a saved email before capture.
   - Problem: The draft and field bounds did not bound their expanded result. A 10 KB body with 2,000 placeholders and a 1 KB reader field captured a 2 MB email; larger allowed inputs could allocate gigabytes before any message-count limit mattered.
   - Fix: Integration_review added a per-fill byte bound before the template engine assembles replacements, plus a final serialized-message bound. Oversized preview returns a refusal. The rule runner blocks the affected intent and continues to the next reader.
   - If skipped: A valid local fixture can hang or exhaust the development server, and local captures accept content the hosted path cannot safely queue.
   - Evidence: The independent regression failed with two captures and zero blocked intents. After the fix it passes with one blocked large reader, one valid capture, no pending work and a refused preview that creates no capture.

## Other checks

The typed SDK methods match the implemented route methods and request/response shapes. CLI enable needs both an explicit revision and `--confirm`; a hosted automation runner is refused. Resource IDs are encoded before entering paths. Local mode keeps captures on loopback without forwarding the hosted token.

Local draft writes remain paused, enabled rules cannot be edited, stale revisions refuse activation, pause/edit invalidates old intents and a fresh enable starts a new authorization generation. Import writes never generate rule intents. Confirmed signup and tag events are idempotent; execution reads the current subscription/suppression state and rule generation before capture. Completion tags do not recursively trigger another rule. Local documentation and UI explicitly avoid claiming that captures verify hosted credentials, sender verification, provider delivery or opens.

The automation controls send the selected saved revision and stop a dirty draft from being enabled. Preview HTML is in a sandboxed iframe. The UI still requires browser interaction review to establish its actual usability.

The independent and existing focused group passed 25 tests across four files after the size fix. The new independent test is formatted and its ESLint check is clean. Broader SDK release checks remain with integration_review/root.

Verdict: Ship the reviewed SDK automation changes after normal integrated checks. The expansion finding is closed; no additional actionable defect was found in the reviewed lifecycle, consent, scoping or CLI authority boundaries.

Not checked: browser interaction with the local automation controls, hosted provider delivery, publication of the SDK package, or a live customer workflow. No hosted credentials, remote sends or production data were used.
