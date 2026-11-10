import type { PlanValue } from "../admin.ts";

/** Serializable plugin options (they pass through astro.config.mjs as JSON). */
export interface PluginOptions {
	/** Name of the D1 binding holding the membership tables. Default "DB". */
	d1Binding?: string;
	/**
	 * RBAC permission needed to use the Members admin. Default "users:manage"
	 * (Admins only), since it shows personal and billing data.
	 */
	permission?: string;
	/** Subscription statuses that count as Pro. Default: active, trialing, past_due. Match your billing config. */
	proStatuses?: string[];
	/**
	 * Value of each recurring Stripe Price by lookup key, for the MRR estimate,
	 * e.g. { pro_monthly: { amount: 900, interval: "month" } }. Omit to hide MRR.
	 */
	planValues?: Record<string, PlanValue>;
	/** Currency for MRR, ISO 4217. Default "USD". */
	currency?: string;
	/** Stripe Dashboard base for customer links. Default "https://dashboard.stripe.com" (add "/test" for test mode). */
	stripeDashboardUrl?: string;
}
