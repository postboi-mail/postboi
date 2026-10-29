import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cwd, env } from "node:process"
import { execFileSync } from "node:child_process"
import { open_browser } from "./postboi.js"

/** A manually dispatched job: no stored Postboi key and no unattended trust creation. */
export function github_workflow(workload_id: string, command = "bun run test"): string {
	if (!/^wl_[a-zA-Z0-9]+$/.test(workload_id))
		throw new Error("Use the public workload ID from your team's API keys page.")
	return `name: Postboi workload identity\non:\n  workflow_dispatch:\npermissions:\n  contents: read\n  id-token: write\njobs:\n  postboi:\n    runs-on: ubuntu-latest\n    env:\n      POSTBOI_WORKLOAD_ID: ${workload_id}\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          persist-credentials: false\n      - uses: oven-sh/setup-bun@v2\n      - run: bun install\n      - run: ${JSON.stringify(command)}\n`
}

export function github_init(
	args: Array<string>,
	options: { root?: string; out?: (line: string) => void; open?: (url: string) => unknown } = {}
): void {
	const root = options.root ?? cwd()
	const out = options.out ?? console.log
	function flag(name: string): string | undefined {
		const at = args.indexOf(`--${name}`)
		if (at === -1) return undefined
		if (!args[at + 1] || args[at + 1].startsWith("--")) throw new Error(`--${name} needs a value.`)
		return args[at + 1]
	}
	const id = flag("workload") ?? env.POSTBOI_WORKLOAD_ID
	if (!id) {
		const url = new URL(
			`${(env.POSTBOI_API_URL ?? "https://postboi.app").replace(/\/$/, "")}/api/cli/workloads`
		)
		try {
			const remote = execFileSync("git", ["remote", "get-url", "origin"], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim()
			const repository = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1]
			if (repository) url.searchParams.set("repository", repository)
			const branch = execFileSync("git", ["branch", "--show-current"], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim()
			if (branch) url.searchParams.set("branch", branch)
		} catch {
			/* A repository is optional until the trust form is filled in. */
		}
		out(`Approve the exact repository, branch and access on your team's API keys page: ${url}`)
		;(options.open ?? open_browser)(url.toString())
		out(
			"Then run postboi init --github --workload <public workload ID>. Trust creation requires your dashboard session; no key is stored in CI."
		)
		return
	}
	const file = (flag("workflow") ?? "postboi.yml").replace(/^\.github\/workflows\//, "")
	if (!/^[a-zA-Z0-9_.-]+\.ya?ml$/.test(file))
		throw new Error("Choose a workflow filename such as postboi.yml.")
	const target = join(root, ".github", "workflows", file)
	if (existsSync(target))
		throw new Error(
			`Workflow already exists: ${target}. Add id-token: write and POSTBOI_WORKLOAD_ID to it, or choose --workflow <new-name.yml>.`
		)
	const workflow = github_workflow(id, flag("run") ?? "bun run test")
	mkdirSync(join(root, ".github", "workflows"), { recursive: true })
	writeFileSync(target, workflow, { flag: "wx" })
	out(
		`Wrote ${target}. Run it on the trusted branch; adjust the install and run steps for your project. No Postboi key was written.`
	)
}
