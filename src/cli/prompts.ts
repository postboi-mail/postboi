import { styleText } from "node:util"
import * as readline from "node:readline/promises"
import { stdin, stdout } from "node:process"

/** styleText wrappers — colours degrade to plain text when the stream isn't a TTY. */
const paint =
	(format: Parameters<typeof styleText>[0]) =>
	(text: string): string =>
		styleText(format, text, { stream: stdout })

export const bold = paint("bold")
export const dim = paint("dim")
export const cyan = paint("cyan")
export const green = paint("green")
export const yellow = paint("yellow")
export const red = paint("red")

export type Option<T> = { label: string; value: T; hint?: string }

/**
 * A tiny readline-backed prompter (no dependencies). Buffers input lines so it works
 * with both interactive TTYs and batched/piped input (CI, scripts, tests).
 */
export function create_prompts() {
	const rl = readline.createInterface({ input: stdin, output: stdout })
	const buffer: Array<string> = []
	const waiters: Array<(line: string) => void> = []
	let closed = false

	rl.on("line", (line) => {
		const waiter = waiters.shift()
		if (waiter) waiter(line)
		else buffer.push(line)
	})
	rl.on("close", () => {
		closed = true
		for (const waiter of waiters.splice(0)) waiter("")
	})

	function next_line(): Promise<string> {
		if (buffer.length > 0) return Promise.resolve(buffer.shift()!)
		if (closed) return Promise.resolve("")
		return new Promise((resolve) => waiters.push(resolve))
	}

	async function prompt(label: string): Promise<string> {
		stdout.write(label)
		return (await next_line()).trim()
	}

	return {
		/** Free-text question with an optional default. */
		async ask(
			question: string,
			options: { default?: string; required?: boolean } = {}
		): Promise<string> {
			const suffix = options.default ? dim(` (${options.default})`) : ""
			while (true) {
				const answer = await prompt(`${question}${suffix} `)
				if (answer) return answer
				if (options.default !== undefined) return options.default
				if (!options.required) return ""
				stdout.write(red("  This value is required.\n"))
			}
		},

		/** Numbered single-select. */
		async select<T>(message: string, options: Array<Option<T>>): Promise<T> {
			stdout.write(`${message}\n`)
			options.forEach((option, i) => {
				const hint = option.hint ? dim(` — ${option.hint}`) : ""
				stdout.write(`  ${dim(String(i + 1))}) ${option.label}${hint}\n`)
			})
			while (true) {
				const answer = await prompt(cyan("› "))
				const n = Number(answer)
				if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value
				stdout.write(red(`  Enter a number from 1 to ${options.length}.\n`))
			}
		},

		/** Yes/no confirmation. */
		async confirm(question: string, fallback = true): Promise<boolean> {
			const answer = (
				await prompt(`${question} ${dim(fallback ? "(Y/n)" : "(y/N)")} `)
			).toLowerCase()
			if (!answer) return fallback
			return answer === "y" || answer === "yes"
		},

		close() {
			rl.close()
		},
	}
}
