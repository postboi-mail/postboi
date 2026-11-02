export class CsvLimitError extends Error {}

export function parse_csv(
	text: string,
	limits: { rows?: number; columns?: number; cell?: number } = {}
): Array<Array<string>> {
	const rows: Array<Array<string>> = []
	let row: Array<string> = []
	let cell = ""
	let quoted = false
	function push_cell() {
		if (row.length >= (limits.columns ?? Infinity))
			throw new CsvLimitError("Include at most 100 columns per row.")
		row.push(cell)
		cell = ""
	}
	function push_row() {
		if (!row.some((value) => value !== "")) return
		if (rows.length >= (limits.rows ?? Infinity))
			throw new CsvLimitError(
				"Import at most 10,000 contacts per file. Split larger exports into separate imports."
			)
		rows.push(row)
	}
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
			push_cell()
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[i + 1] === "\n") i++
			push_cell()
			push_row()
			row = []
		} else cell += char
		if (cell.length > (limits.cell ?? Infinity))
			throw new CsvLimitError("Keep each CSV field under 20,000 characters.")
	}
	push_cell()
	push_row()
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
