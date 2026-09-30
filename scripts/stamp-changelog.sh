#!/usr/bin/env bash
set -euo pipefail

# Turn CHANGELOG.md's `## Unreleased` into `## <version>` and open a fresh, empty
# `## Unreleased` above it. release.yml and scripts/release.sh both run this
# before the version commit, so the two paths can't drift.
#
# Usage: scripts/stamp-changelog.sh X.Y.Z

VERSION="${1:?usage: scripts/stamp-changelog.sh X.Y.Z}"
FILE=CHANGELOG.md

grep -qxF '## Unreleased' "$FILE" || { echo "✗ $FILE has no '## Unreleased' heading" >&2; exit 1; }
if grep -qxF "## $VERSION" "$FILE"; then
	echo "✗ $FILE already has a '## $VERSION' section" >&2
	exit 1
fi

# Empty when the first non-blank line after the heading is the next version.
next="$(awk '/^## Unreleased$/ { found = 1; next } found && NF { print; exit }' "$FILE")"
case "$next" in
	"" | "## "*) echo "⚠ nothing under '## Unreleased', so $VERSION gets an empty section in $FILE" >&2 ;;
esac

VERSION="$VERSION" perl -0pi -e 's/^## Unreleased$/## Unreleased\n\n## $ENV{VERSION}/m' "$FILE"
echo "▶ $FILE: '## Unreleased' is now '## $VERSION'"
