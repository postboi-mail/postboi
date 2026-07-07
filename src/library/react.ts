/**
 * `<MailForm>` for React — Next.js, Remix, or plain React. A POST form with Postboi's
 * spam protection built in: the 🍯 honeypot field, hidden special fields (`_subject`,
 * `_reply_to`, …) from props, and — given a publishable `captcha` key from the
 * dashboard — the managed invisible captcha.
 *
 * Written with `createElement` (no JSX) so it needs no build-tool configuration here;
 * React itself is an optional peer dependency.
 *
 * @example
 * ```tsx
 * import { MailForm } from "postboi/react"
 *
 * <MailForm action="/api/contact" subject="Contact form" captcha="pk_…">
 * 	<input name="contact→name" required />
 * 	<button>Send</button>
 * </MailForm>
 * ```
 */

import { createElement, useEffect, type FormHTMLAttributes, type ReactNode } from "react"
import { HONEYPOT_FIELD } from "./captcha.js"
import {
	ensure_captcha_script,
	honeypot_style_object,
	special_fields,
	type MailFormFields,
} from "./form.js"

export type { MailFormFields } from "./form.js"

export interface MailFormProps extends FormHTMLAttributes<HTMLFormElement>, MailFormFields {
	/** Publishable managed-captcha key (`pk_…`) from the Postboi dashboard. */
	captcha?: string
	/** Origin serving the captcha loader. Defaults to https://postboi.email. */
	captcha_origin?: string
	/** Render the hidden 🍯 honeypot field. Defaults to true. */
	honeypot?: boolean
	children?: ReactNode
}

export function MailForm(props: MailFormProps) {
	const {
		captcha,
		captcha_origin,
		honeypot = true,
		subject,
		to,
		from,
		reply_to,
		cc,
		bcc,
		children,
		...rest
	} = props

	useEffect(() => {
		if (captcha) ensure_captcha_script(captcha, captcha_origin)
	}, [captcha, captcha_origin])

	const hidden = special_fields({ subject, to, from, reply_to, cc, bcc }).map(([name, value]) =>
		createElement("input", { key: name, type: "hidden", name, value })
	)

	return createElement(
		"form",
		{ method: "POST", ...rest, ...(captcha ? { "data-captcha": "" } : {}) },
		...hidden,
		honeypot
			? createElement("input", {
					key: HONEYPOT_FIELD,
					type: "text",
					name: HONEYPOT_FIELD,
					tabIndex: -1,
					autoComplete: "off",
					"aria-hidden": "true",
					style: honeypot_style_object,
				})
			: null,
		children
	)
}
