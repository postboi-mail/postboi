/**
 * Shared plumbing for the framework `<Captcha>` components (Svelte, React, Vue, Astro).
 * Everything here is framework-agnostic: the honeypot styling, the managed-captcha loader
 * injection, and the parent-form activation the components run on mount.
 */

import { captcha_key } from "./register.js"

/** Where the managed-captcha loader script lives. */
export const CAPTCHA_ORIGIN = "https://postboi.email"

/** Inline styling that hides the honeypot from humans without `display: none` (which smarter bots detect). */
export const honeypot_style = "position:absolute;left:-9999px;height:0;width:0;opacity:0"

/** The same styling as an object, for frameworks that take style objects (React). */
export const honeypot_style_object = {
	position: "absolute",
	left: "-9999px",
	height: 0,
	width: 0,
	opacity: 0,
} as const

const SCRIPT_MARKER = "data-postboi-captcha"

/**
 * Inject the managed-captcha loader script once per page. Safe to call from any number of
 * components and on the server (no-op without a DOM). The loader itself watches the DOM,
 * so forms mounted after injection — SPA navigations — still get their widget.
 */
export function ensure_captcha_script(key: string, origin: string = CAPTCHA_ORIGIN): void {
	if (typeof document === "undefined") return
	if (document.querySelector(`script[${SCRIPT_MARKER}]`)) return
	const tag = document.createElement("script")
	tag.src = `${origin.replace(/\/$/, "")}/captcha.js`
	tag.async = true
	tag.defer = true
	tag.setAttribute("data-key", key)
	tag.setAttribute(SCRIPT_MARKER, "")
	document.head.appendChild(tag)
}

/**
 * What a `<Captcha>` component does on mount: find the surrounding native `<form>` from
 * its rendered marker element, tag it `data-captcha` for the loader, and inject the
 * loader script. The key comes from the `pk` prop when given, otherwise from
 * {@link captcha_key} — the value `bunx postboi sync` bakes into this package, which is
 * what makes `<Captcha />` prop-free on Postboi Cloud. With no key at all it stays a
 * honeypot and says so, rather than failing silently.
 */
export function activate_captcha(
	marker: Element | null | undefined,
	pk?: string,
	origin?: string
): void {
	if (!marker || typeof document === "undefined") return
	const form = marker.closest("form")
	if (!form) {
		console.warn("postboi: <Captcha> must be rendered inside a <form>")
		return
	}
	const key = pk ?? captcha_key
	if (!key) {
		console.warn(
			"postboi: <Captcha> has no publishable key — run `bunx postboi sync` (Postboi Cloud) or pass pk. The honeypot still works; the managed captcha is off."
		)
		return
	}
	form.setAttribute("data-captcha", "")
	ensure_captcha_script(key, origin)
}
