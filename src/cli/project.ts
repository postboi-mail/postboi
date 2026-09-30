import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Package managers the CLI can install with. */
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

export type PackageJson = {
	name?: string
	version?: string
	homepage?: string
	packageManager?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
}

/** The project's package.json, parsed — undefined when missing or malformed, so every
 * caller shares one copy of the try/parse instead of hand-rolling its own. */
export function read_package(path = "package.json"): PackageJson | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
		return parsed && typeof parsed === "object" ? (parsed as PackageJson) : undefined
	} catch {
		return undefined
	}
}

/**
 * Detect the project's package manager from its `packageManager` field, then its lockfile,
 * defaulting to npm.
 */
export function detect_package_manager(
	files: ReadonlyArray<string>,
	pkg?: PackageJson
): PackageManager {
	const declared = pkg?.packageManager?.split("@")[0]
	if (declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm") {
		return declared
	}
	if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun"
	if (files.includes("pnpm-lock.yaml")) return "pnpm"
	if (files.includes("yarn.lock")) return "yarn"
	if (files.includes("package-lock.json")) return "npm"
	return "npm"
}

/**
 * Frameworks whose production build bundles server code, so postboi can be a devDependency:
 * SvelteKit bundles everything via its adapters, and the Nitro-based frameworks (Nuxt,
 * SolidStart, TanStack Start, Analog) emit a self-contained output that doesn't read
 * node_modules at runtime. Next, Remix and Astro externalise server deps — postboi stays a
 * regular dependency there.
 */
const BUNDLED_FRAMEWORK_PACKAGES = [
	"svelte",
	"@sveltejs/kit",
	"nuxt",
	"@solidjs/start",
	"@tanstack/react-start",
	"@tanstack/solid-start",
	"@analogjs/platform",
]

/** Does this project use a framework that bundles server code at build time? */
export function is_bundled_framework(files: ReadonlyArray<string>, pkg?: PackageJson): boolean {
	if (files.some((f) => /^(svelte|nuxt)\.config\.(js|ts|mjs|mts)$/.test(f))) return true
	return BUNDLED_FRAMEWORK_PACKAGES.some((name) => has_dependency(pkg, name))
}

/** Is the dependency already present in any of the package.json dependency maps? */
export function has_dependency(pkg: PackageJson | undefined, name: string): boolean {
	if (!pkg) return false
	return Boolean(
		pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.peerDependencies?.[name]
	)
}

/** The command to add a dependency with the given package manager. */
export function install_command(
	pm: PackageManager,
	name: string,
	dev = false
): { cmd: string; args: Array<string> } {
	const base = pm === "npm" ? { cmd: "npm", args: ["install"] } : { cmd: pm, args: ["add"] }
	return { cmd: base.cmd, args: dev ? [...base.args, "-D", name] : [...base.args, name] }
}

/**
 * Add the `postboi()` Vite plugin to a Vite config's source.
 *
 * The plugin does two things a hand-written `optimizeDeps` block can't. It excludes
 * `postboi/remote` from Vite's dependency prebundle (which would serve those modules
 * empty instead of letting the SvelteKit transform see them), *and* it inlines
 * `postboi.config.*` into the server build.
 *
 * That second half is why this exists. Without it the config is only found by walking up
 * from `process.cwd()` at runtime — fine locally, but a deployed serverless function
 * doesn't contain the file at all (nothing imports it, so tracing never includes it), so
 * `default.from` / `default.to` / `hooks` silently vanish in production.
 *
 * Text edits only, and only shapes we're sure about: returns `"present"` when the plugin
 * is already there, the updated source when a safe insertion point exists, and `"unable"`
 * otherwise (the caller prints a manual hint rather than guessing).
 */
