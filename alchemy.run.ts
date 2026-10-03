/**
 * The docs site (docs.postboi.app) on Cloudflare Workers, as an alchemy stack.
 *
 * This is the intended replacement for `wrangler.jsonc`: `Cloudflare.Website.SvelteKit`
 * builds the site with SvelteKit's own Vite pipeline and a wrangler-free in-memory
 * adapter, then deploys the server bundle as a Worker and the client output as its static
 * assets. No `@sveltejs/adapter-cloudflare`, no wrangler configuration. `_headers` and
 * `_redirects` in the project root still ride along as assets, exactly as they do today.
 *
 * `wrangler.jsonc` stays beside this file until a first `alchemy deploy --stage prod`
 * has adopted the existing Worker (`--adopt`, since the Worker and its custom domain
 * already exist); then it goes, along with `@sveltejs/adapter-cloudflare` and the
 * `adapter` line in `vite.config.ts`.
 *
 * Stages: `prod` is main, `pr-<n>` is a pull request's preview. `bun run infra:deploy`
 * is `alchemy deploy`, which defaults to a `live_<user>` stage for a deploy from a
 * laptop; name the stage you mean (`bun run infra:deploy -- --stage pr-123`).
 * `alchemy destroy --stage pr-123` takes a preview down.
 *
 * Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (or `alchemy login`), and
 * `@alchemy.run/frontend-frameworks` installed, which it is as a devDependency. State
 * lives in the account (`Cloudflare.state()`), not in the repository.
 */
import { Effect } from "effect"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"

/** The hostname the docs answer on. Only the `prod` stage takes it. */
const DOCS_DOMAIN = "docs.postboi.app"

export default Alchemy.Stack(
	"postboi-docs",
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.gen(function* () {
		const stage = yield* Alchemy.Stage
		const production = stage === "prod"

		const site = yield* Cloudflare.Website.SvelteKit("Docs", {
			// The Worker wrangler.jsonc deploys is named `postboi`; previews get their own name
			// so a pull request never redeploys production.
			name: production ? "postboi" : `postboi-docs-${stage}`,
			// Carried over from wrangler.jsonc. `nodejs_compat` is added for a SvelteKit server
			// bundle regardless, but saying it keeps the two files readable side by side.
			compatibility: { date: "2026-06-14", flags: ["nodejs_compat"] },
			observability: { enabled: true },
			// The stable workers.dev URL is what a preview is reached on; production keeps it
			// too, as wrangler.jsonc's `workers_dev: true` does.
			workersDev: true,
			// The custom domain is production's alone. The zone (postboi.app) already exists in
			// the account; alchemy manages the DNS record and the edge certificate.
			domain: production ? { name: DOCS_DOMAIN } : null,
			// What decides whether a rebuild is needed: the site and the package source (the
			// docs import from `$library`), the static files, and the lockfile. `dist/`, the
			// examples and the Chrome extension do not change what is deployed.
			memo: {
				include: [
					"src/**",
					"static/**",
					"_headers",
					"_redirects",
					"package.json",
					"bun.lock",
					"vite.config.ts",
					"tsconfig.json",
				],
			},
			// wrangler.jsonc also declares a `Text` module rule for `**/*.ttf`. Nothing under
			// `src` imports a `.ttf` today; if a font import comes back, it belongs in `rules`.
		})

		return { url: site.url }
	})
)
