import { describe, it, expect } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { is_local, map_refs, project_root, resolve_asset } from "./assets.js"

function refs(html: string): Array<string> {
	const found: Array<string> = []
	map_refs(html, (ref) => void found.push(ref))
	return found
}

/** A file tree under a fresh temp dir: `{ "a/b.png": "x" }`. */
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "postboi-assets-"))
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true })
		writeFileSync(join(root, path), body)
	}
	return root
}

describe("map_refs", () => {
	it("finds src, background, every srcset candidate, and url() in styles", () => {
		const html = `
			<style>@font-face { src: url("fonts/a.woff2") format("woff2"), url('fonts/a.woff'); }
			.hero { background: url(img/bg.png) }</style>
			<img src="img/a.png" data-src="ignored.png" srcset="img/a.png 1x, img/a@2x.png 2x">
			<td background='img/td.jpg' style="background-image:url(&quot;img/st.gif&quot;)">
			<img src=bare.png>`
		expect(refs(html).sort()).toEqual(
			[
				"fonts/a.woff",
				"fonts/a.woff2",
				"img/a.png",
				"img/a.png",
				"img/a@2x.png",
				"img/bg.png",
				"img/st.gif",
				"img/td.jpg",
				"bare.png",
			].sort()
		)
	})

	it("reads VML inside mso conditional comments", () => {
		const html = `<!--[if mso]><v:rect><v:fill type="frame" src="img/vml.png" /></v:rect><![endif]-->`
		expect(refs(html)).toEqual(["img/vml.png"])
	})

	it("rewrites every occurrence of a reference and nothing that merely contains it", () => {
		const html = `<img src="a.png"><img src="cdn/a.png" srcset="a.png 2x"><p style="background:url(a.png)">a.png</p>`
		const out = map_refs(html, (ref) => (ref === "a.png" ? "https://x/h.png" : undefined))
		expect(out).toBe(
			`<img src="https://x/h.png"><img src="cdn/a.png" srcset="https://x/h.png 2x"><p style="background:url(https://x/h.png)">a.png</p>`
		)
	})
})

describe("is_local", () => {
	it("keeps paths and skips URLs, schemes, fragments and merge tags", () => {
		for (const ref of ["a.png", "./a.png", "../a.png", "/img/a.png", "a.png?v=2"]) {
			expect(is_local(ref), ref).toBe(true)
		}
		for (const ref of [
			"https://cdn.test/a.png",
			"http://x/a.png",
			"//cdn.test/a.png",
			"data:image/png;base64,AA",
			"cid:logo",
			"mailto:a@b.c",
			"#top",
			"{{ hero }}",
			"img/{% if x %}a{% endif %}.png",
			"*|IMAGE|*",
			"%%=v(@img)=%%",
			"",
		]) {
			expect(is_local(ref), ref).toBe(false)
		}
	})
})

describe("resolve_asset", () => {
	it("resolves relative paths against the HTML's directory, without query or hash", () => {
		const root = tree({ "package.json": "{}", "dist/img/a.png": "a" })
		const where = { dir: join(root, "dist"), cwd: root }
		expect(resolve_asset("img/a.png?v=2#x", where)).toBe(join(root, "dist/img/a.png"))
		expect(resolve_asset("./img/a.png", where)).toBe(join(root, "dist/img/a.png"))
		expect(resolve_asset("img/nope.png", where)).toBeUndefined()
	})

	it("walks up to the project root for root-relative paths, with no config", () => {
		const root = tree({ "package.json": "{}", "images/x.png": "x", "public/email.html": "" })
		const where = { dir: join(root, "public"), cwd: "/" }
		expect(resolve_asset("/images/x.png", where)).toBe(join(root, "images/x.png"))
		expect(resolve_asset("images/x.png", where)).toBe(join(root, "images/x.png"))
		// The HTML's own directory wins over a parent's.
		writeFileSync(join(root, "public/x.png"), "near")
		mkdirSync(join(root, "public/images"))
		writeFileSync(join(root, "public/images/x.png"), "near")
		expect(resolve_asset("/images/x.png", where)).toBe(join(root, "public/images/x.png"))
	})

	it("stops at the project root, then tries the cwd", () => {
		const outer = tree({
			"images/x.png": "outside",
			"app/package.json": "{}",
			"app/out/e.html": "",
		})
		const where = { dir: join(outer, "app/out"), cwd: join(outer, "app") }
		expect(project_root(where.dir)).toBe(join(outer, "app"))
		expect(resolve_asset("/images/x.png", where)).toBeUndefined()
		expect(resolve_asset("/images/x.png", { ...where, cwd: outer })).toBe(
			join(outer, "images/x.png")
		)
	})

	it("uses only testing.assets for root-relative paths when it's set", () => {
		const root = tree({ "package.json": "{}", "static/img/a.png": "a", "img/a.png": "b" })
		const where = { dir: root, cwd: root, assets: join(root, "static") }
		expect(resolve_asset("/img/a.png", where)).toBe(join(root, "static/img/a.png"))
		// Relative paths still search as usual.
		expect(resolve_asset("img/a.png", where)).toBe(join(root, "img/a.png"))
	})
})
