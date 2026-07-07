/**
 * `<Captcha>` for Vue — Nuxt or plain Vue 3. Drop-in spam protection for a native
 * `<form>`: renders the 🍯 honeypot field and, on the Postboi provider, activates the managed
 * invisible captcha on the surrounding form. The publishable key is baked in by
 * `bunx postboi sync`, so no props are needed.
 *
 * Written with render functions (no SFC) so it needs no build-tool configuration here;
 * Vue itself is an optional peer dependency.
 *
 * @example
 * ```vue
 * <script setup>
 * import { Captcha } from "postboi/vue"
 * </script>
 *
 * <template>
 * 	<form method="post" action="/api/contact">
 * 		<input name="contact→name" required />
 * 		<Captcha />
 * 		<button>Send</button>
 * 	</form>
 * </template>
 * ```
 */

import { defineComponent, h, onMounted, ref } from "vue"
import { HONEYPOT_FIELD } from "./captcha.js"
import { activate_captcha, honeypot_style } from "./form.js"

export const Captcha = defineComponent({
	name: "Captcha",
	props: {
		/** Publishable key (`pk_…`) override. Defaults to the key baked by `bunx postboi sync`. */
		pk: { type: String, required: false },
		/** Origin serving the captcha loader. Defaults to https://postboi.email. */
		origin: { type: String, required: false },
		/** Render the hidden 🍯 honeypot field. Defaults to true. */
		honeypot: { type: Boolean, default: true },
	},
	setup(props) {
		const marker = ref<HTMLElement>()

		onMounted(function () {
			activate_captcha(marker.value, props.pk, props.origin)
		})

		return () =>
			props.honeypot
				? h("input", {
						ref: marker,
						type: "text",
						name: HONEYPOT_FIELD,
						tabindex: "-1",
						autocomplete: "off",
						"aria-hidden": "true",
						style: honeypot_style,
					})
				: h("span", { ref: marker, hidden: true })
	},
})

export default Captcha
