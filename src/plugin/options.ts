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
	 * Env var holding the Stripe secret key, for the Plans, Coupons and billing
	 * actions in the admin. Default "STRIPE_SECRET_KEY". Without it those pages
	 * are read-only.
	 */
	stripeSecretEnv?: string;
	/**
	 * Cloudflare `send_email` binding used to send lifecycle emails from the
	 * plugin's scheduled job. Default "EMAIL". Set to "" to send them yourself
	 * with `processOutbox()`.
	 */
	emailBinding?: string;
	/** Cron schedule for lifecycle emails and expiring comp time. Default every 5 minutes. */
	cronSchedule?: string;
	/**
	 * List-price MRR estimate used only until real subscription data exists.
	 * @deprecated 0.3 reports MRR from Stripe amounts.
	 */
	planValues?: Record<string, PlanValue>;
	/** Currency for the list-price estimate, ISO 4217. Default "USD". */
	currency?: string;
	/** Stripe Dashboard base for customer links. Default "https://dashboard.stripe.com" (add "/test" for test mode). */
	stripeDashboardUrl?: string;
}
