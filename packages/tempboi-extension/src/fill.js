/**
 * Puts `text` into the focused field the way typing would, so the page's own listeners
 * (React's, Svelte's, a form library's) hear it happen. It runs in the page, handed to
 * `chrome.scripting.executeScript` by source, so it may use nothing outside its own body.
 */
export function insert_text(text) {
	if (!document.hasFocus()) return false
	let field = document.activeElement
	while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement
	if (!field) return false
	if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
		const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set
		const start = field.selectionStart ?? field.value.length
		const end = field.selectionEnd ?? field.value.length
		const next = field.value.slice(0, start) + text + field.value.slice(end)
		if (setter) setter.call(field, next)
		else field.value = next
		try {
			field.setSelectionRange(start + text.length, start + text.length)
		} catch {
			// type="email" has no selection API; the value is what matters.
		}
		field.dispatchEvent(
			new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
		)
		field.dispatchEvent(new Event("change", { bubbles: true }))
		return true
	}
	if (field.isContentEditable) return document.execCommand("insertText", false, text)
	return false
}
