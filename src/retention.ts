/**
 * The cancel flow: ask why, maybe make an offer, then cancel or keep.
 *
 * Staff set the reasons in the admin, each with an optional save offer:
 * a coupon on the next invoices, a pause of N months, or a switch to another
 * price (e.g. annual, or a cheaper plan). Every attempt is recorded with its
 * outcome, so the admin can show why people leave and how many were kept.
 */
import { type Db, ensureSchema } from "./db.ts";
import type { Billing } from "./stripe.ts";

export type SaveOffer = { type: "coupon"; code: string; text?: string } | { type: "pause"; months: number; text?: string } | { type: "switch"; lookupKey: string; text?: string };

export interface CancelReason {
	id: string;
	label: string;
	offer: SaveOffer | null;
}

export interface CancelFlow {
	reasons: CancelReason[];
	/** Show a free-text box for comments */
	askComment: boolean;
}

export const DEFAULT_CANCEL_FLOW: CancelFlow = {
	askComment: true,
	reasons: [
		{ id: "too_expensive", label: "It costs too much", offer: null },
		{ id: "not_using", label: "I'm not using it enough", offer: null },
		{ id: "temporary", label: "I need a break", offer: { type: "pause", months: 1 } },
		{ id: "missing", label: "It's missing something I need", offer: null },
		{ id: "alternative", label: "I found something else", offer: null },
		{ id: "other", label: "Something else", offer: null },
	],
};

const KEY = "cancel_flow";

export async function getCancelFlow(db: Db): Promise<CancelFlow> {
	await ensureSchema(db);
	const r = await db.prepare(`SELECT value FROM mbr_settings WHERE key = ?`).bind(KEY).first<{ value: string }>();
	if (!r) return DEFAULT_CANCEL_FLOW;
	try {
		const v = JSON.parse(r.value) as Partial<CancelFlow>;
		return { askComment: v.askComment ?? true, reasons: Array.isArray(v.reasons) && v.reasons.length ? v.reasons : DEFAULT_CANCEL_FLOW.reasons };
	} catch {
		return DEFAULT_CANCEL_FLOW;
	}
}

export async function saveCancelFlow(db: Db, flow: CancelFlow): Promise<CancelFlow> {
	await ensureSchema(db);
	const reasons = flow.reasons
		.map((r) => ({ id: r.id.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40), label: r.label.trim().slice(0, 120), offer: cleanOffer(r.offer) }))
		.filter((r) => r.id && r.label);
	const value: CancelFlow = { askComment: flow.askComment, reasons: reasons.length ? reasons : DEFAULT_CANCEL_FLOW.reasons };
	await db.prepare(`INSERT INTO mbr_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(KEY, JSON.stringify(value)).run();
	return value;
}

function cleanOffer(o: SaveOffer | null | undefined): SaveOffer | null {
	if (!o) return null;
	const text = o.text?.trim().slice(0, 300) || undefined;
	if (o.type === "coupon" && o.code?.trim()) return { type: "coupon", code: o.code.trim().toUpperCase(), ...(text && { text }) };
	if (o.type === "pause" && o.months >= 1) return { type: "pause", months: Math.min(12, Math.floor(o.months)), ...(text && { text }) };
	if (o.type === "switch" && o.lookupKey?.trim()) return { type: "switch", lookupKey: o.lookupKey.trim(), ...(text && { text }) };
	return null;
}

/** Text shown to the member for an offer, unless staff wrote their own. */
export function describeOffer(o: SaveOffer): string {
	if (o.text) return o.text;
	if (o.type === "coupon") return `Stay, and we'll apply the discount ${o.code} to your subscription.`;
	if (o.type === "pause") return `Take a break instead: pause billing for ${o.months} month${o.months === 1 ? "" : "s"}, then pick up where you left off.`;
	return "Switch to another option instead of canceling.";
}

/** The offer for a reason, if it can actually be made right now (coupon active, price on sale). */
export async function offerFor(db: Db, reasonId: string, now = Date.now()): Promise<SaveOffer | null> {
	const reason = (await getCancelFlow(db)).reasons.find((r) => r.id === reasonId);
	const o = reason?.offer;
	if (!o) return null;
	if (o.type === "coupon") {
		const ok = await db.prepare(`SELECT 1 FROM mbr_coupons WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?)`).bind(o.code, now).first();
		return ok ? o : null;
	}
	if (o.type === "switch") {
		const ok = await db.prepare(`SELECT 1 FROM mbr_prices WHERE lookup_key = ? AND active = 1 AND kind = 'recurring'`).bind(o.lookupKey).first();
		return ok ? o : null;
	}
	return o;
}

export type CancelOutcome = "canceled" | "saved_coupon" | "paused" | "switched" | "kept";

