import { styleText } from "node:util"
import * as readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import type { Readable, Writable } from "node:stream"

/** styleText wrappers — colours degrade to plain text when the stream isn't a TTY.
 * The TTY check is ours: Bun's styleText ignores the `stream` option and colours anyway. */
const paint =
	(format: Parameters<typeof styleText>[0]) =>
	(text: string): string =>
		stdout.isTTY ? styleText(format, text, { stream: stdout }) : text

export const bold = paint("bold")
export const dim = paint("dim")
export const cyan = paint("cyan")
export const green = paint("green")
export const yellow = paint("yellow")
export const red = paint("red")

export type Option<T> = { label: string; value: T; hint?: string }

/** Thrown when the user aborts a prompt (Ctrl+C / Ctrl+D, or piped input runs out). */
export class PromptCancelledError extends Error {
	constructor() {
		super("Prompt cancelled")
		this.name = "PromptCancelledError"
	}
}

/**
 * A tiny readline-backed prompter (no dependencies). Buffers input lines so it works
 * with both interactive TTYs and batched/piped input (CI, scripts, tests).
 */
export function create_prompts(io: { input?: Readable; output?: Writable } = {}) {
	const input = io.input ?? stdin
	const output = io.output ?? stdout
	const rl = readline.createInterface({ input, output })
	const buffer: Array<string> = []
	// A `null` line signals the input ended (EOF / Ctrl+C) so prompts cancel instead of looping.
	const waiters: Array<(line: string | null) => void> = []
	let closed = false

	rl.on("line", (line) => {
		const waiter = waiters.shift()
		if (waiter) waiter(line)
		else buffer.push(line)
	})
	rl.on("close", () => {
		closed = true
		for (const waiter of waiters.splice(0)) waiter(null)
	})
	// Ctrl+C: close the interface, which resolves any pending prompt as cancelled.
	rl.on("SIGINT", () => rl.close())

	function next_line(): Promise<string | null> {
		if (buffer.length > 0) return Promise.resolve(buffer.shift()!)
		if (closed) return Promise.resolve(null)
		return new Promise((resolve) => waiters.push(resolve))
	}

	async function prompt(label: string): Promise<string> {
		output.write(label)
		const line = await next_line()
		if (line === null) throw new PromptCancelledError()
		return line.trim()
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
				output.write(red("  This value is required.\n"))
			}
		},

		/** Numbered single-select. */
		async select<T>(message: string, options: Array<Option<T>>): Promise<T> {
			output.write(`${message}\n`)
			options.forEach((option, i) => {
				const hint = option.hint ? dim(` — ${option.hint}`) : ""
				output.write(`  ${dim(String(i + 1))}) ${option.label}${hint}\n`)
			})
			while (true) {
				const answer = await prompt(cyan("› "))
				const n = Number(answer)
				if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value
				output.write(red(`  Enter a number from 1 to ${options.length}.\n`))
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
