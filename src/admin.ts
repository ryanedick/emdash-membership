/**
 * Read and housekeeping queries for staff tools: member counts, search, one
 * member's full record, signing a member out everywhere and erasing a member.
 * Pure database logic, used by the EmDash admin pages (./plugin) and usable
 * from any other back office.
 */
import { type Db, ensureSchema } from "./db.ts";
import { DEFAULT_PRO_STATUSES } from "./launch.ts";
import type { Member, Plan } from "./memberships.ts";
import { type ProGrant, listGrants } from "./grants.ts";

const DAY = 24 * 60 * 60 * 1000;

function statusList(statuses: readonly string[]) {
	return statuses.map((s) => `'${s.replace(/'/g, "")}'`).join(", ");
}

/** What a recurring price is worth, for the MRR estimate. Keyed by Stripe Price lookup key. */
export interface PlanValue {
	/** Price in the smallest currency unit, e.g. 900 for $9.00 */
	amount: number;
	interval: "month" | "year";
}

export interface MemberStats {
	total: number;
	pro: number;
	free: number;
	/** Members created in the last 30 days */
	new30d: number;
	/** Members who signed in during the last 30 days */
	active30d: number;
	/** Subscriptions in a Pro status (active, trialing, past_due by default) */
	subscriptions: number;
	pastDue: number;
	/** Subscriptions set to cancel at the end of the period */
	canceling: number;
	/** Everyone with the early-member badge, refunded or not */
	earlyMembers: number;
	/** Members on Pro only through comp time right now */
	compOnly: number;
	/** Pro subscriptions by Price lookup key ("" when unknown) */
	byLookupKey: Record<string, number>;
	/** Monthly recurring revenue at list price (no coupons) in the smallest unit, when `planValues` is given */
	mrr: number | null;
	/** Daily new members for the last 30 days, oldest first: [day start ms, count] */
	growth: [number, number][];
}

