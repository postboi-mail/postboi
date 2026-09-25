import { language as bash } from "@twinkleplop/bash"
import { language as css } from "@twinkleplop/css"
import { language as html } from "@twinkleplop/html"
import { language as javascript } from "@twinkleplop/javascript"
import { language as json } from "@twinkleplop/json"
import { language as svelte } from "@twinkleplop/svelte"
import { language as tsx } from "@twinkleplop/tsx"
import { language as typescript } from "@twinkleplop/typescript"

// Every code block on the site goes through here: the markdown fences (mdsvex, in
// svelte.config.js, at build time) and the tabs that highlight in the page. Plain JS
// because the config imports it.
//
// Twinkleplop writes a class on each token and no colours, so one rendering carries
// both modes; the theme is the `--code-*` palette in src/routes/layout.css.

/** @typedef {(input: string, render?: import("@twinkleplop/core").RenderOptions) => string} Highlight */

/** @type {Record<string, () => Highlight>} */
const FACTORIES = { bash, css, html, javascript, json, svelte, tsx, typescript }

// Fence names that mean a grammar above. Vue has no grammar of its own: HTML reads
// its template and highlights the <script> inside as script. An Astro file is
// TypeScript frontmatter over JSX-ish markup, which TSX reads best.
/** @type {Record<string, string>} */
const ALIASES = {
	ts: "typescript",
	js: "javascript",
	jsx: "tsx",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	vue: "html",
	astro: "tsx",
	xml: "html",
}

// Twinkleplop's bash grammar calls every bare word an identifier, so `bunx postboi
// init` comes out as plain text. This names what each word is doing, the way a shell
// reads it: the first word of a command (after any `FOO=bar` and the keywords that
// lead one), a flag, or an argument. The classes ride beside `identifier` and the
// theme colours them.
const SEPARATOR = /^[|&;\\()[\]<>$]+$/
const LEADS = /^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|then|do|else|if|while|until|time|!)\s+)*$/

/** @param {string} input */
function shell_words(input) {
	/** @param {string} type @param {number} start @param {number} end */
	return (type, start, end) => {
		if (!["identifier", "builtin", "operator", "punctuation"].includes(type)) return
		if (SEPARATOR.test(input.slice(start, end))) return

		let word = start
		while (word > 0 && !/[\s|;&(`]/.test(input[word - 1])) word--
		if (input[word] === "-") return { class: "flag" }

		let command = word
		while (command > 0) {
			const c = input[command - 1]
			if ("|;&(`".includes(c) || (c === "\n" && input[command - 2] !== "\\")) break
			command--
		}
		const lead = input.slice(command, word).replace(/\\\n/g, " ")
		if (!LEADS.test(lead)) return { class: "argument" }
		if (/^[A-Za-z_]\w*=/.test(input.slice(word))) return
		return { class: "command" }
	}
}

/** @type {Map<string, Highlight>} */
const made = new Map()

/** @param {string} lang */
function highlighter(lang) {
	const name = ALIASES[lang] ?? lang
	const factory = FACTORIES[name]
	if (!factory) return null
	let highlight = made.get(name)
	if (!highlight) {
		highlight = factory()
		made.set(name, highlight)
	}
	return highlight
}

/** @param {string} text */
function escape(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * The block's HTML: `<pre class="twinkleplop"><code>…</code></pre>`. A language
 * with no grammar is the same block unhighlighted, so it still sits in the theme.
 * @param {string} code
 * @param {string | null | undefined} lang
 */
export function highlight(code, lang) {
	const run = lang ? highlighter(lang) : null
	if (run) return run(code, run === made.get("bash") ? { token: shell_words(code) } : undefined)
	return `<pre class="twinkleplop"><code>${escape(code)}</code></pre>`
}
