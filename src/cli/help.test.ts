import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { cli_page, CLI_DOC } from "../../scripts/cli-docs.js"
import { HELP, help_markdown, help_text } from "./help.js"
import { strip_ansi } from "./prompts.js"

describe("the CLI's help", () => {
	it("names every command in the terminal and on the page", () => {
		const terminal = strip_ansi(help_text())
		const page = help_markdown()
		for (const section of HELP) {
			for (const entry of section.entries) {
				expect(terminal).toContain(entry.command)
				if (section.title !== "Options") expect(page).toContain(`bunx postboi ${entry.command}`)
			}
		}
	})

	it("no entry carries a pipe: it would split a table cell, and mdsvex renders the escape literally", () => {
		for (const section of HELP) {
			for (const entry of section.entries) {
				expect(entry.summary).not.toContain("|")
				for (const line of entry.details ?? []) expect(line).not.toContain("|")
			}
		}
	})

	it("the docs page on disk is what the generator writes — run `bun scripts/cli-docs.ts`", () => {
		expect(readFileSync(CLI_DOC, "utf8")).toBe(cli_page())
	})
})
