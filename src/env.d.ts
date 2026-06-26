// Ambient declarations for the private environment variables used by the demo
// route. SvelteKit only generates types for `$env/static/private` from the vars
// it can see at `svelte-kit sync` time, so a fresh clone without a local `.env`
// would otherwise fail `svelte-check`. Copy `.env.example` to `.env` to provide
// real values. See https://svelte.dev/docs/kit/$env-static-private
declare module "$env/static/private" {
	export const ZEPTO_TOKEN: string
	export const EMAIL_FROM_ADDRESS: string
	export const EMAIL_TO_ADDRESS: string
}