export async function memberStats(
	db: Db,
	opts: { proStatuses?: readonly string[]; planValues?: Record<string, PlanValue>; now?: number } = {},
): Promise<MemberStats> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	const since = t - 30 * DAY;
	const pro = statusList(opts.proStatuses ?? DEFAULT_PRO_STATUSES);
	const counts = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM mbr_members) AS total,
				(SELECT COUNT(*) FROM mbr_members WHERE plan = 'pro') AS pro,
				(SELECT COUNT(*) FROM mbr_members WHERE created_at >= ?1) AS new30d,
				(SELECT COUNT(*) FROM mbr_members WHERE last_login_at >= ?1) AS active30d,
				(SELECT COUNT(*) FROM mbr_subscriptions WHERE status IN (${pro})) AS subscriptions,
				(SELECT COUNT(*) FROM mbr_subscriptions WHERE status = 'past_due') AS pastDue,
				(SELECT COUNT(*) FROM mbr_subscriptions WHERE status IN (${pro}) AND cancel_at_period_end = 1) AS canceling,
				(SELECT COUNT(*) FROM mbr_billing WHERE early_member = 1) AS earlyMembers,
				(SELECT COUNT(*) FROM mbr_members m WHERE m.plan = 'pro'
					AND EXISTS (SELECT 1 FROM mbr_grants g WHERE g.member_id = m.id AND g.revoked_at IS NULL AND g.ends_at > ?2)
					AND NOT EXISTS (SELECT 1 FROM mbr_subscriptions s WHERE s.member_id = m.id AND s.status IN (${pro}))
					AND NOT EXISTS (SELECT 1 FROM mbr_billing b WHERE b.member_id = m.id AND b.early_access_at IS NOT NULL
						AND b.early_access_revoked_at IS NULL AND (b.grace_ends_at IS NULL OR b.grace_ends_at > ?2))) AS compOnly`,
		)
		.bind(since, t)
		.first<Record<string, number>>();
	const { results: keys } = await db
		.prepare(`SELECT COALESCE(lookup_key, '') AS k, COUNT(*) AS n FROM mbr_subscriptions WHERE status IN (${pro}) GROUP BY k`)
		.all<{ k: string; n: number }>();
	const byLookupKey = Object.fromEntries(keys.map((r) => [r.k, Number(r.n)]));
	let mrr: number | null = null;
	if (opts.planValues) {
		mrr = 0;
		for (const [k, n] of Object.entries(byLookupKey)) {
			const v = opts.planValues[k];
			if (v) mrr += Math.round((v.interval === "year" ? v.amount / 12 : v.amount) * n);
		}
	}
	const dayStart = (ms: number) => ms - (ms % DAY);
	const { results: days } = await db
		.prepare(`SELECT (created_at - (created_at % ${DAY})) AS d, COUNT(*) AS n FROM mbr_members WHERE created_at >= ? GROUP BY d`)
		.bind(dayStart(since))
		.all<{ d: number; n: number }>();
	const perDay = new Map(days.map((r) => [Number(r.d), Number(r.n)]));
	const growth: [number, number][] = [];
	for (let d = dayStart(since); d <= dayStart(t); d += DAY) growth.push([d, perDay.get(d) ?? 0]);
	const c = (k: string) => Number(counts?.[k] ?? 0);
	return {
		total: c("total"),
		pro: c("pro"),
		free: c("total") - c("pro"),
		new30d: c("new30d"),
		active30d: c("active30d"),
		subscriptions: c("subscriptions"),
		pastDue: c("pastDue"),
		canceling: c("canceling"),
		earlyMembers: c("earlyMembers"),
		compOnly: c("compOnly"),
		byLookupKey,
		mrr,
		growth,
	};
}

export interface MemberListItem extends Member {
	earlyMember: boolean;
	subscriptionStatus: string | null;
}

export interface MemberQuery {
	/** Substring of the email address */
	search?: string;
	plan?: Plan;
	/** Only members with the early-member badge */
	earlyOnly?: boolean;
	limit?: number;
	offset?: number;
}

export async function listMembers(db: Db, q: MemberQuery = {}): Promise<{ items: MemberListItem[]; total: number }> {
	await ensureSchema(db);
	const where: string[] = [];
	const args: unknown[] = [];
	const search = q.search?.trim().toLowerCase();
	if (search) {
		where.push(`m.email LIKE ? ESCAPE '\\'`);
		args.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
	}
	if (q.plan === "pro" || q.plan === "free") {
		where.push(`m.plan = ?`);
		args.push(q.plan);
	}
	if (q.earlyOnly) where.push(`b.early_member = 1`);
	const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const from = `FROM mbr_members m LEFT JOIN mbr_billing b ON b.member_id = m.id ${w}`;
	const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
	const total = await db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...args).first<{ n: number }>();
	const { results } = await db
		.prepare(
			`SELECT m.id, m.email, m.plan, m.created_at, m.last_login_at, COALESCE(b.early_member, 0) AS early_member,
				(SELECT s.status FROM mbr_subscriptions s WHERE s.member_id = m.id ORDER BY s.updated_at DESC LIMIT 1) AS sub_status
			 ${from} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
		)
		.bind(...args, limit, Math.max(q.offset ?? 0, 0))
		.all<{ id: string; email: string; plan: string; created_at: number; last_login_at: number | null; early_member: number; sub_status: string | null }>();
	return {
		total: Number(total?.n ?? 0),
		items: results.map((r) => ({
			id: r.id,
			email: r.email,
			plan: r.plan === "pro" ? "pro" : "free",
			createdAt: r.created_at,
			lastLoginAt: r.last_login_at,
			earlyMember: !!r.early_member,
			subscriptionStatus: r.sub_status,
		})),
	};
}

export interface MemberDetail {
	member: Member;
	stripeCustomerId: string | null;
	earlyMember: boolean;
	earlyAccessAt: number | null;
	earlyAccessRevokedAt: number | null;
	graceEndsAt: number | null;
	/** Set when Stripe reported a dispute or fraud warning */
	riskFlag: string | null;
	subscriptions: {
		id: string;
		status: string;
		lookupKey: string | null;
		currentPeriodEnd: number | null;
		cancelAtPeriodEnd: boolean;
		updatedAt: number;
	}[];
	grants: ProGrant[];
	activeSessions: number;
}

