/**
 * `<MailForm>` for Vue — Nuxt or plain Vue 3. A POST form with Postboi's spam protection
 * built in: the 🍯 honeypot field, hidden special fields (`_subject`, `_reply_to`, …)
 * from props, and — given a publishable `captcha` key from the dashboard — the managed
 * invisible captcha.
 *
 * Written with render functions (no SFC) so it needs no build-tool configuration here;
 * Vue itself is an optional peer dependency.
 *
 * @example
 * ```vue
 * <script setup>
 * import { MailForm } from "postboi/vue"
 * </script>
 *
 * <template>
 * 	<MailForm action="/api/contact" subject="Contact form" captcha="pk_…">
 * 		<input name="contact→name" required />
 * 		<button>Send</button>
 * 	</MailForm>
 * </template>
 * ```
 */

import { defineComponent, h, onMounted } from "vue"
import { HONEYPOT_FIELD } from "./captcha.js"
import { ensure_captcha_script, honeypot_style, special_fields } from "./form.js"

export type { MailFormFields } from "./form.js"

export const MailForm = defineComponent({
	name: "MailForm",
	// Attrs (action, class, …) are spread onto the <form> by hand so data-captcha wins.
	inheritAttrs: false,
	props: {
		/** Publishable managed-captcha key (`pk_…`) from the Postboi dashboard. */
		captcha: { type: String, required: false },
		/** Origin serving the captcha loader. Defaults to https://postboi.email. */
		captcha_origin: { type: String, required: false },
		/** Render the hidden 🍯 honeypot field. Defaults to true. */
		honeypot: { type: Boolean, default: true },
		subject: { type: String, required: false },
		to: { type: String, required: false },
		from: { type: String, required: false },
		reply_to: { type: String, required: false },
		cc: { type: String, required: false },
		bcc: { type: String, required: false },
	},
	setup(props, { slots, attrs }) {
		onMounted(function () {
			if (props.captcha) ensure_captcha_script(props.captcha, props.captcha_origin)
		})

		return () =>
			h("form", { method: "POST", ...attrs, ...(props.captcha ? { "data-captcha": "" } : {}) }, [
				...special_fields(props).map(([name, value]) =>
					h("input", { key: name, type: "hidden", name, value })
				),
				props.honeypot
					? h("input", {
							key: HONEYPOT_FIELD,
							type: "text",
							name: HONEYPOT_FIELD,
							tabindex: "-1",
							autocomplete: "off",
							"aria-hidden": "true",
							style: honeypot_style,
						})
					: null,
				slots.default ? slots.default() : null,
			])
	},
})

export default MailForm
