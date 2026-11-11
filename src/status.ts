/** Subscription statuses that grant access unless a site configures others. */
export const DEFAULT_PRO_STATUSES = ["active", "trialing", "past_due"] as const;

/** A SQL `IN (…)` list of statuses. Values are Stripe status names, stripped of quotes. */
export function statusList(statuses: readonly string[]): string {
	return statuses.map((s) => `'${s.replace(/'/g, "")}'`).join(", ");
}
