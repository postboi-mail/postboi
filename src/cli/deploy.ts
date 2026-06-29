/** Hosts the CLI can push environment variables to. */
export type Host = "vercel" | "cloudflare" | "netlify" | "railway"

export const HOST_LABEL: Record<Host, string> = {
	vercel: "Vercel",
	cloudflare: "Cloudflare (wrangler)",
	netlify: "Netlify",
	railway: "Railway",
}

/** The CLI binary each host pushes through — used to check availability on PATH. */
export const HOST_CLI: Record<Host, string> = {
	vercel: "vercel",
	cloudflare: "wrangler",
	netlify: "netlify",
	railway: "railway",
}

/** A command to run to push one env var to a host. `stdin` is piped when set (secrets). */
export type PushSpec = {
	cmd: string
	args: Array<string>
	stdin?: string
}

/** Detect deployment targets from a directory listing. */
export function detect_hosts(files: ReadonlyArray<string>): Array<Host> {
	const has = (name: string) => files.includes(name)
	const hosts: Array<Host> = []

	if (has(".vercel") || has("vercel.json")) hosts.push("vercel")
	if (has("wrangler.toml") || has("wrangler.jsonc") || has("wrangler.json") || has(".dev.vars")) {
		hosts.push("cloudflare")
	}
	if (has("netlify.toml") || has(".netlify")) hosts.push("netlify")
	if (has("railway.json") || has("railway.toml")) hosts.push("railway")

	return hosts
}

/** Adapter package → host. The cloudflare entry also covers `adapter-cloudflare-workers`. */
const ADAPTER_HOSTS: ReadonlyArray<readonly [RegExp, Host]> = [
	[/@sveltejs\/adapter-vercel/, "vercel"],
	[/@sveltejs\/adapter-cloudflare/, "cloudflare"],
	[/@sveltejs\/adapter-netlify/, "netlify"],
]

/**
 * Infer the host from the SvelteKit adapter referenced in config sources (the contents of
 * `svelte.config.*`, `vite.config.*`, and/or `package.json`). Returns the first match — a
 * project only ships one adapter.
 */
export function detect_adapter_host(sources: ReadonlyArray<string>): Host | null {
	const blob = sources.join("\n")
	for (const [pattern, host] of ADAPTER_HOSTS) {
		if (pattern.test(blob)) return host
	}
	return null
}

/**
 * Build the command to push a single env var to a host. Vercel and Cloudflare read the
 * value from stdin (so it never lands in shell history); Netlify and Railway take it as an
 * argument.
 */
export function push_spec(host: Host, key: string, value: string): PushSpec {
	switch (host) {
		case "vercel":
			return { cmd: "vercel", args: ["env", "add", key, "production"], stdin: value }
		case "cloudflare":
			return { cmd: "wrangler", args: ["secret", "put", key], stdin: value }
		case "netlify":
			return { cmd: "netlify", args: ["env:set", key, value] }
		case "railway":
			return { cmd: "railway", args: ["variables", "--set", `${key}=${value}`] }
	}
}

/** The equivalent command to run by hand, shown when an automatic push fails or is skipped. */
export function manual_hint(host: Host, key: string): string {
	switch (host) {
		case "vercel":
			return `vercel env add ${key} production`
		case "cloudflare":
			return `wrangler secret put ${key}`
		case "netlify":
			return `netlify env:set ${key} <value>`
		case "railway":
			return `railway variables --set "${key}=<value>"`
	}
}
