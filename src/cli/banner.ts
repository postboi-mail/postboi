import { yellow, dim } from "./prompts.js"

// "postboi" rendered in the figlet "Speed" font. `boi` is tinted in the logo's yellow via a
// per-row seam that follows the font's slant. String.raw keeps the backslashes literal.
const ART = String.raw`
                     ___________       _____
_______________________  /___  /__________(_)
___  __ \  __ \_  ___/  __/_  __ \  __ \_  /
__  /_/ / /_/ /(__  )/ /_ _  /_/ / /_/ /  /
_  .___/\____//____/ \__/ /_.___/\____//_/
/_/
`

// Column on each row where `post` ends and the yellow `boi` begins.
const SEAMS = [26, 27, 27, 25, 25, 3]

/** The wordmark, with `boi` in yellow. Colours degrade to plain text when not a TTY. */
export function banner(): string {
	const art = ART.replace(/^\n/, "")
		.replace(/\n$/, "")
		.split("\n")
		.map((line, i) => line.slice(0, SEAMS[i]) + yellow(line.slice(SEAMS[i])))
		.join("\n")
	return `${art}\n  ${dim("i got 99 problems, but mail ain't 1")}`
}
