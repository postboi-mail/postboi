import { bold, dim, cyan, yellow, red } from "./prompts.js"

// The postboi mascot — a goofy postal kid in his cap, waving, parcel in hand.
// String.raw keeps the backslashes literal. Leading/trailing blank lines are trimmed below.
const ART = String.raw`
          .-"""""-.
        .'         '.
       /   .-----.   \
      |   |  \*/  |   |
    __|___|_______|___|__
      |               |
      |   o       o   |
   \o_|               |
      |     ( O )     |   ___
      |     \___/     |  |<3|
       '._         _.'   |__|
          '-------'
`

/** Colour one art line: cap blue, nose/parcel orange, heart red, sleeve blue. */
function colourize(line: string, i: number): string {
	if (i <= 4) return cyan(line) // cap crown, badge and brim
	return line
		.replace("\\o_", cyan("\\o_")) // waving sleeve
		.replace("( O )", yellow("( O )")) // big round nose
		.replace(" ___", " " + yellow("___")) // parcel lid
		.replace("|<3|", yellow("|") + red("<3") + yellow("|")) // parcel + heart
		.replace("|__|", yellow("|__|")) // parcel base
}

/** The mascot, coloured for a terminal. Colours degrade to plain text when piped. */
export function banner(): string {
	const art = ART.replace(/^\n/, "").replace(/\n$/, "").split("\n").map(colourize).join("\n")
	return `${art}\n\n  ${bold("postboi")} ${dim("— email for the rest of us")}`
}
