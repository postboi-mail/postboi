"use client"

/**
 * `<Captcha>` for React — Next.js, Remix, or plain React. Drop-in spam protection for a
 * native `<form>`: renders the 🍯 honeypot field and, on Postboi Cloud, activates the
 * managed invisible captcha on the surrounding form. The publishable key is baked in by
 * `bunx postboi sync`, so no props are needed.
 *
 * Written with `createElement` (no JSX) so it needs no build-tool configuration here;
 * React itself is an optional peer dependency.
 *
 * @example
 * ```tsx
 * import { Captcha } from "postboi/react"
 *
 * <form action={action}>
 * 	<input name="contact→name" required />
 * 	<Captcha />
 * 	<button>Send</button>
 * </form>
 * ```
 */

import { createElement, useEffect, useRef } from "react"
import { HONEYPOT_FIELD } from "./captcha.js"
import { activate_captcha, honeypot_style_object } from "./form.js"

export interface CaptchaProps {
	/** Publishable key (`pk_…`) override. Defaults to the key baked by `bunx postboi sync`. */
	pk?: string
	/** Origin serving the captcha loader. Defaults to https://postboi.email. */
	origin?: string
	/** Render the hidden 🍯 honeypot field. Defaults to true. */
	honeypot?: boolean
}

export function Captcha({ pk, origin, honeypot = true }: CaptchaProps) {
	const marker = useRef<HTMLElement>(null)

	useEffect(() => {
		activate_captcha(marker.current, pk, origin)
	}, [pk, origin])

	return honeypot
		? createElement("input", {
				ref: marker,
				type: "text",
				name: HONEYPOT_FIELD,
				tabIndex: -1,
				autoComplete: "off",
				"aria-hidden": "true",
				style: honeypot_style_object,
			})
		: createElement("span", { ref: marker, hidden: true })
}
