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
 * Is this a Svelte / SvelteKit project? Checks for a svelte config file and the svelte
 * packages in any dependency map. Svelte projects get postboi as a devDependency, since
 * Vite bundles everything at build time (the SvelteKit convention).
 */
export function is_svelte_project(files: ReadonlyArray<string>, pkg?: PackageJson): boolean {
	if (files.some((f) => /^svelte\.config\.(js|ts|mjs|mts)$/.test(f))) return true
	return has_dependency(pkg, "svelte") || has_dependency(pkg, "@sveltejs/kit")
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
