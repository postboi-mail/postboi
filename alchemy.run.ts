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
 * Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (or `alchemy profile`), and
 * `@alchemy.run/frontend-frameworks` installed, which it is as a devDependency. State
 * lives in the account (`Cloudflare.state()`), not in the repository.
 */
import { Effect } from "effect"
import * as Alchemy from "alchemy"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { unstable_readConfig } from "wrangler"

/** The hostname the docs answer on. Only the `prod` stage takes it. */
const DOCS_DOMAIN = "docs.postboi.app"

const wrangler = unstable_readConfig({ config: "wrangler.jsonc" }, { hideWarnings: true })
if (!wrangler.name) throw new Error("wrangler.jsonc names no Worker")
const worker = wrangler.name

/** wrangler.jsonc settings this stack doesn't deploy: one of them set is refused, not dropped. */
const NOT_CARRIED = [
	"vars",
	"kv_namespaces",
	"r2_buckets",
	"d1_databases",
	"services",
	"queues",
	"durable_objects",
	"analytics_engine_datasets",
	"hyperdrive",
	"vectorize",
	"ai",
	"browser",
	"routes",
	"triggers",
	"limits",
] as const
for (const key of NOT_CARRIED) {
	const value: unknown = (wrangler as unknown as Record<string, unknown>)[key]
	const set = Array.isArray(value)
		? value.length > 0
		: value && typeof value === "object"
			? Object.values(value).some((inner) =>
					Array.isArray(inner) ? inner.length > 0 : Boolean(inner)
				)
			: Boolean(value)
	if (set) throw new Error(`wrangler.jsonc sets ${key}, which alchemy.run.ts doesn't deploy`)
}

/** A Worker name may be 54 characters with preview URLs on, of lowercase letters, digits and hyphens. */
function preview_name(stage: string): string {
	const slug = stage
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	const name = `${worker}-docs-${slug}`
	if (!slug || name.length > 54)
		throw new Error(`Stage "${stage}" makes no valid Worker name ("${name}")`)
	return name
}

export default Alchemy.Stack(
	"postboi-docs",
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.gen(function* () {
		const stage = yield* Alchemy.Stage
		const production = stage === "prod"

		const site = yield* Cloudflare.Website.SvelteKit("Docs", {
			// Production is wrangler.jsonc's Worker; previews get their own name so a pull
			// request never redeploys it.
			name: production ? worker : preview_name(stage),
			// alchemy adds `new_module_registry` unless told otherwise; the legacy registry is the
			// one wrangler.jsonc's flags deploy.
			compatibility: {
				date: wrangler.compatibility_date,
				flags: [...(wrangler.compatibility_flags ?? []), "legacy_module_registry"],
			},
			observability: { enabled: wrangler.observability?.enabled ?? false },
			workersDev: {
				enabled: wrangler.workers_dev ?? true,
				previewsEnabled: wrangler.preview_urls ?? true,
			},
			// The custom domain is production's alone. The zone (postboi.app) already exists in
			// the account; alchemy manages the DNS record and the edge certificate.
			domain: production ? { name: DOCS_DOMAIN } : null,
			// What decides whether a rebuild is needed: the source, the static files, and the
			// lockfile. `dist/`, the
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
