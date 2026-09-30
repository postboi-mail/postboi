#!/usr/bin/env bash
set -euo pipefail

# Release the postboi library by hand: freeze docs → bump → validate → commit →
# tag → push. Usage: npm run release -- <patch|minor|major|X.Y.Z>
#
# The normal path is a merge: label a PR release:patch|minor|major and
# .github/workflows/release.yml does all of this, plus the npm publish and the
# examples' pins. This script is the escape hatch for releasing main without a
# PR, and it shares the docs-freeze step with the workflow so the two can't
# drift.
#
# Pushing the tag triggers the Publish workflow (.github/workflows/publish.yml),
# which publishes to npm via trusted publishing (OIDC) and creates the GitHub
# release — no npm or gh login needed here.
#
# Set DOCS_BEFORE to the last commit carrying the outgoing version's docs if the
# new version's doc edits are already on main; it defaults to HEAD, which is
# right when you get here before those edits land. See RELEASING.md.

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

# --- freeze the outgoing docs (minors only; a patch is a no-op) ---------------
PREV="$(node -p "require('./src/site/config/versions.json').latest")"
bun scripts/snapshot-docs.ts --version "$VERSION" --before "${DOCS_BEFORE:-HEAD}"

# --- changelog: `## Unreleased` becomes `## $VERSION` (shared with release.yml) ---
bash scripts/stamp-changelog.sh "$VERSION"

# --- validate (before the irreversible steps) --------------------------------
# The same gates release.yml runs — the two paths must not drift.
npm run lint
npm run check
npm test
POSTBOI_TEST_POLLUTE=1 npm test   # see ci.yml: registry-driven ambient-credential run
npm run build                     # prepack runs publint on the packed output

# --- commit + tag ------------------------------------------------------------
# The freeze is its own commit in front of the version, as in every release before.
if ! git diff --quiet -- src/site/config/versions.json src/site/content; then
	git add src/site/config/versions.json src/site/content
	git commit -m "Freeze the $PREV docs before $VERSION goes out"
fi

git add package.json CHANGELOG.md
git commit -m "$VERSION"
git tag -a "$TAG" -m "$VERSION"

# --- push — the tag triggers the Publish workflow ------------------------------
# Atomic: main and the tag land together or not at all, so a failed push never
# strands a version commit on main with no tag behind it.
git push --atomic origin main "refs/tags/$TAG"

echo "✓ tagged $TAG — the Publish workflow is publishing postboi@$VERSION and creating the GitHub release"
echo "  watch it: https://github.com/postboi-mail/postboi/actions/workflows/publish.yml"
echo "  next, once it's published: npm run release:examples -- $VERSION"
