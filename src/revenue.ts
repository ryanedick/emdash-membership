/**
 * Revenue from what Stripe actually charges: each subscription's amount,
 * quantity and recurring discount become its monthly recurring revenue (MRR),
 * stored with the subscription; every change is logged as an MRR movement
 * (new, expansion, contraction, churn, reactivation) for reports.
 *
 * Conventions (the usual SaaS ones):
 * - MRR counts active and past-due subscriptions. Trials count as 0 until they convert.
 * - Annual plans count 1/12 per month. One-time purchases aren't recurring revenue.
 * - "forever" and "repeating" discounts reduce MRR; a "once" discount doesn't.
 * - Amounts stay in their currency's smallest unit; reports group by currency.
 */
import { type Db, ensureSchema } from "./db.ts";

const DAY = 24 * 60 * 60 * 1000;
const MRR_STATUSES = new Set(["active", "past_due"]);

export interface TermsInput {
	status: string;
	amount: number | null;
	interval: string | null;
	intervalCount: number | null;
	quantity: number;
	discountPct: number | null;
	discountAmount: number | null;
}

/** Monthly value of one subscription in the smallest currency unit, rounded. 0 when it isn't earning. */
export function mrrOf(t: TermsInput): number {
	if (!MRR_STATUSES.has(t.status) || !t.amount || !t.interval) return 0;
	let total = t.amount * Math.max(1, t.quantity);
	if (t.discountPct) total *= 1 - Math.min(100, t.discountPct) / 100;
	else if (t.discountAmount) total = Math.max(0, total - t.discountAmount);
	const n = Math.max(1, t.intervalCount ?? 1);
	const perMonth =
		t.interval === "year" ? total / (12 * n) : t.interval === "month" ? total / n : t.interval === "week" ? (total * 52) / (12 * n) : t.interval === "day" ? (total * 365) / (12 * n) : 0;
	return Math.round(perMonth);
}

export type MrrMovement = "new" | "expansion" | "contraction" | "churn" | "reactivation";

/**
 * Logs a change in one subscription's MRR. `everEarned` says whether the
 * member had recurring revenue before, which separates "new" from "reactivation".
 */
export function mrrMovement(before: number, after: number, everEarned: boolean): MrrMovement | null {
	if (before === after) return null;
	if (before === 0) return everEarned ? "reactivation" : "new";
	if (after === 0) return "churn";
	return after > before ? "expansion" : "contraction";
}

export interface RevenueReport {
	currency: string;
	/** Current MRR in the smallest unit */
	mrr: number;
	arr: number;
	/** Subscriptions earning MRR now */
	payingSubscriptions: number;
	trialing: number;
	/** Average MRR per paying subscription */
	arpu: number;
	/** Movements in the last `days` days, in the smallest unit (churn and contraction are positive numbers) */
	window: { days: number; new: number; expansion: number; reactivation: number; contraction: number; churn: number; net: number };
	/** Share of the MRR at the start of the window lost to churn and contraction */
	revenueChurnRate: number | null;
	/** Subscriptions that churned in the window over those earning at its start */
	logoChurnRate: number | null;
	/** Month by month for the last 12 months: [month start ms, MRR at month end] */
	history: [number, number][];
}

