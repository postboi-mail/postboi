import { readFileSync } from "node:fs"
import { exit, stdin } from "node:process"
import { analyze, check_links } from "../library/inspect/index.js"
import type { Finding, LinkCheck, Report } from "../library/inspect/index.js"
import { bold, cyan, dim, green, red, yellow } from "./prompts.js"

/**
 * `postboi inspect` — the static analyzer at the command line, for CI and for
 * anyone who wants a verdict on an HTML file before it becomes an email.
 *
 * The analysis is postboi/inspect's `analyze()` with `source: "html"` — a file
 * has nowhere to carry a plain-text part, so that one check stays quiet here.
 * `--links` adds the one thing the analyzer won't do on its own: actually
 * fetching every link; with `--json` the results ride inside the report.
 *
 * The exit code is the contract: 0 when the email passes (info findings
 * included), 1 on warnings, errors or broken links, so
 * `postboi inspect build/welcome.html` is a complete CI step; `--info-fails`
 * tightens it for the fastidious.
 */

const HELP = `
${bold("Usage")}
  ${cyan("bunx postboi inspect <file.html>")}   Lint an email's HTML ${dim("(«-» reads stdin)")}

${bold("Options")}
  --links       Also fetch every http(s) link and report the ones that don't answer
  --subject <s> Include the subject line in the analysis
  --json        Print the full report as JSON instead of findings
  --info-fails  Exit non-zero on info findings too, not just warnings and errors
`

const MARKS: Record<Finding["severity"], string> = {
	error: red("✗"),
	warning: yellow("!"),
	info: dim("·"),
}

function print_report(report: Report, link_checks: Array<LinkCheck> | undefined): void {
	// The message sentence already names the impacted clients — one line per finding.
	for (const finding of report.findings) {
		console.log(` ${MARKS[finding.severity]} ${finding.message}`)
	}
	if (report.findings.length) console.log("")

	const kb = Math.round(report.size.html_bytes / 102.4) / 10
	const clip = report.size.gmail_clip ? " (Gmail will clip this)" : ""
	console.log(
		dim(
			`HTML: ${kb} KB${clip} · ${report.links.length} link${report.links.length === 1 ? "" : "s"} · ${report.images.length} image${report.images.length === 1 ? "" : "s"}`
		)
	)

	if (link_checks) {
		const broken = link_checks.filter((link) => !link.ok)
		for (const link of broken) {
			console.log(` ${red("✗")} ${link.url} ${dim(`(${link.error ?? `answered ${link.status}`})`)}`)
		}
		console.log(
			dim(
				`Checked ${link_checks.length} link${link_checks.length === 1 ? "" : "s"}, ${broken.length} broken`
			)
		)
	}
}

export async function inspect_command(args: Array<string>): Promise<void> {
	// Parse everything up front: flags once, then the one positional that's left.
	const as_json = args.includes("--json")
	const with_links = args.includes("--links")
	const info_fails = args.includes("--info-fails")
	const subject_at = args.indexOf("--subject")
	const subject = subject_at === -1 ? undefined : args[subject_at + 1]
	const positionals = args.filter(
		(argument, index) =>
			(argument === "-" || !argument.startsWith("-")) &&
			(subject_at === -1 || index !== subject_at + 1)
	)
	const target = positionals[0]

	if (args.includes("-h") || args.includes("--help")) return void console.log(HELP)
	if (!target) {
		console.log(HELP)
		console.error(red("Pass an HTML file to inspect (or «-» for stdin)."))
		return exit(1)
	}

	let html: string
	try {
		html = target === "-" ? readFileSync(stdin.fd, "utf8") : readFileSync(target, "utf8")
	} catch (error) {
		console.error(red(`Couldn't read ${target}: ${error instanceof Error ? error.message : error}`))
		return exit(1)
	}

	const report = analyze({ html, subject, source: "html" })
	const link_checks =
		with_links && report.links.length ? await check_links(report.links) : undefined
	const broken_links = link_checks?.filter((link) => !link.ok).length ?? 0

	if (as_json) {
		// One JSON document and nothing else on stdout — pipelines parse this.
		console.log(JSON.stringify(link_checks ? { ...report, link_checks } : report, null, 2))
	} else {
		print_report(report, link_checks)
	}

	const failing = info_fails
		? report.status !== "pass"
		: report.status === "error" || report.status === "warning"
	if (failing || broken_links) {
		if (!as_json) console.log(red(`\n${bold(report.status)}`))
		return exit(1)
	}
	if (!as_json) console.log(green(`\n${report.status}`))
}
