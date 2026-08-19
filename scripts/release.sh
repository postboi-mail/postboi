#!/usr/bin/env bash
set -euo pipefail

# Release the postboi library: bump → validate → commit → tag → push.
# Usage: npm run release -- <patch|minor|major|X.Y.Z>
#
# Pushing the tag triggers the Publish workflow (.github/workflows/publish.yml),
# which publishes to npm via trusted publishing (OIDC) and creates the GitHub
# release — no npm or gh login needed here.
#
# This is library-only. Docs versioning (snapshotting content/v<version>) is a
# separate step — see RELEASING.md.

BUMP="${1:-}"
if [ -z "$BUMP" ]; then
	echo "usage: npm run release -- <patch|minor|major|X.Y.Z>" >&2
	exit 1
fi

# --- preconditions -----------------------------------------------------------
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || { echo "✗ release must run on main (currently on '$branch')" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "✗ working tree not clean — commit or stash first" >&2; exit 1; }

# --- bump --------------------------------------------------------------------
npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
echo "▶ releasing $TAG"

# --- validate (before the irreversible steps) --------------------------------
npm run lint    # oxfmt + eslint — the tag push's CI gates on this too
npm test
npm run build   # prepack runs publint on the packed output

# --- commit ------------------------------------------------------------------
git add package.json
git commit -m "$VERSION"

# --- push — the tag is what triggers the Publish workflow ----------------------
#
# Unless we're already inside Actions. GitHub deliberately doesn't run workflows
# for refs pushed with the automatic token, so a tag pushed from a workflow would
# land and nothing would publish. The Release workflow sets this and dispatches
# Publish itself, which derives the tag from package.json and creates it — the
# same path RELEASING.md documents for sandboxes that can't push tags.
if [ "${RELEASE_SKIP_TAG:-0}" = "1" ]; then
	git push origin main
	echo "✓ pushed $VERSION — the Release workflow will dispatch Publish to tag and publish it"
	exit 0
fi

git tag -a "$TAG" -m "$VERSION"
git push origin main
git push origin "$TAG"

echo "✓ tagged $TAG — the Publish workflow is publishing postboi@$VERSION and creating the GitHub release"
echo "  watch it: https://github.com/postboi-mail/postboi/actions/workflows/publish.yml"
echo "  next: snapshot the docs for the outgoing version (see RELEASING.md)"
