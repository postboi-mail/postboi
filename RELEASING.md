# Releasing

A release ships two independent artifacts:

1. **The library** — the `postboi` npm package (published from this repo root).
2. **The docs site** — [postboi.uilo.co](https://postboi.uilo.co), deployed from `docs/` on push to `main`. Each release is snapshotted so readers can switch to older versions.

The library release is scripted. The docs snapshot is a short manual step because it involves copying content and hand-editing the version list.

## Prerequisites (one-time)

- `npm login` — publish rights to `postboi`.
- `gh auth login` — creating the GitHub release.

## Steps

Do these in order for a release of version `X.Y.Z`. Skip Part A if the docs
didn't change since the last release.

### A. Snapshot the outgoing docs version (before editing docs for the new one)

`docs/src/lib/content/docs/` always holds the **latest** docs. Freeze the
currently-published version as an archived snapshot **before** you edit docs for
`X.Y.Z`. Let `PREV` be the value of `latest` in
[`docs/src/lib/config/versions.json`](docs/src/lib/config/versions.json).

1. Copy the current docs into a version folder (set `PREV` to that value first):
   ```sh
   PREV=0.6.0   # ← the current "latest" in versions.json
   cp -R docs/src/lib/content/docs "docs/src/lib/content/v$PREV"
   ```
2. In `docs/src/lib/config/versions.json`:
   - Set `"latest"` to the new version `X.Y.Z`.
   - Prepend an entry to `archived` (newest first):
     ```json
     {
     	"version": "PREV",
     	"slug": "vPREV",
     	"nav": [
     		/* … */
     	]
     }
     ```
     For `nav`, copy the current sidebar structure from
     `contentSections[0].navigation` in
     [`docs/src/lib/config/navigation.ts`](docs/src/lib/config/navigation.ts)
     (JSON, so no icons/types — just `slug`/`name`/`items`). This freezes the
     old nav even if you rename or reorder pages in the new version.
3. Now make the actual `X.Y.Z` doc edits in `docs/src/lib/content/docs/` (and
   `navigation.ts` if the nav changed).
4. Commit and push `docs/` — this deploys the site. Verify the switcher lists
   the new version and `/vPREV` still renders the old docs.

> Snapshots are plain committed files under `docs/src/lib/content/v*/`. There's
> no build-time git dependency — the site builds on a shallow clone. (The first
> snapshot, `v0.5.0`, was seeded once from git history; everything after is a
> `cp`.)

### B. Release the library

From the repo root, on a clean `main`:

```sh
npm run release -- X.Y.Z      # or: patch | minor | major
```

The script ([`scripts/release.sh`](scripts/release.sh)) does, failing fast if
anything is off:

1. Checks you're on `main`, tree is clean, and npm + gh are authenticated.
2. Bumps `package.json` to `X.Y.Z`.
3. Runs `npm test` and `npm run build` (build runs `publint` on the package).
4. Commits `X.Y.Z`, tags `vX.Y.Z`.
5. `npm publish`.
6. Pushes `main` and the tag, then `gh release create vX.Y.Z --generate-notes`.

### C. Verify

- `npm view postboi version` shows `X.Y.Z`.
- The GitHub release exists at `vX.Y.Z`.
- The docs site shows the new version as latest and archived versions still load.

## Conventions

- Commit message for a release is the bare version (`0.7.0`), matching history.
- Tags are `vX.Y.Z`. Pre-`0.7.0` releases predate this script and are untagged.
- Pre-1.0, breaking changes are **minor** bumps (e.g. the `settings`→`config`
  rename went `0.5.0` → `0.6.0`).
