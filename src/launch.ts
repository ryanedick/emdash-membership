/**
 * Early access → paid plans. Pure database logic (no Stripe calls), so it can
 * run from a scheduled job.
 *
 * Lifecycle:
 * 1. Early access: buyers get Pro with no end date and a permanent early-member
 *    badge (`mbr_billing.early_member`, which is never cleared).
 * 2. `startPaidLaunch()` (once): every early member with active early access
 *    gets `grace_ends_at = launch + graceDays`.
 * 3. `expireGracePeriods()` (repeatedly): members past their grace end drop to
 *    Free unless they subscribed.
 * 4. `dueNotices()` / `markNoticeSent()`: the launch, reminder and "you're on
 *    Free now" emails, each sent at most once per member.
 */
import { type Db, ensureSchema } from "./db.ts";

export const DEFAULT_PRO_STATUSES = ["active", "trialing", "past_due"] as const;
const DAY = 24 * 60 * 60 * 1000;

function statusList(statuses: readonly string[]) {
	return statuses.map((s) => `'${s.replace(/'/g, "")}'`).join(", ");
}

/**
 * The one entitlement rule: Pro if early access is active (granted, not
 * revoked, grace not over), a subscription is in a Pro status, or a comp
 * grant (see ./grants.ts) covers this moment.
 *
 * A change of plan is also appended to `mbr_plan_changes` in the same
 * transaction, so other systems (e.g. a newsletter tagging Pro readers) can
 * follow plan changes with `pendingPlanChanges()` / `ackPlanChanges()`.
 */
export async function recomputePlan(
	db: Db,
	memberId: string,
	opts: { proStatuses?: readonly string[]; now?: number } = {},
): Promise<"free" | "pro"> {
	const t = opts.now ?? Date.now();
	const row = await db
		.prepare(
			`SELECT
				EXISTS (SELECT 1 FROM mbr_billing b WHERE b.member_id = ?1 AND b.early_access_at IS NOT NULL
					AND b.early_access_revoked_at IS NULL AND (b.grace_ends_at IS NULL OR b.grace_ends_at > ?2)) AS early,
				EXISTS (SELECT 1 FROM mbr_subscriptions s WHERE s.member_id = ?1
					AND s.status IN (${statusList(opts.proStatuses ?? DEFAULT_PRO_STATUSES)})) AS subscribed,
				EXISTS (SELECT 1 FROM mbr_grants g WHERE g.member_id = ?1 AND g.revoked_at IS NULL
					AND g.ends_at > ?2) AS granted`,
		)
		.bind(memberId, t)
		.first<{ early: number; subscribed: number; granted: number }>();
	const plan = row?.early || row?.subscribed || row?.granted ? "pro" : "free";
	await db.batch([
		db
			.prepare(
				`INSERT INTO mbr_plan_changes (member_id, email, plan, changed_at)
				 SELECT id, email, ?1, ?2 FROM mbr_members WHERE id = ?3 AND plan <> ?1`,
			)
			.bind(plan, t, memberId),
		db.prepare(`UPDATE mbr_members SET plan = ? WHERE id = ?`).bind(plan, memberId),
	]);
	return plan;
}

export interface PlanChange {
	seq: number;
	memberId: string;
	email: string;
	plan: "free" | "pro";
	changedAt: number;
}

/**
 * Plan changes not yet acknowledged, oldest first. Meant for one consumer
 * (e.g. a scheduled job): process them, then `ackPlanChanges(lastSeq)`.
 * The first batch after upgrading includes every member who was already Pro.
 */
