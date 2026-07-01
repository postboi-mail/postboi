#!/usr/bin/env bash
set -euo pipefail

# Release the postboi library: bump → validate → commit → tag → publish → GitHub release.
# Usage: npm run release -- <patch|minor|major|X.Y.Z>
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
npm whoami >/dev/null 2>&1 || { echo "✗ not logged in to npm — run: npm login" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ not logged in to gh — run: gh auth login" >&2; exit 1; }

# --- bump --------------------------------------------------------------------
npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
echo "▶ releasing $TAG"

# --- validate (before the irreversible steps) --------------------------------
npm test
npm run build   # prepack runs publint on the packed output

# --- commit + tag ------------------------------------------------------------
git add package.json
git commit -m "$VERSION"
git tag -a "$TAG" -m "$VERSION"

# --- publish + push + GitHub release -----------------------------------------
npm publish
git push origin main
git push origin "$TAG"
gh release create "$TAG" --title "$VERSION" --generate-notes

echo "✓ released $TAG — published postboi@$VERSION and created the GitHub release"
echo "  next: snapshot the docs for the outgoing version (see RELEASING.md)"
