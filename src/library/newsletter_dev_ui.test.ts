import { describe, expect, test, vi } from "vitest"
import { createContext, runInContext } from "node:vm"
import { newsletter_dev_ui } from "./newsletter_dev_ui.js"

function workspace() {
	const nodes = new Map<
		string,
		{
			value: string
			elements: Array<{ name: string; value: string; disabled?: boolean; type?: string }>
			onchange?: () => void
			onclick?: () => void
			onsubmit?: (event: { preventDefault(): void }) => void
			addEventListener: ReturnType<typeof vi.fn>
			reset: ReturnType<typeof vi.fn>
		}
	>()
	function node(id: string) {
		if (!nodes.has(id))
			nodes.set(id, {
				value: "",
				elements: [],
				addEventListener: vi.fn(),
				reset: vi.fn(),
			})
		return nodes.get(id)!
	}
	const confirm = vi.fn(() => false)
	const listeners = new Map<
		string,
		(event: { preventDefault(): void; returnValue?: string }) => void
	>()
	const fetcher = vi.fn(() => new Promise(() => {}))
	const context = createContext({
		document: { getElementById: node, querySelectorAll: () => [] },
		window: {
			confirm,
			addEventListener(
				name: string,
				listener: (event: { preventDefault(): void; returnValue?: string }) => void
			) {
				listeners.set(name, listener)
			},
		},
		fetch: fetcher,
	})
	const script = newsletter_dev_ui().match(/<script>([\s\S]*)<\/script>/)![1]
	runInContext(script, context)
	return {
		node,
		confirm,
		listeners,
		fetcher,
		evaluate: (code: string) => runInContext(code, context),
	}
}

describe("local newsletter unsaved-work guards", () => {
	test("canceling a campaign switch preserves an unsaved new draft and restores the selector", () => {
		const ui = workspace()
		ui.evaluate("dirty=true; selected=''")
		ui.node("draft").elements = [{ name: "body", value: "Unsaved new edition" }]
		ui.node("campaign").value = "another"
		ui.node("campaign").onchange!()
		expect(ui.confirm).toHaveBeenCalledWith(expect.stringContaining("campaign draft"))
		expect(ui.node("campaign").value).toBe("")
		expect(ui.node("draft").elements[0].value).toBe("Unsaved new edition")
		expect(ui.evaluate("dirty")).toBe(true)
	})
	test("canceling list changes or list creation preserves both dirty editors", () => {
		const ui = workspace()
		ui.evaluate("dirty=true; rule_dirty=true; selected_list='current-list'")
		ui.node("list").value = "another-list"
		ui.node("list").onchange!()
		expect(ui.node("list").value).toBe("current-list")
		ui.node("new-list").onsubmit!({ preventDefault() {} })
		expect(ui.confirm).toHaveBeenCalledWith(
			expect.stringContaining("campaign draft and automation rule")
		)
		expect(ui.evaluate("dirty && rule_dirty")).toBe(true)
		// Only the initial state read ran. A refused context change made no request.
		expect(ui.fetcher).toHaveBeenCalledTimes(1)
	})
	test("canceling reloads and a rule switch keeps the current rule and dirty text", () => {
		const ui = workspace()
		ui.evaluate("dirty=true; rule_dirty=true; selected_rule='current-rule'")
		ui.node("rule").value = "another-rule"
		ui.node("rule-draft").elements = [{ name: "body", value: "Unsaved rule" }]
		ui.node("rule").onchange!()
		ui.node("reload-rule").onclick!()
		ui.node("reload").onclick!()
		expect(ui.node("rule").value).toBe("current-rule")
		expect(ui.node("rule-draft").elements[0].value).toBe("Unsaved rule")
		expect(ui.evaluate("dirty && rule_dirty")).toBe(true)
		expect(ui.fetcher).toHaveBeenCalledTimes(1)
	})
	test("an explicit rule discard loads the chosen saved revision without sending", () => {
		const ui = workspace()
		ui.confirm.mockReturnValue(true)
		ui.evaluate(
			"rule_dirty=true; state={rules:[{id:'chosen',name:'Saved rule',body:'Saved body',revision:2,enabled:false}]}"
		)
		ui.node("rule").value = "chosen"
		ui.node("rule-draft").elements = [{ name: "body", value: "Unsaved rule" }]
		ui.node("rule").onchange!()
		expect(ui.node("rule-draft").elements[0].value).toBe("Saved body")
		expect(ui.evaluate("rule_dirty")).toBe(false)
		expect(ui.evaluate("selected_rule")).toBe("chosen")
		expect(ui.fetcher).toHaveBeenCalledTimes(1)
	})
	test("browser departure is guarded only while a campaign or rule has unsaved changes", () => {
		const ui = workspace()
		const clean = { preventDefault: vi.fn(), returnValue: undefined as string | undefined }
		ui.listeners.get("beforeunload")!(clean)
		expect(clean.preventDefault).not.toHaveBeenCalled()
		ui.evaluate("dirty=true")
		const dirty = { preventDefault: vi.fn(), returnValue: undefined as string | undefined }
		ui.listeners.get("beforeunload")!(dirty)
		expect(dirty.preventDefault).toHaveBeenCalledOnce()
		expect(dirty.returnValue).toBe("")
	})
})