export async function pendingPlanChanges(db: Db, opts: { limit?: number } = {}): Promise<PlanChange[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT seq, member_id, email, plan, changed_at FROM mbr_plan_changes ORDER BY seq LIMIT ?`)
		.bind(opts.limit ?? 200)
		.all<{ seq: number; member_id: string; email: string; plan: string; changed_at: number }>();
	return results.map((r) => ({
		seq: r.seq,
		memberId: r.member_id,
		email: r.email,
		plan: r.plan === "pro" ? "pro" : "free",
		changedAt: r.changed_at,
	}));
}

/** Drops plan changes up to and including `seq`, once they've been processed. */
export async function ackPlanChanges(db: Db, seq: number): Promise<void> {
	await ensureSchema(db);
	await db.prepare(`DELETE FROM mbr_plan_changes WHERE seq <= ?`).bind(seq).run();
}

export interface LaunchState {
	launchedAt: number | null;
}

export async function paidLaunchState(db: Db): Promise<LaunchState> {
	await ensureSchema(db);
	const row = await db.prepare(`SELECT value FROM mbr_meta WHERE key = 'paid_launch_at'`).first<{ value: string }>();
	return { launchedAt: row ? Number(row.value) : null };
}

/**
 * Starts paid plans: records the launch time (once) and gives every early
 * member with active early access their grace period. Safe to call repeatedly:
 * only the first call starts the launch, and later calls only date anyone who
 * slipped through (e.g. a purchase completing just after launch).
 */
export async function startPaidLaunch(
	db: Db,
	opts: { graceDays: number; now?: number },
): Promise<{ started: boolean; launchedAt: number; graceEndsAt: number; membersDated: number }> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	await db
		.prepare(`INSERT INTO mbr_meta (key, value) VALUES ('paid_launch_at', ?) ON CONFLICT (key) DO NOTHING`)
		.bind(String(t))
		.run();
	const launchedAt = (await paidLaunchState(db)).launchedAt ?? t;
	const graceEndsAt = launchedAt + opts.graceDays * DAY;
	const counted = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM mbr_billing
			 WHERE early_access_at IS NOT NULL AND early_access_revoked_at IS NULL AND grace_ends_at IS NULL`,
		)
		.first<{ n: number }>();
	await db
		.prepare(
			`UPDATE mbr_billing SET grace_ends_at = ?, updated_at = ?
			 WHERE early_access_at IS NOT NULL AND early_access_revoked_at IS NULL AND grace_ends_at IS NULL`,
		)
		.bind(graceEndsAt, t)
		.run();
	return { started: launchedAt === t, launchedAt, graceEndsAt, membersDated: counted?.n ?? 0 };
}

/** Drops members whose grace period has ended to Free (unless they subscribed). */
export async function expireGracePeriods(
	db: Db,
	opts: { proStatuses?: readonly string[]; now?: number } = {},
): Promise<string[]> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	const { results } = await db
		.prepare(
			`SELECT m.id FROM mbr_members m JOIN mbr_billing b ON b.member_id = m.id
			 WHERE m.plan = 'pro' AND b.grace_ends_at IS NOT NULL AND b.grace_ends_at <= ?`,
		)
		.bind(t)
		.all<{ id: string }>();
	const dropped: string[] = [];
	for (const { id } of results) {
		if ((await recomputePlan(db, id, { ...opts, now: t })) === "free") dropped.push(id);
	}
	return dropped;
}

export type NoticeKind = "paid_launch" | "grace_reminder" | "grace_ended";

export interface DueNotice {
	kind: NoticeKind;
	memberId: string;
	email: string;
	graceEndsAt: number;
}

/**
 * Lifecycle emails that are due and not yet sent:
 * - paid_launch: every early member given a grace period
 * - grace_reminder: `reminderDaysBefore` days before the end, if not subscribed
 * - grace_ended: after the end, if they ended up on Free
 */
