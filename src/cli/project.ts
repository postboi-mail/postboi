/** Package managers the CLI can install with. */
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

export type PackageJson = {
	packageManager?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
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
 * Insert `optimizeDeps: { exclude: ["postboi/remote"] }` into a Vite config's source.
 * Remote-function modules must reach the SvelteKit transform, not Vite's dependency
 * prebundle (which serves them empty) — and pre-adding the exclude is harmless when
 * remote functions aren't in use, since Vite only consults it for imported specifiers.
 *
 * Text edits only, and only shapes we're sure about: returns `"present"` when the
 * exclude is already there, the updated source when a safe insertion point exists, and
 * `"unable"` otherwise (the caller prints a manual hint instead of guessing).
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
