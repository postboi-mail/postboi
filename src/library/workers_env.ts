/**
 * Cloudflare Workers pass configuration as bindings rather than ambient env vars, but
 * workerd also exposes every binding on the `cloudflare:workers` module — so a Worker
 * needs no explicitly-passed credentials after all. Returns `{}` on every other runtime.
 *
 * Isolated in its own module so the bundler-hostile import has one home. The specifier is
 * assembled at runtime on purpose: a literal `import("cloudflare:workers")` makes bundlers
 * targeting Node try to resolve it and fail the build.
 */
export async function workers_env(): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	try {
		const specifier = "cloudflare:" + "workers"
		const module = (await import(/* @vite-ignore */ specifier)) as {
			env?: Record<string, unknown>
		}
		// Bindings are a mixed bag — D1, KV and queues sit alongside the string vars/secrets.
		for (const [key, value] of Object.entries(module.env ?? {})) {
			if (typeof value === "string") out[key] = value
		}
	} catch {
		// Not workerd — no ambient bindings to read.
	}
	return out
}
