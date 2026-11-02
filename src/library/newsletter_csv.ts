export function parse_csv(text: string): Array<Array<string>> {
	const rows: Array<Array<string>> = []
	let row: Array<string> = []
	let cell = ""
	let quoted = false
	for (let i = 0; i < text.length; i++) {
		const char = text[i]
		if (quoted) {
			if (char === '"' && text[i + 1] === '"') {
				cell += '"'
				i++
			} else if (char === '"') quoted = false
			else cell += char
		} else if (char === '"') quoted = true
		else if (char === ",") {
			row.push(cell)
			cell = ""
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[i + 1] === "\n") i++
			row.push(cell)
			cell = ""
			if (row.some((value) => value !== "")) rows.push(row)
			row = []
		} else cell += char
	}
	row.push(cell)
	if (row.some((value) => value !== "")) rows.push(row)
	return rows
}

/** Spreadsheet exports treat cells as text, including addresses with formula prefixes. */
export function campaign_csv(rows: Array<Record<string, string | null>>): string {
	const headers = [
		"email",
		"name",
		"state",
		"reason",
		"message_id",
		"status",
		"accepted_at",
		"delivered_at",
		"opened_at",
		"error",
	]
	function cell(value: string | null | undefined): string {
		const text = value ?? ""
		return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`
	}
	return [
		headers.map(cell).join(","),
		...rows.map((row) => headers.map((key) => cell(row[key])).join(",")),
	].join("\r\n")
}
