/** Package managers the CLI can install with. */
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

type PackageJson = {
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