/** Revenue report for one currency (the most used one by default). */
export async function revenueReport(db: Db, opts: { currency?: string; days?: number; now?: number } = {}): Promise<RevenueReport> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	const days = opts.days ?? 30;
	const since = t - days * DAY;
	const currency =
		opts.currency?.toLowerCase() ??
		(await db
			.prepare(`SELECT currency FROM mbr_subscription_terms WHERE currency IS NOT NULL GROUP BY currency ORDER BY SUM(mrr) DESC, COUNT(*) DESC LIMIT 1`)
			.first<{ currency: string }>())?.currency ??
		"usd";
	const now = await db
		.prepare(
			`SELECT COALESCE(SUM(t.mrr), 0) AS mrr, COUNT(CASE WHEN t.mrr > 0 THEN 1 END) AS paying,
				COUNT(CASE WHEN s.status = 'trialing' THEN 1 END) AS trialing
			 FROM mbr_subscription_terms t JOIN mbr_subscriptions s ON s.id = t.subscription_id WHERE t.currency = ?`,
		)
		.bind(currency)
		.first<{ mrr: number; paying: number; trialing: number }>();
	const { results: moves } = await db
		.prepare(`SELECT kind, SUM(mrr_after - mrr_before) AS delta, COUNT(*) AS n FROM mbr_mrr_events WHERE currency = ? AND at >= ? GROUP BY kind`)
		.bind(currency, since)
		.all<{ kind: MrrMovement; delta: number; n: number }>();
	const sum = (k: MrrMovement) => Number(moves.find((m) => m.kind === k)?.delta ?? 0);
	const churnCount = Number(moves.find((m) => m.kind === "churn")?.n ?? 0);
	const window = {
		days,
		new: sum("new"),
		expansion: sum("expansion"),
		reactivation: sum("reactivation"),
		contraction: -sum("contraction"),
		churn: -sum("churn"),
		net: 0,
	};
	window.net = window.new + window.expansion + window.reactivation - window.contraction - window.churn;
	const mrr = Number(now?.mrr ?? 0);
	const startMrr = mrr - window.net;
	const startPaying = await payingAt(db, currency, since);
	const history: [number, number][] = [];
	const month = new Date(t);
	for (let i = 11; i >= 0; i--) {
		const start = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - i, 1);
		const end = Math.min(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - i + 1, 1), t);
		history.push([start, mrr - (await deltaSince(db, currency, end))]);
	}
	const paying = Number(now?.paying ?? 0);
	return {
		currency,
		mrr,
		arr: mrr * 12,
		payingSubscriptions: paying,
		trialing: Number(now?.trialing ?? 0),
		arpu: paying ? Math.round(mrr / paying) : 0,
		window,
		revenueChurnRate: startMrr > 0 ? (window.churn + window.contraction) / startMrr : null,
		logoChurnRate: startPaying > 0 ? churnCount / startPaying : null,
		history,
	};
}

async function deltaSince(db: Db, currency: string, at: number): Promise<number> {
	const r = await db
		.prepare(`SELECT COALESCE(SUM(mrr_after - mrr_before), 0) AS d FROM mbr_mrr_events WHERE currency = ? AND at >= ?`)
		.bind(currency, at)
		.first<{ d: number }>();
	return Number(r?.d ?? 0);
}

/** Subscriptions earning MRR at a moment, from the movement log (last movement per subscription before it). */
async function payingAt(db: Db, currency: string, at: number): Promise<number> {
	const r = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM mbr_mrr_events e
			 WHERE e.currency = ?1 AND e.at < ?2 AND e.mrr_after > 0
			   AND e.id = (SELECT MAX(id) FROM mbr_mrr_events x WHERE x.subscription_id = e.subscription_id AND x.at < ?2)`,
		)
		.bind(currency, at)
		.first<{ n: number }>();
	return Number(r?.n ?? 0);
}

export interface ConversionReport {
	days: number;
	/** Members who joined in the window */
	joined: number;
	/** Of those, how many hold a paid subscription now */
	convertedToPaid: number;
	/** Trials that ended in the window, and how many became paying */
	trialsEnded: number;
	trialsConverted: number;
}

export async function conversionReport(db: Db, opts: { days?: number; now?: number } = {}): Promise<ConversionReport> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	const days = opts.days ?? 30;
	const since = t - days * DAY;
	const r = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM mbr_members WHERE created_at >= ?1) AS joined,
				(SELECT COUNT(*) FROM mbr_members m WHERE m.created_at >= ?1 AND EXISTS (
					SELECT 1 FROM mbr_subscriptions s JOIN mbr_subscription_terms st ON st.subscription_id = s.id
					WHERE s.member_id = m.id AND st.mrr > 0)) AS converted,
				(SELECT COUNT(*) FROM mbr_subscription_terms WHERE trial_end >= ?1 AND trial_end <= ?2) AS trials_ended,
				(SELECT COUNT(*) FROM mbr_subscription_terms WHERE trial_end >= ?1 AND trial_end <= ?2 AND mrr > 0) AS trials_converted`,
		)
		.bind(since, t)
		.first<{ joined: number; converted: number; trials_ended: number; trials_converted: number }>();
	return {
		days,
		joined: Number(r?.joined ?? 0),
		convertedToPaid: Number(r?.converted ?? 0),
		trialsEnded: Number(r?.trials_ended ?? 0),
		trialsConverted: Number(r?.trials_converted ?? 0),
	};
}
