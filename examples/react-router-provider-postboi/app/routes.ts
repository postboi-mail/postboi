import { type RouteConfig, index, route } from "@react-router/dev/routes"

export default [
	index("routes/home.tsx"),
	route("push", "routes/push.tsx"),
	route("push/subscriptions", "routes/push.subscriptions.ts"),
	route("notify", "routes/notify.ts"),
	route("webhooks", "routes/webhooks.ts"),
] satisfies RouteConfig
