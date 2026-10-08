import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { api, say } from "./api.js"
import { yellow } from "./prompts.js"

/**
 * Local assets for `postboi testing run` and `postboi views publish`: find the images, fonts
 * and VML fills an email points at on disk, upload each one content-addressed (an edited file
 * gets a new URL, an unchanged one is never sent twice) and point the HTML at the uploads.
 * Tests upload to `/v1/testing/assets` (kept 30 days), views to `/v1/views/assets` (kept).
 */

/** What the server stores, by extension. */
export const ASSET_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"svg",
	"ico",
	"woff",
	"woff2",
	"ttf",
	"otf",
])

/** The server refuses anything bigger, so it's warned about here instead of failing the run. */
const MAX_BYTES = 10 * 1024 * 1024

// ponytail: patterns over the raw text, comments included, which is what reaches VML in
// `<!--[if mso]>`. A `url(...)` in visible text counts too; it only matters if the file exists.
const ATTR = /((?<![\w-])(?:src|background)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'`>]+))/gi
const SRCSET = /((?<![\w-])srcset\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi
const URL_FN = /(url\(\s*)(&quot;|&#39;|["']|)(.*?)\2(\s*\))/gi
// One srcset candidate, as the HTML spec splits them: the URL runs to whitespace (so a comma
// inside it, as in a data: URI or `w_100,h_100`, stays put), then descriptors up to a comma.
const CANDIDATE = /([\s,]*)(\S*[^\s,])(\s[^,]*|,*)/g

/**
 * Every reference in `html`, each passed to `map`: what it answers replaces the reference,
 * `undefined` leaves it alone. One walk serves both finding and rewriting, so a rewrite
 * touches exactly the references that were found and never the same text elsewhere.
 */
export function map_refs(html: string, map: (ref: string) => string | undefined): string {
	const one = (ref: string) => map(ref.trim()) ?? ref
	return html
		.replace(ATTR, (_, pre: string, dq?: string, sq?: string, bare?: string) => {
			const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : ""
			return `${pre}${quote}${one(dq ?? sq ?? bare ?? "")}${quote}`
		})
		.replace(SRCSET, (_, pre: string, dq?: string, sq?: string) => {
			const quote = dq !== undefined ? '"' : "'"
			const value = (dq ?? sq ?? "").replace(
				CANDIDATE,
				(_, lead: string, ref: string, rest: string) => `${lead}${one(ref)}${rest}`
			)
			return `${pre}${quote}${value}${quote}`
		})
		.replace(
			URL_FN,
			(_, pre: string, quote: string, ref: string, post: string) =>
				`${pre}${quote}${one(ref)}${quote}${post}`
		)
}

/** A path on disk: no scheme, no `//`, no `#fragment`, and no Liquid or merge tags. */
export function is_local(ref: string): boolean {
	if (!ref || ref.startsWith("#") || ref.startsWith("//")) return false
	if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false
	return !["{{", "{%", "*|", "%%"].some((tag) => ref.includes(tag))
}

/** The nearest directory from `dir` up holding a package.json or .git, if any. */
export function project_root(dir: string): string | undefined {
	for (let at = resolve(dir); ; at = dirname(at)) {
		if (is_there(join(at, "package.json")) || is_there(join(at, ".git"), true)) return at
		if (dirname(at) === at) return undefined
	}
}

function is_there(path: string, any = false): boolean {
	const stat = statSync(path, { throwIfNoEntry: false })
	return any ? stat !== undefined : stat?.isFile() === true
}

/** `&amp;`, `&quot;`, `&apos;` and numeric references: what an attribute's value means. */
function decode_entities(text: string): string {
	const named: Record<string, string> = { amp: "&", quot: '"', apos: "'" }
	return text.replace(/&(amp|quot|apos|#\d{1,6}|#x[\da-f]{1,5});/gi, (_, ref: string) =>
		ref[0] === "#"
			? String.fromCodePoint(
					Number(ref[1].toLowerCase() === "x" ? `0${ref.slice(1)}` : ref.slice(1))
				)
			: named[ref.toLowerCase()]
	)
}

/**
 * The file a reference names. Tried in order, first hit wins: the HTML's directory, each
 * parent up to the project root, then the cwd. A root-relative path (`/x`) is taken as
 * relative to each of them, or only to `assets` when the config sets it. `..` never leaves
 * the project root (or the HTML's directory outside a project) or the cwd.
 */
export function resolve_asset(
	ref: string,
	where: { dir: string; cwd: string; assets?: string }
): string | undefined {
	// Entities decoded as in an attribute, `\` read as `/` like a browser does, then
	// percent-escapes (decodeURIComponent, so `%40` in `a%402x.png` is an `@` too).
	let path = decode_entities(ref).replaceAll("\\", "/").split(/[?#]/)[0]
	try {
		path = decodeURIComponent(path)
	} catch {
		// A stray % is a file name like any other.
	}
	const rooted = path.startsWith("/")
	const top = project_root(where.dir)
	const fences = [top ?? resolve(where.dir), resolve(where.cwd)]
	let roots: Array<string>
	if (rooted && where.assets) {
		roots = [where.assets]
	} else {
		roots = [resolve(where.dir)]
		if (top) {
			for (let at = roots[0]; at !== top && dirname(at) !== at;) {
				at = dirname(at)
				roots.push(at)
			}
		}
		roots.push(resolve(where.cwd))
	}
	for (const root of roots) {
		// A root-relative `..` stops at the root, like a browser's; a relative one is fenced.
		const file = rooted ? join(root, join("/", path)) : resolve(root, path)
		const inside = (fence: string) => {
			const to = relative(fence, file)
			return !/^\.\.(?:[\\/]|$)/.test(to) && !isAbsolute(to)
		}
		if ((rooted || fences.some(inside)) && is_there(file)) return file
	}
	return undefined
}

interface Asset {
	hash: string
	ext: string
	bytes: Uint8Array
	url?: string
}

/**
 * Upload the local assets `html` references to `endpoint` and answer it pointing at them.
 * `file` is the HTML's path (`-` for stdin, resolved from the cwd); `assets` is
 * `testing.assets` from postboi.config. A missing file is warned about once and left as it is.
 */
export async function upload_assets(
	html: string,
	file: string,
	assets?: string,
	endpoint: "/v1/testing/assets" | "/v1/views/assets" = "/v1/testing/assets"
): Promise<string> {
	const refs = new Set<string>()
	map_refs(html, (ref) => void (is_local(ref) && refs.add(ref)))
	if (!refs.size) return html

	const cwd = process.cwd()
	const dir = file === "-" ? cwd : dirname(resolve(file))
	const where = { dir, cwd, assets: assets && resolve(project_root(cwd) ?? cwd, assets) }
	const by_ref = new Map<string, Asset>()
	const by_key = new Map<string, Asset>()
	for (const ref of refs) {
		const path = resolve_asset(ref, where)
		const ext = extname(path ?? "")
			.slice(1)
			.toLowerCase()
		const skip = !path
			? "no such file"
			: !ASSET_EXTS.has(ext)
				? `.${ext || "(none)"} files aren't uploaded`
				: undefined
		if (skip || !path) {
			say(`${yellow("!")} ${ref}: ${skip}, left as it is`)
			continue
		}
		const bytes = new Uint8Array(readFileSync(path))
		if (bytes.length === 0 || bytes.length > MAX_BYTES) {
			say(`${yellow("!")} ${ref}: ${bytes.length ? "over 10 MB" : "empty"}, left as it is`)
			continue
		}
		const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32)
		const key = `${hash}.${ext}`
		const asset = by_key.get(key) ?? { hash, ext, bytes }
		by_key.set(key, asset)
		by_ref.set(ref, asset)
	}
	if (!by_key.size) return html

	const assets_list = [...by_key.values()]
	const missing: Array<Asset> = []
	for (let i = 0; i < assets_list.length; i += 200) {
		const batch = assets_list.slice(i, i + 200)
		const answer = await api<{ assets: Array<{ url: string; exists: boolean }> }>(endpoint, {
			method: "POST",
			body: { assets: batch.map((a) => ({ hash: a.hash, ext: a.ext, size: a.bytes.length })) },
		})
		batch.forEach((asset, n) => {
			asset.url = answer.assets[n].url
			if (!answer.assets[n].exists) missing.push(asset)
		})
	}
	// A few at a time, like the screenshot downloads.
	for (let i = 0; i < missing.length; i += 4) {
		await Promise.all(
			missing.slice(i, i + 4).map(async (asset) => {
				const stored = await api<{ url: string }>(`${endpoint}/${asset.hash}.${asset.ext}`, {
					method: "PUT",
					body: asset.bytes,
				})
				asset.url = stored.url
			})
		)
	}

	const n = assets_list.length
	say(`assets   ${n} local (${missing.length} uploaded, ${n - missing.length} already there)`)
	return map_refs(html, (ref) => by_ref.get(ref)?.url)
}
