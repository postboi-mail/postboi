/**
 * The docs site (docs.postboi.app) on Cloudflare Workers, as an alchemy stack.
 *
 * `Cloudflare.Website.SvelteKit` builds the site with SvelteKit's own Vite pipeline and a
 * wrangler-free in-memory adapter, then deploys the server bundle as a Worker and the
 * client output as its static assets. `_headers` and `_redirects` in the project root
 * ride along as assets, as they do with wrangler.
 *
 * The Worker's settings (its name, compatibility date and flags, observability, the
 * workers.dev URL and preview URLs) are read from `wrangler.jsonc` with wrangler's own
 * reader, so this stack and `wrangler deploy` cannot drift. wrangler.jsonc stays the
 * working deploy until a first `alchemy deploy --stage prod --adopt` has taken the
 * existing Worker and its custom domain over; after that only its `main` and `assets`
 * lines go, with `@sveltejs/adapter-cloudflare` and the `adapter` line in
 * `vite.config.ts`.
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
import { unstable_readConfig } from "wrangler"

/** The hostname the docs answer on. Only the `prod` stage takes it. */
const DOCS_DOMAIN = "docs.postboi.app"

const wrangler = unstable_readConfig({ config: "wrangler.jsonc" }, { hideWarnings: true })
if (!wrangler.name) throw new Error("wrangler.jsonc names no Worker")
const worker = wrangler.name

export default Alchemy.Stack(
	"postboi-docs",
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.gen(function* () {
		const stage = yield* Alchemy.Stage
		const production = stage === "prod"

		const site = yield* Cloudflare.Website.SvelteKit("Docs", {
			// Production is wrangler.jsonc's Worker; previews get their own name so a pull
			// request never redeploys it.
			name: production ? worker : `${worker}-docs-${stage}`,
			compatibility: { date: wrangler.compatibility_date, flags: wrangler.compatibility_flags },
			observability: { enabled: wrangler.observability?.enabled ?? false },
			workersDev: {
				enabled: wrangler.workers_dev ?? true,
				previewsEnabled: wrangler.preview_urls ?? true,
			},
			// The custom domain is production's alone. The zone (postboi.app) already exists in
			// the account; alchemy manages the DNS record and the edge certificate.
			domain: production ? { name: DOCS_DOMAIN } : null,
			// What decides whether a rebuild is needed: the site and the package source (the
			// docs import from `#library`), the static files, and the lockfile. `dist/`, the
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
		})

		return { url: site.url }
	})
)
