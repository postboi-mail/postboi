import prettier from "eslint-config-prettier"
import { fileURLToPath } from "node:url"
import js from "@eslint/js"
import svelte from "eslint-plugin-svelte"
import { defineConfig, globalIgnores, includeIgnoreFile } from "eslint/config"
import globals from "globals"
import ts from "typescript-eslint"

const gitignorePath = fileURLToPath(new URL("./.gitignore", import.meta.url))
const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	globalIgnores(["src/components/ui/**", "docs/**", "examples/**", ".claude/**"]),
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
		},
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			"no-undef": "off",
			// Allow intentionally-unused identifiers prefixed with an underscore (e.g. _response, _data).
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
		},
	},
	{
		files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir,
				extraFileExtensions: [".svelte"],
				parser: ts.parser,
			},
		},
	}
)
