/**
 * Shared plumbing for the framework `<Captcha>` components (Svelte, React, Vue, Astro).
 * Everything here is framework-agnostic: the honeypot styling, the managed-captcha loader
 * injection, and the parent-form activation the components run on mount.
 */

import { captcha_key } from "./register.js"

/** Where the managed-captcha loader script lives. */
export const CAPTCHA_ORIGIN = "https://postboi.app"

/**
 * The honeypot input's name. It lives here rather than in `captcha.ts` — which owns the
 * checking half and re-exports it — because every `<Captcha>` needs it and `captcha.ts`
 * reaches for `node:fs` through `env.js`. A component that imported the name from there
 * dragged the whole server-side chain into the browser graph, and each bundler said so
 * in its own way.
 */
export const HONEYPOT_FIELD = "_honey"

/**
 * Path-legal alias for the Turnstile token. The managed-captcha loader uses it (via
 * Turnstile's `response-field-name`) on SvelteKit remote forms, where the default
 * name's dashes are rejected by the form data parser. Here for the same reason as
 * {@link HONEYPOT_FIELD}.
 */
export const TURNSTILE_REMOTE_FIELD = "_captcha"

/**
 * The suffix a SvelteKit remote form puts on every field name (`email/<hash>/<name>`), from
 * its `?/remote=<hash>/<name>` action, or `""` for any other form. A `.for(key)` instance
 * adds `/<key>` to the action but not to the field names, so only the first two parts count.
 * SvelteKit rejects a remote form field without the suffix (`form_field_unbound`), so the
 * honeypot and the captcha token carry it too.
 */
export function remote_scope(action: string | null | undefined): string {
	const id = action?.match(/[?&]\/remote=([^&#]+)/)?.[1]
	return id ? `/${decodeURIComponent(id).split("/").slice(0, 2).join("/")}` : ""
}

/**
 * Give the honeypot and the captcha token the remote form's scope, now and whenever the
 * Turnstile widget adds its input later. Returns the cleanup for an effect.
 */
export function scope_captcha_fields(marker: Element | null | undefined): (() => void) | undefined {
	const form = marker?.closest("form")
	if (!form || typeof MutationObserver === "undefined") return
	const scope = remote_scope(form.getAttribute("action"))
	if (!scope) return
	const apply = () => {
		for (const name of [HONEYPOT_FIELD, TURNSTILE_REMOTE_FIELD]) {
			for (const input of form.querySelectorAll<HTMLInputElement>(`[name="${name}"]`)) {
				input.name = name + scope
			}
		}
	}
	apply()
	const observer = new MutationObserver(apply)
	observer.observe(form, { childList: true, subtree: true })
	return () => observer.disconnect()
}

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
 * what makes `<Captcha />` prop-free on the Postboi provider. With no key at all it stays a
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
			"postboi: <Captcha> has no publishable key. Run `bunx postboi sync` (the Postboi provider) or pass pk. The honeypot still works; the managed captcha is off."
		)
		return
	}
	form.setAttribute("data-captcha", "")
	ensure_captcha_script(key, origin)
}
