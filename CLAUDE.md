# postboi

Framework-agnostic email library (npm package at repo root) plus a docs site in `docs/`.

## Cutting a release

When asked to "cut a release" / "release" / "publish a new version", follow
**[RELEASING.md](RELEASING.md)**. In short: snapshot the versioned docs if docs
changed, then `npm run release -- <patch|minor|major|X.Y.Z>` (bumps, tests,
builds, publishes to npm, tags, and creates the GitHub release). Do not run the
publish/push steps by hand — the script sequences them and checks preconditions.

## Conventions

- Code style: snake_case, no semicolons. Run `bun run check` and `bun run lint`.
- Release commits are the bare version (`0.7.0`); tags are `vX.Y.Z`.
- Pre-1.0: breaking changes are **minor** bumps.