export type CancelStepResult =
	| { ok: true; outcome: CancelOutcome }
	| { ok: true; outcome: "offer"; offer: SaveOffer; text: string }
	| { ok: false; reason: string };

/**
 * One step of the flow. First call with `reason` (and `comment`): if the reason
 * has an offer, it comes back as `outcome: "offer"` and nothing changes yet.
 * Then call again with `decision: "accept"` (apply the offer) or `"decline"`
 * (cancel at period end). Without an offer, the first call cancels.
 */
export async function cancelStep(
	db: Db,
	billing: Billing,
	input: { memberId: string; reason: string; comment?: string | null; decision?: "accept" | "decline" | "keep"; now?: number },
): Promise<CancelStepResult> {
	await ensureSchema(db);
	const t = input.now ?? Date.now();
	const flow = await getCancelFlow(db);
	if (!flow.reasons.some((r) => r.id === input.reason)) return { ok: false, reason: "unknown_reason" };
	const summary = await billing.summary(input.memberId);
	const sub = summary.subscription;
	if (!sub || sub.cancelAtPeriodEnd || !["active", "trialing", "past_due"].includes(sub.status)) return { ok: false, reason: "no_subscription" };
	const offer = await offerFor(db, input.reason, t);
	const record = (outcome: CancelOutcome) =>
		db
			.prepare(`INSERT INTO mbr_cancellations (id, member_id, subscription_id, reason, comment, offer, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(`can_${crypto.randomUUID()}`, input.memberId, sub.id, input.reason, input.comment?.trim().slice(0, 2000) || null, offer ? JSON.stringify(offer) : null, outcome, t)
			.run();

	if (input.decision === "keep") {
		await record("kept");
		return { ok: true, outcome: "kept" };
	}
	if (offer && !input.decision) return { ok: true, outcome: "offer", offer, text: describeOffer(offer) };
	if (offer && input.decision === "accept") {
		const r =
			offer.type === "coupon"
				? await billing.applyCoupon(input.memberId, offer.code)
				: offer.type === "pause"
					? await billing.pauseSubscription(input.memberId, { months: offer.months })
					: await billing.changePlan(input.memberId, offer.lookupKey);
		if (!r.ok) return { ok: false, reason: r.error ?? r.reason };
		const outcome: CancelOutcome = offer.type === "coupon" ? "saved_coupon" : offer.type === "pause" ? "paused" : "switched";
		await record(outcome);
		return { ok: true, outcome };
	}
	const r = await billing.cancelSubscription(input.memberId, { atPeriodEnd: true });
	if (!r.ok) return { ok: false, reason: r.error ?? r.reason };
	await record("canceled");
	return { ok: true, outcome: "canceled" };
}

export interface CancellationReport {
	days: number;
	total: number;
	byReason: { reason: string; label: string; count: number; saved: number }[];
	outcomes: Record<CancelOutcome, number>;
	comments: { reason: string; comment: string; at: number }[];
}

export async function cancellationReport(db: Db, opts: { days?: number; now?: number } = {}): Promise<CancellationReport> {
	await ensureSchema(db);
	const days = opts.days ?? 90;
	const since = (opts.now ?? Date.now()) - days * 86_400_000;
	const flow = await getCancelFlow(db);
	const { results } = await db
		.prepare(`SELECT reason, outcome, COUNT(*) AS n FROM mbr_cancellations WHERE created_at >= ? GROUP BY reason, outcome`)
		.bind(since)
		.all<{ reason: string; outcome: CancelOutcome; n: number }>();
	const outcomes: Record<CancelOutcome, number> = { canceled: 0, saved_coupon: 0, paused: 0, switched: 0, kept: 0 };
	const by = new Map<string, { count: number; saved: number }>();
	for (const r of results) {
		outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + Number(r.n);
		const e = by.get(r.reason) ?? { count: 0, saved: 0 };
		e.count += Number(r.n);
		if (r.outcome !== "canceled") e.saved += Number(r.n);
		by.set(r.reason, e);
	}
	const { results: comments } = await db
		.prepare(`SELECT reason, comment, created_at FROM mbr_cancellations WHERE created_at >= ? AND comment IS NOT NULL ORDER BY created_at DESC LIMIT 20`)
		.bind(since)
		.all<{ reason: string; comment: string; created_at: number }>();
	return {
		days,
		total: [...by.values()].reduce((a, b) => a + b.count, 0),
		byReason: [...by.entries()].map(([reason, v]) => ({ reason, label: flow.reasons.find((r) => r.id === reason)?.label ?? reason, ...v })).sort((a, b) => b.count - a.count),
		outcomes,
		comments: comments.map((c) => ({ reason: c.reason, comment: c.comment, at: c.created_at })),
	};
}