export async function getMemberDetail(db: Db, memberId: string, now = Date.now()): Promise<MemberDetail | null> {
	await ensureSchema(db);
	const m = await db
		.prepare(
			`SELECT m.*, b.stripe_customer_id, b.early_member, b.early_access_at, b.early_access_revoked_at, b.grace_ends_at, b.risk_flag
			 FROM mbr_members m LEFT JOIN mbr_billing b ON b.member_id = m.id WHERE m.id = ?`,
		)
		.bind(memberId)
		.first<{
			id: string;
			email: string;
			plan: string;
			created_at: number;
			last_login_at: number | null;
			stripe_customer_id: string | null;
			early_member: number | null;
			early_access_at: number | null;
			early_access_revoked_at: number | null;
			grace_ends_at: number | null;
			risk_flag: string | null;
		}>();
	if (!m) return null;
	const [{ results: subs }, grants, sessions] = await Promise.all([
		db
			.prepare(`SELECT * FROM mbr_subscriptions WHERE member_id = ? ORDER BY updated_at DESC`)
			.bind(memberId)
			.all<{ id: string; status: string; lookup_key: string | null; current_period_end: number | null; cancel_at_period_end: number; updated_at: number }>(),
		listGrants(db, memberId),
		db.prepare(`SELECT COUNT(*) AS n FROM mbr_sessions WHERE member_id = ? AND expires_at > ?`).bind(memberId, now).first<{ n: number }>(),
	]);
	return {
		member: { id: m.id, email: m.email, plan: m.plan === "pro" ? "pro" : "free", createdAt: m.created_at, lastLoginAt: m.last_login_at },
		stripeCustomerId: m.stripe_customer_id,
		earlyMember: !!m.early_member,
		earlyAccessAt: m.early_access_at,
		earlyAccessRevokedAt: m.early_access_revoked_at,
		graceEndsAt: m.grace_ends_at,
		riskFlag: m.risk_flag,
		subscriptions: subs.map((s) => ({
			id: s.id,
			status: s.status,
			lookupKey: s.lookup_key,
			currentPeriodEnd: s.current_period_end,
			cancelAtPeriodEnd: !!s.cancel_at_period_end,
			updatedAt: s.updated_at,
		})),
		grants,
		activeSessions: Number(sessions?.n ?? 0),
	};
}

/** Ends every session the member has, on every device. Returns how many were ended. */
export async function signOutEverywhere(db: Db, memberId: string): Promise<number> {
	await ensureSchema(db);
	const r = (await db.prepare(`DELETE FROM mbr_sessions WHERE member_id = ? RETURNING token_hash`).bind(memberId).all()).results;
	return r.length;
}

export type DeleteMemberResult = { ok: true; email: string } | { ok: false; reason: "not_found" | "has_subscription" };

/**
 * Erases a member and everything stored about them here (sessions, billing,
 * grants, notices, sign-in links, plan-change log; a Pro member leaves one final
 * "free" entry so plan followers can remove their Pro status). Refuses while a
 * subscription is still live: cancel it in Stripe first, or the next
 * webhook has no member to update. Their Stripe customer is not touched.
 */
export async function deleteMember(db: Db, memberId: string, opts: { proStatuses?: readonly string[] } = {}): Promise<DeleteMemberResult> {
	await ensureSchema(db);
	const m = await db.prepare(`SELECT email, plan FROM mbr_members WHERE id = ?`).bind(memberId).first<{ email: string; plan: string }>();
	if (!m) return { ok: false, reason: "not_found" };
	const live = await db
		.prepare(`SELECT 1 FROM mbr_subscriptions WHERE member_id = ? AND status IN (${statusList(opts.proStatuses ?? DEFAULT_PRO_STATUSES)}) LIMIT 1`)
		.bind(memberId)
		.first();
	if (live) return { ok: false, reason: "has_subscription" };
	await db.batch([
		db.prepare(`DELETE FROM mbr_sessions WHERE member_id = ?`).bind(memberId),
		db.prepare(`DELETE FROM mbr_grants WHERE member_id = ?`).bind(memberId),
		db.prepare(`DELETE FROM mbr_notices WHERE member_id = ?`).bind(memberId),
		db.prepare(`DELETE FROM mbr_checkouts WHERE member_id = ?`).bind(memberId),
		db.prepare(`DELETE FROM mbr_subscriptions WHERE member_id = ?`).bind(memberId),
		db.prepare(`DELETE FROM mbr_billing WHERE member_id = ?`).bind(memberId),
		db.prepare(`DELETE FROM mbr_plan_changes WHERE member_id = ?`).bind(memberId),
		// A Pro member leaves as a final "free" change, so followers (e.g. a newsletter's Pro tag) catch up.
		...(m.plan === "pro"
			? [db.prepare(`INSERT INTO mbr_plan_changes (member_id, email, plan, changed_at) VALUES (?, ?, 'free', ?)`).bind(memberId, m.email, Date.now())]
			: []),
		db.prepare(`DELETE FROM mbr_login_tokens WHERE email = ?`).bind(m.email),
		db.prepare(`DELETE FROM mbr_members WHERE id = ?`).bind(memberId),
	]);
	return { ok: true, email: m.email };
}
