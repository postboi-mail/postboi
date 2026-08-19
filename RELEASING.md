# Releasing

A release ships two independent artifacts:

1. **The library** — the `postboi` npm package (published from this repo root).
2. **The docs site** — [docs.postboi.app](https://docs.postboi.app), the SvelteKit app at the repo root, deployed on push to `main`. Each release is snapshotted so readers can switch to older versions.

The library release is scripted. The docs snapshot is a short manual step because it involves copying content and hand-editing the version list.

## Prerequisites (one-time)

- A **trusted publisher** configured on npmjs.com so the Publish workflow can
  publish without a token: package settings for `postboi` → _Trusted Publisher_
  → GitHub Actions, with organization/user `postboi-mail`, repository
  `postboi`, and workflow filename `publish.yml`.

No local `npm login` or `gh auth login` needed — publishing and the GitHub
release happen in CI ([`publish.yml`](.github/workflows/publish.yml)),
authenticated via OIDC.

## Steps

Do these in order for a release of version `X.Y.Z`. Skip Part A if the docs
didn't change since the last release, **and on every patch release** — see below.

### A. Snapshot the outgoing docs version (before editing docs for the new one)

> **Minors only.** `latest` in `versions.json` names the docs _line_, not the
> published package — it moves on a minor and stays put on a patch, so `0.33.1`
> ships with `"latest": "0.33.0"` and no `v0.33.0` folder, exactly as `0.27.1`
> did. A patch's doc edits belong in the live docs; snapshotting one would
> freeze a version nobody should be on (often, as with `0.33.1`, one whose docs
> describe the bug the patch just fixed). The `v0.33.0` archive gets cut when
> `0.34.0` ships. The version _badge_ on the site reads `package.json`, so it
> stays correct across patches regardless.

`src/site/content/docs/` always holds the **latest** docs. Freeze the
currently-published version as an archived snapshot **before** you edit docs for
`X.Y.Z`. Let `PREV` be the value of `latest` in
[`src/site/config/versions.json`](src/site/config/versions.json).

1. Copy the current docs into a version folder (set `PREV` to that value first):
   ```sh
   PREV=0.6.0   # ← the current "latest" in versions.json
   cp -R src/site/content/docs "src/site/content/v$PREV"
   ```
   This assumes you got here _before_ the new version's doc edits landed. If
   they're already on `main` — a feature branch that carried its own docs, say
   — a plain `cp` would archive the new pages as `PREV`. Take them from the
   commit just before those edits instead, and read the nav from the same
   commit:
   ```sh
   BEFORE=abc1234   # ← last commit with PREV's docs, e.g. main^ of the merge
   mkdir -p "src/site/content/v$PREV"
   git archive "$BEFORE" src/site/content/docs \
     | tar -x --strip-components=4 -C "src/site/content/v$PREV"
   git show "$BEFORE:src/site/config/navigation.ts"
   ```
2. In `src/site/config/versions.json`:
   - Set `"latest"` to the new version `X.Y.Z`.
   - Prepend an entry to `archived` (newest first):
     ```json
     {
     	"version": "PREV",
     	"slug": "vPREV",
     	"nav": [/* … */]
     }
     ```
     For `nav`, copy the current sidebar structure from
     `contentSections[0].navigation` in
     [`src/site/config/navigation.ts`](src/site/config/navigation.ts). It's JSON,
     so drop the component references (`icon: Email`) but **keep `icon: true`** —
     that's data the sidebar renders from, and every snapshot since `v0.14.0`
     carries it. This freezes the old nav even if you rename or reorder pages
     in the new version.
3. Now make the actual `X.Y.Z` doc edits in `src/site/content/docs/` (and
   `navigation.ts` if the nav changed).
4. Commit and push — this deploys the site (the docs app is the repo root now). Verify the switcher lists
   the new version and `/vPREV` still renders the old docs.

> Snapshots are plain committed files under `src/site/content/v*/`. There's
> no build-time git dependency — the site builds on a shallow clone. (The first
> snapshot, `v0.5.0`, was seeded once from git history; everything after is a
> `cp`.)

### B. Release the library

Either from GitHub, which needs nothing local:

> **Actions → [Release](https://github.com/postboi-mail/postboi/actions/workflows/release.yml)
> → Run workflow →** type `X.Y.Z` (or `patch` / `minor` / `major`).

or from a clean `main` locally:

```sh
npm run release -- X.Y.Z      # or: patch | minor | major
```

Both run the same script ([`scripts/release.sh`](scripts/release.sh)) — the
workflow just runs it somewhere that always has a clean checkout — and both fail
fast if anything is off:

1. Checks you're on `main` and the tree is clean.
2. Bumps `package.json` to `X.Y.Z`.
3. Runs `npm run lint`, `npm test` and `npm run build` (build runs `publint` on
   the package).
4. Commits `X.Y.Z`, tags `vX.Y.Z`.
5. Pushes `main` and the tag.

Pushing the tag triggers the **Publish** workflow
([`publish.yml`](.github/workflows/publish.yml)), which re-runs tests and the
build, checks the tag matches `package.json`, publishes to npm via trusted
publishing (OIDC, with provenance), and creates the GitHub release with
generated notes.

**Neither path publishes.** Publish is the only thing that talks to npm, and it
still runs the whole suite before it does — so a release you started by mistake
is stopped by a red test, not by you noticing.

> The workflow skips step 4's tag and dispatches Publish directly instead
> (`RELEASE_SKIP_TAG=1`). GitHub deliberately doesn't run workflows for refs
> pushed with the automatic token, so a tag pushed from inside Actions would land
> and nothing would publish. Publish's `workflow_dispatch` path derives the tag
> from `package.json` and creates it — the same route to use by hand from a
> sandbox whose git proxy only allows branch pushes.

### C. Point the examples at it

Each `examples/*/package.json` pins `"postboi": "^X.Y.Z"`. CI doesn't resolve
those pins — the **Examples** job packs the tarball from the commit under test
and installs that — so this bump no longer unblocks anything. It exists because
the pin is what someone copying an example folder actually installs, and a stale
one hands them a release that predates the code beside it.

```sh
sed -i '' 's/"postboi": "\^0\.35\.0"/"postboi": "^0.36.0"/' examples/*/package.json
```

To reproduce the CI job locally, pack and install the same way it does — a plain
`bun install` in an example resolves the pin instead, which is the previous
release:

```sh
npm pack --pack-destination /tmp
for dir in examples/*/; do
  (cd "$dir" && bun install && bun add /tmp/postboi-X.Y.Z.tgz && bun run ci)
done
```

This is also the step that lets an example use something the release added
_before_ it's published: examples on a feature branch can import new APIs and go
green, because the tarball CI builds is that branch's.

### D. Verify

- The [Publish run](https://github.com/postboi-mail/postboi/actions/workflows/publish.yml) is green.
- `npm view postboi version` shows `X.Y.Z`.
- The GitHub release exists at `vX.Y.Z`.
- The docs site shows the new version as latest and archived versions still load.

## Conventions

- Commit message for a release is the bare version (`0.7.0`), matching history.
- Tags are `vX.Y.Z`. Pre-`0.7.0` releases predate this script and are untagged.
- Pre-1.0, breaking changes are **minor** bumps (e.g. the `settings`→`config`
  rename went `0.5.0` → `0.6.0`).