export function add_vite_plugin(source: string): string | "present" | "unable" {
	if (source.includes("postboi/vite")) return "present"

	const IMPORT = 'import { postboi } from "postboi/vite"'

	// Insert the plugin at the head of an existing plugins array, matching how it's laid out:
	// a one-liner stays a one-liner, a multi-line array gets its own line at the same
	// indentation as the entries already there.
	const plugins = source.match(/plugins\s*:\s*\[/)
	if (plugins?.index !== undefined) {
		const at = plugins.index + plugins[0].length
		const rest = source.slice(at)
		const multiline = rest.match(/^[ \t]*\r?\n([ \t]*)/)
		const insert = multiline
			? `\n${multiline[1]}postboi(),`
			: // An empty array takes no separator, or we'd leave a dangling comma.
				/^\s*\]/.test(rest)
				? "postboi()"
				: "postboi(), "
		return add_import(source.slice(0, at) + insert + rest, IMPORT)
	}

	// No plugins array — add one at the top of the config object literal.
	if (source.includes("defineConfig({")) {
		return add_import(
			source.replace("defineConfig({", "defineConfig({\n\tplugins: [postboi()],"),
			IMPORT
		)
	}
	return "unable"
}

/** Put an import after the file's existing imports, or at the top if it has none. */
function add_import(source: string, statement: string): string {
	const imports = [...source.matchAll(/^import .*$/gm)]
	const last = imports.at(-1)
	if (!last?.index) return `${statement}\n${source}`
	const end = last.index + last[0].length
	return `${source.slice(0, end)}\n${statement}${source.slice(end)}`
}

/**
 * Insert `optimizeDeps: { exclude: ["postboi/remote"] }` into a Vite config's source.
 * Kept for configs the plugin can't be added to safely — the plugin supplies the same
 * exclude, so this is only the fallback.
 */
export function add_remote_exclude(source: string): string | "present" | "unable" {
	if (source.includes("postboi/remote")) return "present"

	// A flat optimizeDeps object — extend its exclude array, or add one.
	const optimize = source.match(/optimizeDeps\s*:\s*\{[^{}]*\}/)
	if (optimize) {
		const block = optimize[0]
		const updated = /exclude\s*:\s*\[/.test(block)
			? block.replace(/(exclude\s*:\s*\[)/, '$1"postboi/remote", ')
			: block.replace(/(optimizeDeps\s*:\s*\{)/, '$1 exclude: ["postboi/remote"],')
		return source.replace(block, updated)
	}
	// optimizeDeps exists but is nested (e.g. esbuildOptions) — don't risk a text edit.
	if (source.includes("optimizeDeps")) return "unable"

	// No optimizeDeps at all — add one at the top of the config object literal.
	if (source.includes("defineConfig({")) {
		return source.replace(
			"defineConfig({",
			'defineConfig({\n\t// postboi/remote must reach the SvelteKit transform, not Vite\'s dependency prebundle\n\toptimizeDeps: { exclude: ["postboi/remote"] },'
		)
	}
	return "unable"
}

/** Lockfiles we can read a postboi version out of, in the order they're believed. */
const LOCKFILES = ["bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]

/**
 * The postboi version a lockfile pins, read with a pattern per format rather than a parser
 * per format. Undefined when the lockfile doesn't mention postboi (or bun's binary
 * `bun.lockb`, which isn't read at all).
 */
export function locked_version(file: string, source: string): string | undefined {
	if (file === "package-lock.json") {
		try {
			const lock = JSON.parse(source) as { packages?: Record<string, { version?: string }> }
			return lock.packages?.["node_modules/postboi"]?.version
		} catch {
			return undefined
		}
	}
	const pattern =
		file === "bun.lock"
			? /"postboi": \["postboi@([^"]+)"/
			: file === "pnpm-lock.yaml"
				? /^\s*['"]?\/?postboi@(\d[^:'"(\s]*)/m
				: /^"?postboi@[^\n]*:\r?\n\s+version:? "?([^"\s]+)"?/m
	return pattern.exec(source)?.[1]
}

/**
 * postboi as installed in node_modules against postboi as the lockfile pins it, when both
 * can be read and they differ. That's a stale install: a pull landed a bump and nobody
 * re-ran the install, so every check and generated type runs against the old package.
 */
export function version_drift(
	dir = "."
): { installed: string; locked: string; lockfile: string } | undefined {
	const installed = read_package(join(dir, "node_modules", "postboi", "package.json"))?.version
	if (!installed) return undefined
	const lockfile = LOCKFILES.find((f) => existsSync(join(dir, f)))
	if (!lockfile) return undefined
	const locked = locked_version(lockfile, readFileSync(join(dir, lockfile), "utf8"))
	return locked && locked !== installed ? { installed, locked, lockfile } : undefined
}
