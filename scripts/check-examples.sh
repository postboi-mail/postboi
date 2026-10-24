#!/usr/bin/env bash
set -uo pipefail

# Install every example's pins from npm and run its ci script — the release
# workflow's post-publish check that the pins and the published artifact hold
# up. (CI's Examples job tests the other side: a tarball packed from the
# commit under test, before any release exists.)

bun install --frozen-lockfile && bunx svelte-kit sync || exit 1

failed=""
for dir in examples/*/; do
	echo "── $dir"
	if ! (cd "$dir" && bun install && bun run ci); then
		failed="$failed $dir"
	fi
done

if [ -n "$failed" ]; then
	echo "✗ failing examples:$failed" >&2
	exit 1
fi
