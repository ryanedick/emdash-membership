/** Shared Block Kit helpers and context for the Members admin pages. */
import type Stripe from "stripe";
import type { Db } from "../db.ts";
import type { PlanPrice } from "../plans.ts";
import { createBilling } from "../stripe.ts";
import type { EmailTransport } from "../transport.ts";
import type { PluginOptions } from "./options.ts";

export type Block = Record<string, unknown>;
export interface AdminResponse {
	blocks: Block[];
	toast?: { type: "success" | "error" | "info"; message: string };
}
export interface Interaction {
	type: "page_load" | "block_action" | "form_submit";
	page?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}
export interface AdminDeps {
	/** Enables the pages that write to Stripe */
	stripe?: Stripe | null;
	/** Used for "send a test" on the Emails page */
	transport?: EmailTransport | null;
	/** Staff member using the admin, recorded in the audit trail */
	actor?: string | null;
	/** The plugin's EmDash settings (encrypted secrets); enables the Connections page */
	settings?: PluginSettingsStore | null;
	/** Environment for key fallbacks (default: the Worker's env) */
	envFallback?: Record<string, unknown>;
	/** Builds a Stripe client for a key (tests); default: the real SDK */
	stripeFactory?: (key: string) => Stripe;
	now?: number;
}

/** The slice of EmDash's plugin `ctx.settings` the admin uses. Secret fields are encrypted by EmDash. */
export interface PluginSettingsStore {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
}
export interface Ctx {
	/** Who is acting (staff email or id), for the audit trail */
	actor: string | null;
	settings: PluginSettingsStore | null;
	envFallback?: Record<string, unknown>;
	stripeFactory?: (key: string) => Stripe;
	db: Db;
	options: PluginOptions;
	now: number;
	stripe: Stripe | null;
	transport: EmailTransport | null;
}

export const PAGE = 50;

export const header = (text: string): Block => ({ type: "header", text });
export const context = (text: string): Block => ({ type: "context", text });
export const divider: Block = { type: "divider" };
export const button = (label: string, action_id: string, opts: { style?: "primary" | "danger" | "secondary"; value?: unknown; confirm?: { title: string; text: string; confirm: string } } = {}): Block => ({
	type: "button",
	label,
	action_id,
	...(opts.style && { style: opts.style }),
	...(opts.value !== undefined && { value: opts.value }),
	...(opts.confirm && { confirm: { ...opts.confirm, deny: "Cancel", ...(opts.style === "danger" && { style: "danger" }) } }),
});
export const actions = (...elements: Block[]): Block => ({ type: "actions", elements });
export const banner = (title: string, description?: string, variant: "default" | "alert" | "error" = "default"): Block => ({ type: "banner", title, ...(description && { description }), variant });
export const text = (action_id: string, label: string, initial?: string | null, extra: Record<string, unknown> = {}): Block => ({ type: "text_input", action_id, label, ...(initial ? { initial_value: initial } : {}), ...extra });
export const select = (action_id: string, label: string, options: { label: string; value: string }[], initial?: string | null): Block => ({ type: "select", action_id, label, options, ...(initial ? { initial_value: initial } : {}) });
export const toggle = (action_id: string, label: string, initial: boolean, description?: string): Block => ({ type: "toggle", action_id, label, initial_value: initial, ...(description && { description }) });
export const num = (action_id: string, label: string, initial: number, min?: number, max?: number): Block => ({ type: "number_input", action_id, label, initial_value: initial, ...(min !== undefined && { min }), ...(max !== undefined && { max }) });
export const form = (block_id: string, fields: Block[], submit: string, action_id: string): Block => ({ type: "form", block_id, fields, submit: { label: submit, action_id } });
export const nav = (label: string, page: string, style: "primary" | "secondary" = "secondary"): Block => ({ type: "link", label, target: { kind: "plugin-page", path: page }, appearance: style });

export const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));
export const bool = (v: unknown) => v === true || v === "true" || v === "on" || v === 1;
export const n = (x: number) => x.toLocaleString("en-US");
export const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");
export const when = (ms: number | null | undefined) => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—");
export const pctText = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
export function money(minor: number, currency = "USD") {
	try {
		return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
	}
}
export const priceLabel = (p: PlanPrice) =>
	`${money(p.amount, p.currency)}${p.kind === "recurring" ? ` / ${p.intervalCount > 1 ? `${p.intervalCount} ` : ""}${p.interval}${p.intervalCount > 1 ? "s" : ""}` : " once"}`;
export const pro = (o: PluginOptions) => ({ proStatuses: o.proStatuses });
export const list = (v: unknown) =>
	str(v)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
export const stripeNotice = (c: Ctx): Block[] =>
	c.stripe ? [] : [banner("Stripe isn't connected", "Add your Stripe key on Members → Connections to manage prices, coupons and subscriptions here.", "alert"), actions(nav("Open Connections", "/connections", "primary"))];

export function billingOf(c: Ctx) {
	if (!c.stripe) return null;
	return createBilling({ db: c.db, stripe: c.stripe, webhookSecret: "", proStatuses: c.options.proStatuses as Stripe.Subscription.Status[] | undefined, now: () => c.now });
}