export async function dueNotices(
	db: Db,
	opts: { reminderDaysBefore?: number; proStatuses?: readonly string[]; now?: number; limit?: number } = {},
): Promise<DueNotice[]> {
	await ensureSchema(db);
	const t = opts.now ?? Date.now();
	const remindAt = (opts.reminderDaysBefore ?? 3) * DAY;
	const limit = opts.limit ?? 50;
	const pro = statusList(opts.proStatuses ?? DEFAULT_PRO_STATUSES);
	const { results } = await db
		.prepare(
			`WITH early AS (
				SELECT m.id, m.email, m.plan, b.grace_ends_at,
					EXISTS (SELECT 1 FROM mbr_subscriptions s WHERE s.member_id = m.id AND s.status IN (${pro})) AS subscribed
				FROM mbr_members m JOIN mbr_billing b ON b.member_id = m.id
				WHERE b.early_member = 1 AND b.grace_ends_at IS NOT NULL AND b.early_access_revoked_at IS NULL
			), due AS (
				SELECT 'paid_launch' AS kind, id, email, grace_ends_at FROM early
				UNION ALL
				SELECT 'grace_reminder', id, email, grace_ends_at FROM early
					WHERE NOT subscribed AND grace_ends_at > ?1 AND grace_ends_at - ?2 <= ?1
				UNION ALL
				SELECT 'grace_ended', id, email, grace_ends_at FROM early
					WHERE NOT subscribed AND plan = 'free' AND grace_ends_at <= ?1
			)
			SELECT d.kind, d.id, d.email, d.grace_ends_at FROM due d
			WHERE NOT EXISTS (SELECT 1 FROM mbr_notices n WHERE n.member_id = d.id AND n.kind = d.kind)
			LIMIT ?3`,
		)
		.bind(t, remindAt, limit)
		.all<{ kind: NoticeKind; id: string; email: string; grace_ends_at: number }>();
	// A member who is past every stage only needs the latest email, not all three.
	const latest = new Map<string, DueNotice>();
	const order: NoticeKind[] = ["paid_launch", "grace_reminder", "grace_ended"];
	for (const r of results) {
		const prev = latest.get(r.id);
		if (!prev || order.indexOf(r.kind) > order.indexOf(prev.kind)) {
			latest.set(r.id, { kind: r.kind, memberId: r.id, email: r.email, graceEndsAt: r.grace_ends_at });
		}
	}
	return [...latest.values()];
}

/**
 * Records a notice as sent, plus the earlier stages it made redundant, so a
 * member who got the "you're on Free now" email never gets the launch email after.
 */
export async function markNoticeSent(db: Db, memberId: string, kind: NoticeKind, now = Date.now()): Promise<void> {
	const order: NoticeKind[] = ["paid_launch", "grace_reminder", "grace_ended"];
	const kinds = order.slice(0, order.indexOf(kind) + 1);
	await db.batch(
		kinds.map((k) =>
			db
				.prepare(`INSERT INTO mbr_notices (member_id, kind, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
				.bind(memberId, k, now),
		),
	);
}

export interface EarlyMember {
	memberId: string;
	email: string;
	plan: "free" | "pro";
	/** When they bought early access: the badge date */
	earlyMemberSince: number | null;
	subscribed: boolean;
	refunded: boolean;
}

/** Everyone with the early-member badge, for exports, segments and thank-yous. */
export async function listEarlyMembers(db: Db, opts: { proStatuses?: readonly string[] } = {}): Promise<EarlyMember[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(
			`SELECT m.id, m.email, m.plan, b.early_access_at, b.early_access_revoked_at,
				EXISTS (SELECT 1 FROM mbr_subscriptions s WHERE s.member_id = m.id
					AND s.status IN (${statusList(opts.proStatuses ?? DEFAULT_PRO_STATUSES)})) AS subscribed
			 FROM mbr_members m JOIN mbr_billing b ON b.member_id = m.id
			 WHERE b.early_member = 1 ORDER BY b.early_access_at`,
		)
		.all<{ id: string; email: string; plan: string; early_access_at: number | null; early_access_revoked_at: number | null; subscribed: number }>();
	return results.map((r) => ({
		memberId: r.id,
		email: r.email,
		plan: r.plan === "pro" ? "pro" : "free",
		earlyMemberSince: r.early_access_at,
		subscribed: !!r.subscribed,
		refunded: !!r.early_access_revoked_at,
	}));
}
