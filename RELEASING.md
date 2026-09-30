# Releasing

A release ships two independent artifacts:

1. **The library** — the `postboi` npm package (published from this repo root).
2. **The docs site** — [docs.postboi.app](https://docs.postboi.app), the SvelteKit app at the repo root, deployed on push to `main`. Each release is snapshotted so readers can switch to older versions.

Both come out of one merge. Label the PR, merge it, and
[`release.yml`](.github/workflows/release.yml) does the rest.

## The normal path

**Label the release PR `release:patch`, `release:minor` or `release:major`, then
merge it.** The label can go on at any point before the merge; merging an
unlabelled PR releases nothing, which is what you want for the PRs that aren't
releases.

Pre-1.0 the bump can't be inferred from the diff — a breaking change is a
**minor** here (the `settings`→`config` rename went `0.5.0` → `0.6.0`) — so the
label is the one judgement left to a human.

On merge, `release.yml` runs, in order:

1. **Freezes the outgoing docs.** `src/site/content/docs/` always holds the
   latest docs, so the version being superseded is copied to
   `src/site/content/v<prev>/` and listed in
   [`versions.json`](src/site/config/versions.json), nav included. Both copies
   are read from the commit the PR landed on, so whatever docs the release PR
   itself changed can't leak into the archive. Committed as
   `Freeze the <prev> docs before <version> goes out`.
2. **Bumps `package.json`**, turns `## Unreleased` in
   [`CHANGELOG.md`](CHANGELOG.md) into `## <version>` with a fresh empty
   `## Unreleased` above it ([`stamp-changelog.sh`](scripts/stamp-changelog.sh)),
   and commits both as the bare version (`0.36.0`).
3. **Validates** — `lint`, `check`, `test`, the credential-pollution test run
   from ci.yml, and `build` (which runs `publint` on the packed output). This
   matters more than it looks: commits pushed with `GITHUB_TOKEN` never trigger
   ci.yml, so this run _is_ the release commits' CI. It's also the last place a
   release can fail cheaply — everything after is a push, a publish or a tag.
4. **Pushes `main` and the tag** `vX.Y.Z` — atomically, so they land together
   or not at all, and rebasing over anything that merged to main mid-release.
5. **Publishes to npm** by dispatching [`publish.yml`](.github/workflows/publish.yml)
   and waiting for it — trusted publishing over OIDC, with provenance — and
   **creates the GitHub release** with generated notes.
6. **Moves the examples' pins** to the new version once npm is serving it, pushes
   `Examples: catch up with <version>`, and runs every example's `ci` script
   against the real published package.

So a release PR contains the code, the docs edits for the new version, and its
lines under `## Unreleased` in `CHANGELOG.md`, and nothing about releasing. Don't hand-snapshot the docs in
it: the workflow does that from the pre-merge commit, and it refuses to run if
the snapshot directory already exists.

### Prerequisites (one-time)

- The three labels: **`release:patch`**, **`release:minor`**, **`release:major`**.
  GitHub will offer to create one the first time you type it into a PR's label
  dropdown.
- A **trusted publisher** configured on npmjs.com so the Publish workflow can
  publish without a token: package settings for `postboi` → _Trusted Publisher_
  → GitHub Actions, with organization/user `postboi-mail`, repository `postboi`,
  and workflow filename `publish.yml`. That filename is why `release.yml`
  _dispatches_ `publish.yml` rather than calling or copying it: npm validates
  the run's top-level workflow, so a reusable-workflow call presents
  `release.yml` and gets no token, and a tag pushed with `GITHUB_TOKEN`
  triggers no workflow at all. A dispatch is the one route that gives
  `publish.yml` a run of its own.

No local `npm login` or `gh auth login` needed anywhere.

### If something fails mid-release

Use **"Re-run failed jobs"** on the run — every job is safe to repeat: the
publish skips a version npm already has _from that exact commit_, the release
step skips a tag that already has one, and the examples job re-derives its
work from main. What you must **not** do is "Re-run all jobs" after the
release landed — that would bump again and cut a second version, so the
`prepare` job detects the case and refuses.

### Where it can't help you

Both of these fail fast with the reason, rather than half-releasing:

- **A PR from a fork.** `GITHUB_TOKEN` is read-only on fork PRs, so the release
  job can't push `main`. Merge it unlabelled and release by dispatch instead.
- **A rebase merge.** The docs freeze reads the merge's first parent, which is
  main's previous tip for a squash or a merge commit but not for a rebase of
  several commits. The workflow detects a multi-commit rebase merge and
  refuses. Squash, as every merged PR in the history has.

One more shape to avoid: releases queue one at a time (`concurrency`), and
GitHub keeps at most one _waiting_ run per group — merging a third release PR
while one runs and one waits silently cancels the waiting one. Merge release
PRs one at a time; if a queued release did get cancelled, release it by
dispatch.

## The changelog

[`CHANGELOG.md`](CHANGELOG.md) is what someone upgrading a site reads instead of the
commit history, and it ships in the npm package so agents find it in `node_modules`.
Every PR that changes the SDK or CLI adds a line under `## Unreleased`, in
`### Breaking`, `### Added` or `### Fixed`. A breaking entry names the old and new
option or export and says what to change. Leave out docs-only, site, example and CI
changes.

Don't write the version heading yourself. Both release paths rename `## Unreleased`
to `## X.Y.Z` in the version commit and open a new empty one above it. The step
refuses if the heading is missing and warns if the section is empty.

## Choosing the bump

- **patch** — fixes, docs, anything that can't change a working call.
- **minor** — new API, or a breaking change. Pre-1.0 that's the same bump.
- **major** — not yet.

Only a minor moves the docs line. `latest` in `versions.json` names the docs
_line_, not the published package, so it stays put on a patch: `0.33.1` ships
with `"latest": "0.33.0"` and no `v0.33.0` folder, exactly as `0.27.1` did. A
patch's doc edits belong in the live docs; freezing them would archive a version
nobody should be on (often, as with `0.33.1`, one whose docs describe the bug the
patch just fixed). The `v0.33.0` archive gets cut when `0.34.0` ships. The
version _badge_ on the site reads `package.json`, so it stays correct across
patches regardless.

`scripts/snapshot-docs.ts` enforces this — a patch exits having done nothing.

## When there's no PR to label

Two escape hatches, in order of preference.

**Run the Release workflow by hand.** `Actions → Release → Run workflow`, with a
bump of `patch`, `minor`, `major` or an exact `X.Y.Z`. Identical to the merge
path, releasing `main` as it stands. It assumes the docs on `main` are still the
outgoing version's; if the new version's doc edits already landed, pass the last
commit before them as `docs_before`.

**Release from a clean local `main`.**

```sh
npm run release -- X.Y.Z      # or: patch | minor | major
```

[`scripts/release.sh`](scripts/release.sh) freezes the docs and stamps the changelog
(the same `snapshot-docs.ts` and `stamp-changelog.sh` the workflow runs, so the two
can't drift), bumps, validates,
commits, tags and pushes. The tag push triggers `publish.yml`, which publishes
and cuts the GitHub release. Set `DOCS_BEFORE=<ref>` if the new version's doc
edits are already on `main`. The examples aren't part of it — once npm is serving
the release:

```sh
npm run release:examples -- X.Y.Z
bash scripts/check-examples.sh
```

Each `examples/*/package.json` pins `"postboi": "^X.Y.Z"`. CI doesn't resolve
those pins — the **Examples** job packs a tarball from the commit under test and
installs that — so the bump exists for the person copying an example folder: the
pin is what they actually install, and a stale one hands them a release that
predates the code beside it. `check-examples.sh` is the other half: it installs
the pins from npm, which is exactly the check the release workflow runs against
the freshly published package.

If tags can't be pushed from where you're releasing (e.g. a remote sandbox whose
git proxy only allows branch pushes), push `main` with the version-bump commit
and run the **Publish** workflow manually on `main` instead — it derives the tag
from `package.json` and creates both the tag and the release itself.

## Verify

- The [Release run](https://github.com/postboi-mail/postboi/actions/workflows/release.yml) is green all the way through the Examples job.
- `npm view postboi version` shows `X.Y.Z`.
- The GitHub release exists at `vX.Y.Z`.
- The docs site shows the new version as latest and archived versions still load.

On the manual path, double-check the docs after releasing: if the new version's
doc edits were already on `main` when you ran it, `/vPREV` must still render the
_old_ version's pages — that's what `DOCS_BEFORE` exists for.

> Snapshots are plain committed files under `src/site/content/v*/`. There's no
> build-time git dependency — the site builds on a shallow clone. (The first
> snapshot, `v0.5.0`, was seeded once from git history; everything after is a
> copy of the tree at a commit.)

## Conventions

- Commit message for a release is the bare version (`0.7.0`), matching history.
- Changelog lines go under `## Unreleased` in the PR that makes the change.
- Tags are `vX.Y.Z`. Pre-`0.7.0` releases predate the script and are untagged.
- Pre-1.0, breaking changes are **minor** bumps.
