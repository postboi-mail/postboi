# Newsletter SDK and local inbox review

What this change does: The SDK and CLI now manage hosted newsletter audiences and saved campaign drafts. The local inbox runs the same author, review, confirmation and campaign-control workflow with captured messages and no hosted transport.

I traced the SDK and CLI paths, methods and request bodies against the app's current campaign and newsletter routes and OpenAPI. The review covered explicit test destinations, reviewed revisions, draft duplication, scheduling, pause, cancel, recipient pagination, CSV exports, signup purpose, consent, source fields and local preview safety. Expected load is a developer's bounded, in-memory rehearsal, up to the limits documented in the inbox.

The review found and the builder corrected these issues:

1. A confirmation issued before a later opt-out could restore a local subscription. Local confirmation links now capture the consent revision. Repeated opt-outs invalidate older links, and used links cannot restore a later opt-out.
2. Removing a member erased local opt-out evidence. A newsletter now retains a list-and-address tombstone and refuses manual restoration with `newsletter_confirmation_required`. A fresh confirmation can restore its own newsletter. Removing an active reader does not invent an opt-out, and ordinary lists retain their manual status behavior.
3. Local personalization treated hosted filters as fallback text and omitted `preferences_url`. It now uses the hosted flat template and date/filter rules, including escaping after filters.
4. Launch froze the draft but read the recipient's latest name and fields during capture. It now freezes recipient render data while rechecking current consent and global suppression.
5. Test captures issued preference capabilities for the sample reader. The sample now supplies display values only; reader links belong to the explicit test destination.
6. Local newsletter slugs accepted values the hosted service refused and rejected valid one-character slugs. Both now use the same rule.
7. A list converted to a newsletter needed its current restrictive membership facts recorded immediately, so the first manual restoration could not silently succeed or silently clamp. The conversion path now seeds that evidence.

Independent regression cases live in `src/library/newsletter_local_consent_review.test.ts`. They exercise the local engine directly; the existing newsletter development tests also exercise the real inbox HTTP middleware and assert that hosted credentials and transport are never used. The CLI tests verify wire bodies, explicit revisions and send intent, and local refusal without an inbox.

The final independent rerun passed all 29 cases across the review, local inbox HTTP, typed hosted-resource and CLI test files. The 11 independent review cases cover the findings above. The review test file passes ESLint and formatting. The builder separately completed the full SDK suite, source checks, package build and publint.

No unresolved code findings remain in this SDK/local scope. Verdict: Ship after the root task completes its browser review.

Not checked: Live hosted sends, real provider credentials, production migration, and the final mobile browser presentation. The root task owns browser verification. Local styling intentionally does not reproduce a saved hosted brand or letterhead; the docs tell users to inspect the hosted preview before launch. Local acceptance is a capture, and reports never claim delivery or opens.
