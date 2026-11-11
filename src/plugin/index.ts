/**
 * EmDash plugin descriptor: adds a Members area to the EmDash admin
 * (overview, member search and detail, comp Pro time, early members) and a
 * dashboard widget. Import it in astro.config.mjs:
 *
 *   import { membershipsPlugin } from "emdash-memberships/plugin";
 *   emdash({ plugins: [membershipsPlugin({ d1Binding: "DB" })] })
 *
 * Sign-in, sessions and Stripe still run from your site through
 * `emdash-memberships/astro`; the plugin only adds the staff side.
 *
 * This module runs at config time (Node), so it must not import runtime code.
 * The runtime lives in ./runtime.ts, which EmDash loads in the Worker.
 */
import type { PluginOptions } from "./options.ts";

export type { PluginOptions } from "./options.ts";

export const PLUGIN_ID = "emdash-memberships";
export const PLUGIN_VERSION = "0.4.0";

export const ADMIN_PAGES = [
	{ path: "/", label: "Members", icon: "users", group: "Members" },
	{ path: "/members", label: "All members", icon: "search", group: "Members" },
	{ path: "/connections", label: "Connections", icon: "key", group: "Members" },
	{ path: "/plans", label: "Plans & prices", icon: "layers", group: "Members" },
	{ path: "/coupons", label: "Coupons", icon: "tag", group: "Members" },
	{ path: "/revenue", label: "Revenue", icon: "chart", group: "Members" },
	{ path: "/access", label: "Access rules", icon: "lock", group: "Members" },
	{ path: "/teams", label: "Teams", icon: "users", group: "Members" },
	{ path: "/gifts", label: "Gifts", icon: "gift", group: "Members" },
	{ path: "/downloads", label: "Downloads", icon: "download", group: "Members" },
	{ path: "/emails", label: "Emails", icon: "mail", group: "Members" },
	{ path: "/import", label: "Import & export", icon: "upload", group: "Members" },
	{ path: "/early", label: "Early members", icon: "star", group: "Members" },
	{ path: "/settings", label: "Member settings", icon: "settings", group: "Members" },
];

export const ADMIN_WIDGETS = [{ id: "members-overview", title: "Members", size: "half" as const }];

export function membershipsPlugin(options: PluginOptions = {}) {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		entrypoint: "emdash-memberships/plugin/runtime",
		format: "native" as const,
		options,
		adminPages: ADMIN_PAGES,
		adminWidgets: ADMIN_WIDGETS,
	};
}

export default membershipsPlugin;
